// content/segmenter.js
// Classic-script module. Exports: ns.segmenter
// One segment per TEXT NODE: the unit of translation is the unit that gets
// written back, so no segment ever covers a whole element (that is what used to
// destroy the layout). Surrounding whitespace is kept so inline siblings stay
// separated. English heuristic avoids translating Japanese-only text.
//
// Two more things happen here, because this is the last place that still holds
// the whole page in hand:
//   * ORDER. Segments come out in the order they should be sent: article body
//     first, then headings, then page chrome, then anything that could not be
//     placed; inside each class whatever is on screen first, and inside that
//     band the text nearest the top of the page first (see content/priority.js
//     for the classes and the position keys).
//   * DEFERRAL. When the extractor hands over its split result, the text nodes
//     the user cannot see are left out of the list entirely — they cost no
//     request until they are displayed. The caller keeps them for its own
//     "did it appear yet?" watch; see content/content.js.
// A paragraph that is ONE huge text node is not cut into pieces: the text node
// is also the unit that gets *written back*, and there is no piece machinery.
// What actually happens with a long paragraph: the extractor keeps it (up to a
// generous EXTRACT.maxTextLength) and the packer gives it a request of its own
// (translation/batcher.js splits oversized units out); a node above even that
// cap is refused by the extractor and reported loudly there, never silently.
// Whatever stayed in English is listed by __plamo.getUntranslated().
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

  function firstNumber() {
    for (var i = 0; i < arguments.length; i++) {
      var v = arguments[i];
      if (typeof v === 'number' && isFinite(v)) return v;
    }
    return 0;
  }

  // Where the viewport sits inside the document, read ONCE per scan rather than
  // once per text node: the page cannot scroll under a synchronous walk, and
  // thousands of property lookups for nothing is what a 5000-node page would pay.
  // `scrollY`/`scrollX` are the modern names, `pageYOffset`/`pageXOffset` their
  // universal aliases, and the <html>/<body> scroll properties the quirks-mode
  // document scrolls instead of the window.
  var runScroll = { y: 0, x: 0 };
  function readScroll() {
    var win = (typeof window !== 'undefined' && window) ? window : null;
    var doc = (typeof document !== 'undefined') ? document : null;
    var html = doc ? doc.documentElement : null;
    var body = doc ? doc.body : null;
    runScroll.y = firstNumber(win && win.scrollY, win && win.pageYOffset,
      html && html.scrollTop, body && body.scrollTop);
    runScroll.x = firstNumber(win && win.scrollX, win && win.pageXOffset,
      html && html.scrollLeft, body && body.scrollLeft);
    return runScroll;
  }

  // One layout read answers both ordering questions about an element, because a
  // second getBoundingClientRect() is another forced reflow on a page that may
  // have thousands of them:
  //   * the viewport band — 1 on screen, 2 within 400px of it, 3 elsewhere;
  //   * where it sits in the DOCUMENT (`y`, and `x` for a tie on one line),
  //     which is what orders text inside one band. The scroll offset is added so
  //     the key survives a scroll between two scans of the same page.
  // No rectangle at all (a node out of the layout, a DOM without one) leaves the
  // position keys off, and the ordering falls back to the order the tree was
  // walked. See content/priority.js.
  function measure(el) {
    var out = { viewport: 3 };
    if (!el.getBoundingClientRect) return out;
    var r = null;
    try { r = el.getBoundingClientRect(); } catch (e) { r = null; }
    if (!r) return out;
    if (typeof r.top === 'number' && typeof r.left === 'number') {
      out.y = Math.round(r.top + runScroll.y);
      out.x = Math.round(r.left + runScroll.x);
    }
    var win = (typeof window !== 'undefined' && window) ? window : null;
    var vh = (win && typeof win.innerHeight === 'number') ? win.innerHeight : 0;
    if (r.top < vh && r.bottom > 0) out.viewport = 1;
    else {
      var d = Math.min(Math.abs(r.top - vh), Math.abs(r.bottom));
      out.viewport = (d < 400) ? 2 : 3;
    }
    return out;
  }

  // --- structural grouping ----------------------------------------------------
  // Element -> id, only for the current build: cleared at the start of every
  // buildSegments() run, so ids stay small and never leak between runs.
  var elementIds = new Map();
  var BLOCK_TAGS = new Set((ns.constants && ns.constants.BLOCK_TAGS) || []);
  // What the last buildSegments*() call collected: counts per region, and how
  // much of the page was held back because the user could not see it.
  var lastStats = null;

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

  // --- what to build from -----------------------------------------------------
  // The caller may hand the nodes over (content.js does, because it also has to
  // remember what it held back), or leave it to the extractor. Both shapes are
  // accepted: the extractor's split { visible, hidden }, and — for old call
  // sites — a flat array of Text nodes in opts.nodes.
  function collectNodes(root, opts) {
    if (opts.nodes) return { visible: opts.nodes, hidden: opts.hiddenNodes || [] };
    var extract = ns.extractor;
    if (extract.collect) {
      var split = extract.collect(root, opts.extract);
      return { visible: split.visible || [], hidden: split.hidden || [] };
    }
    return { visible: extract.extractTextNodes(root, opts.extract), hidden: [] };
  }

  // Hidden text is held back unless somebody said otherwise. The default lives
  // in constants (PRIORITY_SETTINGS.deferHidden); settings.priority.deferHidden
  // reaches here as an option, because this module never reads chrome.storage.
  function deferHiddenByDefault() {
    var P = (ns.constants && ns.constants.PRIORITY_SETTINGS) || {};
    return P.deferHidden !== false;
  }

  // A segment with no region at all and no priority module to ask: last, but
  // still behind nothing that has a region, so viewport ordering survives.
  var NO_PRIORITY = 99;

  // -> { segments, deferred, roles, stats }
  //   segments: what a run sends now, still in document order (sort it to pack);
  //   deferred: the Text nodes that were not visible and were not sent at all.
  //             The caller owns them from here — see the reveal watch in
  //             content.js, which translates them the moment they are displayed.
  // A segment carries `role` (what region it sits in), `priority` (the index of
  // that region in constants PRIORITY_ROLES) and `hidden` (whether the user
  // could see it when the page was scanned).
  function buildSegmentsResult(root, opts) {
    opts = opts || {};
    if (opts.elements && !opts.nodes) {
      log.warn('segmenter: element-based segments are not supported any more ' +
        '(they replace whole subtrees and break the layout); collecting text nodes instead');
    }
    elementIds.clear();
    readScroll();
    var collected = collectNodes(root, opts);
    var deferHidden = (opts.deferHidden != null) ? !!opts.deferHidden : deferHiddenByDefault();
    var nodes = collected.visible.slice();
    var deferred = [];
    var hiddenSet = new Set();
    collected.hidden.forEach(function (n) {
      if (deferHidden) deferred.push(n);
      else { hiddenSet.add(n); nodes.push(n); } // "translate hidden text now": the old behaviour
    });
    var prio = ns.priority;
    var ctx = prio ? prio.createContext() : null;
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
      // The region is read from the element chain, so the text itself never has
      // to be second-guessed; `text` only feeds the "a long run of words is body
      // text" fallback for pages built out of anonymous <div>s.
      var cls = ctx ? prio.classify(ctx, parent, text) : null;
      var where = measure(parent);
      segments.push({
        id: 'seg-' + (id++),
        text: text,
        estimatedTokens: estimateTokens(text),
        viewport: where.viewport,
        // Document position (px, rounded): what orders text inside one viewport
        // band. Absent when the element had no rectangle to measure.
        y: where.y,
        x: where.x,
        role: cls ? cls.role : '',
        priority: cls ? cls.priority : NO_PRIORITY,
        hidden: hiddenSet.has(node),
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
    lastStats = {
      nodes: nodes.length,
      visibleNodes: collected.visible.length,
      hiddenNodes: collected.hidden.length,
      deferred: deferred.length,
      deferHidden: deferHidden,
      segments: segments.length,
      blocks: countKeys(segments, 'block'),
      roles: prio ? prio.histogram(segments) : null,
      skipped: skipped
    };
    log.debug('segmenter: built ' + segments.length + ' segment(s) from ' + nodes.length +
      ' text node(s) in ' + lastStats.blocks + ' block(s); held back ' + deferred.length +
      ' hidden text node(s) (deferHidden=' + deferHidden + ') skipped ' + JSON.stringify(skipped) +
      (lastStats.roles ? ' roles ' + JSON.stringify(lastStats.roles) : ''));
    return { segments: segments, deferred: deferred, roles: lastStats.roles, stats: lastStats };
  }

  // The segments a run would send, in document order — the shape old call sites
  // expect. Use buildSegmentsResult() when the held-back text matters too.
  function buildSegments(root, opts) { return buildSegmentsResult(root, opts).segments; }

  // What the last buildSegments*() call saw, and what it refused to send.
  function lastSegmentStats() { return Object.assign({}, lastStats || {}); }

  function countKeys(segments, key) {
    var seen = new Set();
    segments.forEach(function (s) { if (s[key]) seen.add(s[key]); });
    return seen.size;
  }

  // The order a run sends segments in: article body, then headings, then page
  // chrome, then whatever could not be placed — and inside each of those,
  // whatever is on screen first, then the text nearest the top of the page (see
  // content/priority.js). Text the user could not see goes last, which in
  // practice means it is not in this list at all. `opts.topDown: false` keeps the
  // position keys out of the comparison. Without content/priority.js there are no
  // regions to order by, so the old viewport-only ordering is used and the page
  // gets one warning about it.
  var noPriorityWarned = false;
  function sortSegments(segments, opts) {
    var list = (segments || []).slice();
    var prio = ns.priority;
    if (prio && prio.createCompare) return list.sort(prio.createCompare(opts || {}));
    if (prio && prio.compare) return list.sort(prio.compare);
    if (!noPriorityWarned) {
      noPriorityWarned = true;
      log.warn('segmenter: content/priority.js is not loaded before segmenter.js; ' +
        'falling back to viewport-only ordering (no article/menu priority)');
    }
    return list.sort(function (a, b) { return (a.viewport || 0) - (b.viewport || 0); });
  }

  ns.segmenter = {
    buildSegments: buildSegments,
    buildSegmentsResult: buildSegmentsResult,
    lastStats: lastSegmentStats,
    sortSegments: sortSegments,
    // Old name for the same function: the ordering now puts a class before the
    // viewport band, so call sites that never heard of priorities still work.
    sortSegmentsByViewport: sortSegments,
    isLikelyEnglish: isLikelyEnglish,
    estimateTokens: estimateTokens,
    normalizeWhitespace: normalizeWhitespace,
    leadingWhitespace: leadingWhitespace,
    trailingWhitespace: trailingWhitespace,
    describePath: describePath
  };
})();
