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
        } else {
          out.push({
            block: key,
            container: (seg && seg.container != null) ? String(seg.container) : null,
            segments: [seg],
            tokens: estimateTokens(seg.text)
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
        cur = { segments: [], estimatedTokens: 0, units: 0, blocks: [] };
        batches.push(cur);
      }
      // Only the first batch is capped small: it is the visible part of the
      // page, so shipping it early is what keeps the page feeling fast.
      function capSegments() {
        return batches.length <= 1 ? Math.min(maxSegmentsPerBatch, firstMax) : maxSegmentsPerBatch;
      }
      function addSegment(seg) {
        cur.segments.push(seg);
        cur.estimatedTokens += estimateTokens(seg.text);
      }

      for (var i = 0; i < unitList.length; i++) {
        var unit = unitList[i];
        if (!cur) open();
        if (unit.tokens > maxTokensPerBatch) {
          // Too big for one request even on its own: split the unit itself,
          // whole segments at a time, so a long paragraph still gets translated.
          for (var k = 0; k < unit.segments.length; k++) {
            var seg = unit.segments[k];
            var tok = estimateTokens(seg.text);
            if (cur.segments.length &&
              (cur.segments.length >= capSegments() || cur.estimatedTokens + tok > maxTokensPerBatch)) open();
            addSegment(seg);
          }
          cur.units++;
          if (unit.block) cur.blocks.push(unit.block);
          continue;
        }
        if (cur.segments.length &&
          (cur.segments.length + unit.segments.length > capSegments() ||
            cur.estimatedTokens + unit.tokens > maxTokensPerBatch)) open();
        for (var m = 0; m < unit.segments.length; m++) addSegment(unit.segments[m]);
        cur.units++;
        if (unit.block) cur.blocks.push(unit.block);
      }

      return batches.filter(function (b) { return b.segments.length > 0; });
    }

    // Count-only packing, kept for callers that build segments without any DOM
    // grouping information.
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

    return {
      batch: batch,
      batchUnits: batchUnits,
      units: units,
      estimateTokens: estimateTokens,
      // What this packer was actually built with: the first-batch cap never
      // exceeds the normal one, and callers log these numbers instead of the
      // settings they passed in, so a diagnostic can not disagree with the run.
      caps: function () {
        return {
          maxSegmentsPerBatch: maxSegmentsPerBatch,
          maxEstimatedTokensPerBatch: maxTokensPerBatch,
          firstBatchMaxSegments: Math.min(maxSegmentsPerBatch, firstMax),
          charPerToken: charPerToken
        };
      }
    };
  }

  ns.createBatcher = createBatcher;
})();
