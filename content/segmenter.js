// content/segmenter.js
// Classic-script module. Exports: ns.segmenter
// One segment per TEXT NODE: the unit of translation is the unit that gets
// written back, so no segment ever covers a whole element (that is what used to
// destroy the layout). Surrounding whitespace is kept so inline siblings stay
// separated. English heuristic avoids translating Japanese-only text.
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

  // A text node is written back as-is except that runs of whitespace collapse
  // to one space (HTML renders them that way anyway). The leading/trailing
  // whitespace is remembered so "Hello <b>x</b>" keeps its separating space.
  function normalizeWhitespace(text) {
    return String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  }

  function leadingWhitespace(text) {
    var m = /^\s+/.exec(String(text == null ? '' : text));
    return m ? m[0] : '';
  }

  function trailingWhitespace(text) {
    var m = /\s+$/.exec(String(text == null ? '' : text));
    return m ? m[0] : '';
  }

  // "div.card > p" style path: enough to point at the node a log line is about
  // without dumping page text into the console.
  function describePath(el, limit) {
    var out = [];
    var node = el;
    var max = limit || 3;
    while (node && node.nodeType === 1 && out.length < max) {
      var tag = String(node.tagName || '').toLowerCase();
      if (node.id) tag += '#' + node.id;
      else {
        var cls = (typeof node.className === 'string') ? node.className.trim().split(/\s+/)[0] : '';
        if (cls) tag += '.' + cls;
      }
      out.unshift(tag);
      node = node.parentNode;
    }
    return out.join(' > ');
  }

  function viewportPriority(el) {
    if (!el.getBoundingClientRect) return 3;
    var r = el.getBoundingClientRect();
    if (r.top < window.innerHeight && r.bottom > 0) return 1;
    var d = Math.min(Math.abs(r.top - window.innerHeight), Math.abs(r.bottom));
    if (d < 400) return 2;
    return 3;
  }

  // --- structural grouping ----------------------------------------------------
  // Element -> id, only for the current build: cleared at the start of every
  // buildSegments() run, so ids stay small and never leak between runs.
  var elementIds = new Map();
  var BLOCK_TAGS = new Set((ns.constants && ns.constants.BLOCK_TAGS) || []);

  function elementId(el) {
    var n = elementIds.get(el);
    if (n == null) { n = elementIds.size + 1; elementIds.set(el, n); }
    return n;
  }

  // The "paragraph" a text node belongs to: climb to the nearest block-level
  // ancestor. Inline wrappers (<a>, <strong>, <span>) are climbed through, so
  // every fragment of one <p> gets the same id and therefore goes into the same
  // request — a sentence cut in half by a link is not translated twice apart.
  function blockOf(parent) {
    var el = parent;
    var guard = 0;
    while (el && el.nodeType === 1 && guard++ < 64) {
      if (BLOCK_TAGS.has(String(el.tagName || '').toUpperCase())) return el;
      var up = el.parentNode;
      if (!up || up.nodeType !== 1) return el; // nothing above: this is the top
      el = up;
    }
    return el;
  }

  // opts.nodes lets a caller pass pre-collected text nodes; opts.elements is
  // accepted (and ignored) so an old call site does not silently re-translate
  // the whole page through the element path.
  function buildSegments(root, opts) {
    opts = opts || {};
    if (opts.elements && !opts.nodes) {
      log.warn('segmenter: element-based segments are not supported any more ' +
        '(they replace whole subtrees and break the layout); collecting text nodes instead');
    }
    elementIds.clear();
    var nodes = opts.nodes || ns.extractor.extractTextNodes(root, opts.extract);
    var segments = [];
    var skipped = { empty: 0, language: 0, detached: 0 };
    var id = 0;
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      if (!node || node.nodeType !== 3) continue;
      if (!node.parentNode) { skipped.detached++; continue; }
      var raw = node.nodeValue;
      var text = normalizeWhitespace(raw);
      if (!text) { skipped.empty++; continue; }
      if (!opts.includeNonEnglish && !isLikelyEnglish(text)) { skipped.language++; continue; }
      var parent = node.parentNode;
      var block = blockOf(parent);
      var container = (block.parentNode && block.parentNode.nodeType === 1) ? block.parentNode : block;
      segments.push({
        id: 'seg-' + (id++),
        text: text,
        estimatedTokens: estimateTokens(text),
        viewport: viewportPriority(parent),
        // Grouping keys for the request packer (translation/batcher.js): segments
        // with the same block never get split across requests, and consecutive
        // segments of the same container (a menu, a list) fill one request.
        block: 'b' + elementId(block),
        container: 'c' + elementId(container),
        // Everything the renderer needs to write this translation back into the
        // same text node (and to undo it later). Never crosses the wire.
        source: {
          node: node,
          parent: parent,
          parentTag: parent.tagName || '',
          path: describePath(parent),
          original: raw,
          leading: leadingWhitespace(raw),
          trailing: trailingWhitespace(raw)
        }
      });
    }
    log.debug('segmenter: built ' + segments.length + ' segment(s) from ' + nodes.length +
      ' text node(s) in ' + countKeys(segments, 'block') + ' block(s) skipped ' + JSON.stringify(skipped));
    return segments;
  }

  function countKeys(segments, key) {
    var seen = new Set();
    segments.forEach(function (s) { if (s[key]) seen.add(s[key]); });
    return seen.size;
  }

  // Viewport band first, document order inside a band (Array#sort is stable, so
  // the order the extractor walked the tree is preserved).
  function sortSegmentsByViewport(segments) {
    return segments.slice().sort(function (a, b) {
      return (a.viewport || 0) - (b.viewport || 0);
    });
  }

  ns.segmenter = {
    buildSegments: buildSegments,
    sortSegmentsByViewport: sortSegmentsByViewport,
    isLikelyEnglish: isLikelyEnglish,
    estimateTokens: estimateTokens,
    normalizeWhitespace: normalizeWhitespace,
    leadingWhitespace: leadingWhitespace,
    trailingWhitespace: trailingWhitespace,
    describePath: describePath
  };
})();
