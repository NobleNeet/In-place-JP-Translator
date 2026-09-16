// translation/batcher.js
// Classic-script module. Export: ns.createBatcher
// Packs segments into batches, where a batch is now ONE API request: soft
// bounds are the segment count and the estimated tokens, and a segment larger
// than the token cap starts its own batch.
//
// Packing is structural, not just sequential: consecutive segments that belong
// to the same block (the fragments of one <p> that inline <a>/<strong> tags cut
// apart) form a unit that is never split across two requests, and consecutive
// units of the same container (the items of a menu or a list) are filled into
// one request together — that is how a wall of short menu items ends up as one
// request instead of one request per item.
//
// The segment cap is measured in slots, not in segments: a segment of at most
// `shortSegmentTokens` estimated tokens (a menu item, a nav label, a heading)
// costs less than one slot, so a batch of nothing but short segments may carry
// `maxShortSegmentsPerBatch` of them while a batch of paragraphs still stops
// after `maxSegmentsPerBatch`. The token cap still bounds every request, which
// is what keeps the per-request timeout math unchanged. Pass
// maxShortSegmentsPerBatch <= maxSegmentsPerBatch to turn the discount off.
(function () {
  var ns = globalThis.__PLAMO__;
  var BATCH_SETTINGS = ns.constants.BATCH_SETTINGS;

  function createBatcher(opts) {
    var maxSegmentsPerBatch = opts && opts.maxSegmentsPerBatch != null
      ? opts.maxSegmentsPerBatch : BATCH_SETTINGS.maxSegmentsPerBatch;
    var maxTokensPerBatch = opts && opts.maxEstimatedTokensPerBatch != null
      ? opts.maxEstimatedTokensPerBatch : BATCH_SETTINGS.maxEstimatedTokensPerBatch;
    var charPerToken = opts && opts.charPerToken != null
      ? opts.charPerToken : BATCH_SETTINGS.charPerToken;
    var firstMax = opts && opts.firstBatchMaxSegments != null
      ? opts.firstBatchMaxSegments : (BATCH_SETTINGS.firstBatchMaxSegments == null
        ? maxSegmentsPerBatch : BATCH_SETTINGS.firstBatchMaxSegments);
    var shortTokens = opts && opts.shortSegmentTokens != null
      ? opts.shortSegmentTokens : BATCH_SETTINGS.shortSegmentTokens;
    var maxShort = opts && opts.maxShortSegmentsPerBatch != null
      ? opts.maxShortSegmentsPerBatch : BATCH_SETTINGS.maxShortSegmentsPerBatch;
    // One short segment costs `shortSlot` thousandths of one of the
    // maxSegmentsPerBatch slots. Integer thousandths, not floats: 72 x 1/3
    // accumulated in binary floats lands just under 24 and would let one more
    // item in per batch, every batch. Rounding the slot down keeps a
    // short-only batch at exactly the short cap.
    var shortSlot = (shortTokens > 0 && maxShort > maxSegmentsPerBatch)
      ? Math.max(1, Math.floor(1000 * maxSegmentsPerBatch / maxShort)) : 1000;

    function segmentSlots(seg) {
      return (shortSlot < 1000 && estimateTokens(seg ? seg.text : '') <= shortTokens)
        ? shortSlot : 1000;
    }

    function estimateTokens(text) {
      var len = String(text || '').length;
      var cjk = (text.match(/[\u3400-\u9fff\uf900-\uffff]/g) || []).length;
      var nonCjk = len - cjk;
      return Math.ceil(cjk + nonCjk / charPerToken);
    }

    // Maximal runs of consecutive segments that share segment.block. Segments
    // without block info (a caller that built them itself) each become their own
    // unit, which is exactly the old count-only behaviour.
    function units(segments) {
      var out = [];
      var list = segments || [];
      for (var i = 0; i < list.length; i++) {
        var seg = list[i];
        var key = (seg && seg.block != null) ? String(seg.block) : null;
        var last = out.length ? out[out.length - 1] : null;
        if (last && key != null && last.block === key) {
          last.segments.push(seg);
          last.tokens += estimateTokens(seg.text);
          last.slots += segmentSlots(seg);
        } else {
          out.push({
            block: key,
            container: (seg && seg.container != null) ? String(seg.container) : null,
            segments: [seg],
            tokens: estimateTokens(seg.text),
            slots: segmentSlots(seg)
          });
        }
      }
      return out;
    }

    function batchUnits(segments) {
      var unitList = units(segments);
      var batches = [];
      var cur = null;

      function open() {
        cur = { segments: [], estimatedTokens: 0, units: 0, blocks: [], slots: 0 };
        batches.push(cur);
      }
      // Caps in slot thousandths, so the comparison stays exact. Only the
      // first batch is capped small: it is the visible part of the page, so
      // shipping it early is what keeps the page feeling fast. The first cap
      // is discounted like every other one: a first batch of nothing but short
      // items is many lines but little decoding, which is still a fast answer.
      function capSlots() {
        return (batches.length <= 1 ? Math.min(maxSegmentsPerBatch, firstMax) : maxSegmentsPerBatch) * 1000;
      }
      function addSegment(seg) {
        cur.segments.push(seg);
        cur.estimatedTokens += estimateTokens(seg.text);
        cur.slots += segmentSlots(seg);
      }

      for (var i = 0; i < unitList.length; i++) {
        var unit = unitList[i];
        if (!cur) open();
        // Only the token cap cuts a unit: a block of many short segments is
        // still one request of short lines the model digests happily, while a
        // unit whose *tokens* exceed the cap physically cannot answer inside
        // one request. A unit merely over a count cap (the first batch's
        // smaller one, or an unusually chatty <p>) is carried whole.
        if (unit.tokens > maxTokensPerBatch) {
          // Too big for one request even on its own: split the unit itself,
          // whole segments at a time, so a long paragraph still gets translated.
          for (var k = 0; k < unit.segments.length; k++) {
            var seg = unit.segments[k];
            var tok = estimateTokens(seg.text);
            if (cur.segments.length &&
              (cur.slots >= capSlots() || cur.estimatedTokens + tok > maxTokensPerBatch)) open();
            addSegment(seg);
          }
          cur.units++;
          if (unit.block) cur.blocks.push(unit.block);
          continue;
        }
        if (cur.segments.length &&
          (cur.slots + unit.slots > capSlots() ||
            cur.estimatedTokens + unit.tokens > maxTokensPerBatch)) open();
        for (var m = 0; m < unit.segments.length; m++) addSegment(unit.segments[m]);
        cur.units++;
        if (unit.block) cur.blocks.push(unit.block);
      }

      return batches.filter(function (b) { return b.segments.length > 0; });
    }

    // Count-only packing — and count here really means segments, slots and the
    // short-segment discount do not apply. Kept for callers that build segments
    // without any DOM grouping information; the wire path is batchUnits().
    function batch(segments) {
      var batches = [];
      var i = 0;
      while (i < segments.length) {
        var seg = segments[i];
        if (estimateTokens(seg.text) > maxTokensPerBatch) {
          batches.push({ segments: [seg], estimatedTokens: estimateTokens(seg.text) });
          i++;
          continue;
        }
        var curSegs = [seg];
        var curTok = estimateTokens(seg.text);
        var j = i + 1;
        while (j < segments.length && curSegs.length < maxSegmentsPerBatch && curTok + estimateTokens(segments[j].text) <= maxTokensPerBatch) {
          curTok += estimateTokens(segments[j].text);
          curSegs.push(segments[j]);
          j++;
        }
        batches.push({ segments: curSegs, estimatedTokens: curTok });
        i = j;
      }
      return batches;
    }

    // One request died in transport, but its segments still have to be sent: cut
    // a batch into requests of at most maxSegments each. Tokens are re-estimated
    // per part, so the smaller requests also get the shorter timeout they
    // deserve, and the block/container keys are counted for the log line only.
    function split(batchToSplit, maxSegments) {
      var per = (typeof maxSegments === 'number' && maxSegments > 0) ? maxSegments : maxSegmentsPerBatch;
      var segs = (batchToSplit && batchToSplit.segments) || [];
      var parts = [];
      var i;
      for (i = 0; i < segs.length; i += per) {
        var chunk = segs.slice(i, i + per);
        var tokens = 0;
        var keys = {};
        var units = 0;
        chunk.forEach(function (seg) {
          tokens += estimateTokens(seg.text);
          var key = seg.block || seg.container || null;
          if (key && !keys[key]) { keys[key] = 1; units++; }
        });
        parts.push({
          segments: chunk,
          estimatedTokens: tokens,
          units: units || chunk.length,
          // A part of a broken batch is not a first batch.
          first: false
        });
      }
      return parts;
    }

    return {
      batch: batch,
      batchUnits: batchUnits,
      units: units,
      split: split,
      estimateTokens: estimateTokens,
      // What this packer was actually built with: the first-batch cap never
      // exceeds the normal one, and callers log these numbers instead of the
      // settings they passed in, so a diagnostic can not disagree with the run.
      caps: function () {
        return {
          maxSegmentsPerBatch: maxSegmentsPerBatch,
          maxEstimatedTokensPerBatch: maxTokensPerBatch,
          firstBatchMaxSegments: Math.min(maxSegmentsPerBatch, firstMax),
          charPerToken: charPerToken,
          // The short-segment discount as it was actually built: cost 1 means
          // the discount is off, otherwise short segments cost this many slots
          // and a short-only batch holds up to maxShortSegmentsPerBatch.
          shortSegmentTokens: shortTokens,
          maxShortSegmentsPerBatch: shortSlot < 1000 ? maxShort : maxSegmentsPerBatch,
          shortSegmentCost: shortSlot / 1000
        };
      }
    };
  }

  ns.createBatcher = createBatcher;
})();
