// translation/batcher.js
// Classic-script module. Exports: ns.createBatcher
// Groups segments into batches with soft bounds: max count and max estimated
// tokens. A segment larger than the token cap starts its own batch.
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

    function estimateTokens(text) {
      var len = String(text || '').length;
      var cjk = (text.match(/[\u3400-\u9fff\uf900-\uffff]/g) || []).length;
      var nonCjk = len - cjk;
      return Math.ceil(cjk + nonCjk / charPerToken);
    }

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

    return { batch: batch, estimateTokens: estimateTokens };
  }

  ns.createBatcher = createBatcher;
})();
