// content/segmenter.js
// Classic-script module. Exports: ns.segmenter
// Splits readable elements into segments. Inlines merged into one segment.
// English heuristic avoids translating Japanese-only text.
(function () {
  var ns = globalThis.__PLAMO__;
  var log = ns.logger.log;

  function estimateTokens(text) {
    var len = String(text).length;
    var cjk = (text.match(/[\u3400-\u9fff\uf900-\uffff]/g) || []).length;
    var nonCjk = len - cjk;
    return Math.ceil(cjk + nonCjk / 4);
  }

  function isLikelyEnglish(text) {
    if (!text) return false;
    var letters = text.replace(/[^A-Za-z]/g, '');
    if (letters.length === 0) return false;
    var ratio = letters.length / text.length;
    return ratio >= 0.3;
  }

  function mergeInlines(el) {
    var texts = [];
    texts.push(el.textContent.trim());
    el.querySelectorAll('a, strong, em, b, i, span, code').forEach(function (child) {
      texts.push(child.textContent.trim());
    });
    var merged = texts.join(' ').replace(/\s+/g, ' ').trim();
    return merged;
  }

  function viewportPriority(el) {
    if (!el.getBoundingClientRect) return 3;
    var r = el.getBoundingClientRect();
    if (r.top < window.innerHeight && r.bottom > 0) return 1;
    var d = Math.min(Math.abs(r.top - window.innerHeight), Math.abs(r.bottom));
    if (d < 400) return 2;
    return 3;
  }

  function buildSegments(root, opts) {
    opts = opts || {};
    var elements = opts.elements || ns.extractor.extractReadableElements(root);
    var segments = [];
    var id = 0;
    elements.forEach(function (el) {
      var text = mergeInlines(el);
      if (!text) return;
      if (!opts.includeNonEnglish && !isLikelyEnglish(text)) return;
      segments.push({
        id: 'seg-' + (id++),
        text: text,
        estimatedTokens: estimateTokens(text),
        viewport: viewportPriority(el),
        source: { element: el, tagName: el.tagName, id: id }
      });
    });
    log.debug('segmenter: built ' + segments.length + ' segments');
    return segments;
  }

  function sortSegmentsByViewport(segments) {
    var vp = function (el) {
      if (!el.getBoundingClientRect) return 0;
      var r = el.getBoundingClientRect();
      if (r.top < window.innerHeight && r.bottom > 0) return 1;
      var d = Math.min(Math.abs(r.top - window.innerHeight), Math.abs(r.bottom));
      if (d < 400) return 2;
      return 3;
    };
    return segments.slice().sort(function (a, b) {
      var av = vp(a.source.element), bv = vp(b.source.element);
      return (av - bv) || (a.source.id - b.source.id);
    });
  }

  ns.segmenter = {
    buildSegments: buildSegments,
    sortSegmentsByViewport: sortSegmentsByViewport,
    isLikelyEnglish: isLikelyEnglish,
    estimateTokens: estimateTokens
  };
})();
