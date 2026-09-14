// content/renderer.js
// Classic-script module. Exports: ns.renderer
//
// Writes a translation into ONE TEXT NODE by assigning node.nodeValue.
// Nothing else is ever touched: no child node is added or removed, no
// attribute/class/style changes (apart from a bookkeeping counter attribute),
// so the page keeps its structure and layout. The previous version assigned
// element.textContent, which deletes every descendant of that element — on a
// <body>/<div> wrapper that is how the whole page got wiped.
(function () {
  var ns = globalThis.__PLAMO__;
  var log = ns.logger.log;

  var TEXT_NODE = 3;
  var FLAG_ATTR = 'data-plamo-t'; // per-element counter of translated text nodes

  // Text node -> { original, parent }. The registry is what makes "restore the
  // original text" work without a data-* attribute on every text node, and it
  // also survives a page that later removes the node from the DOM.
  var applied = new Map();
  var parentCount = new Map(); // element -> how many of its text nodes we changed

  function leadingWhitespace(text) {
    var m = /^\s+/.exec(String(text == null ? '' : text));
    return m ? m[0] : '';
  }

  function trailingWhitespace(text) {
    var m = /\s+$/.exec(String(text == null ? '' : text));
    return m ? m[0] : '';
  }

  // Models sometimes wrap the answer in a code fence or in quotes; internal
  // whitespace is collapsed because HTML renders runs of it as one space.
  var QUOTE_PAIRS = [['"', '"'], ["'", "'"], ['“', '”'], ['‘', '’'], ['「', '」'], ['『', '』']];

  // A quote is only removed when the same style opens *and* closes the answer,
  // so a translation that legitimately ends with a quote mark is left alone.
  function stripWrappingQuotes(text) {
    for (var i = 0; i < QUOTE_PAIRS.length; i++) {
      var open = QUOTE_PAIRS[i][0];
      var close = QUOTE_PAIRS[i][1];
      if (text.length > 2 && text.charAt(0) === open && text.charAt(text.length - 1) === close) {
        var inner = text.slice(1, -1).trim();
        if (inner) return inner;
      }
    }
    return text;
  }

  function normalizeTranslation(text) {
    if (text == null) return '';
    var out = String(text).replace(/\r\n?/g, '\n').trim();
    out = out.replace(/^```[a-zA-Z0-9_-]*\s*/, '').replace(/```\s*$/, '').trim();
    out = stripWrappingQuotes(out);
    return out.replace(/\s+/g, ' ').trim();
  }

  function flagParent(parent) {
    if (!parent || !parent.setAttribute) return;
    var n = (parentCount.get(parent) || 0) + 1;
    parentCount.set(parent, n);
    try { parent.setAttribute(FLAG_ATTR, String(n)); }
    catch (e) { /* read-only attribute on a frozen node: harmless */ }
  }

  function unflagParent(parent) {
    if (!parent) return;
    var n = (parentCount.get(parent) || 1) - 1;
    if (n > 0) { parentCount.set(parent, n); try { parent.setAttribute(FLAG_ATTR, String(n)); } catch (e) {} }
    else {
      parentCount.delete(parent);
      try { parent.removeAttribute(FLAG_ATTR); } catch (e) {}
    }
  }

  // node: a Text node. opts.original: the value the segment was built from —
  // when the node holds something else now, the page re-rendered it and writing
  // our translation would overwrite text we never read, so it is refused.
  function applyToTextNode(node, translatedText, opts) {
    opts = opts || {};
    if (!node || node.nodeType !== TEXT_NODE) return { ok: false, reason: 'not-a-text-node' };
    if (!node.parentNode) {
      if (applied.has(node)) applied.delete(node);
      return { ok: false, reason: 'detached' };
    }
    var current = node.nodeValue;
    if (typeof opts.original === 'string' && current !== opts.original) {
      return { ok: false, reason: 'changed-after-extract' };
    }
    var translated = normalizeTranslation(translatedText);
    if (!translated) return { ok: false, reason: 'empty-translation' };
    // The whitespace that separated this node from its siblings is restored
    // around the translation, otherwise inline runs glue together.
    var next = leadingWhitespace(current) + translated + trailingWhitespace(current);
    if (next === current) return { ok: false, reason: 'identical', before: current, after: next };
    try { node.nodeValue = next; }
    catch (e) { return { ok: false, reason: 'write-failed: ' + ((e && e.message) || e) }; }
    if (!applied.has(node)) {
      applied.set(node, { original: (typeof opts.original === 'string') ? opts.original : current, parent: node.parentNode });
      flagParent(node.parentNode);
    }
    return { ok: true, reason: null, before: current, after: next };
  }

  // Segment-level entry point used by content.js: the node, its original value
  // and its surrounding whitespace all come from segment.source.
  function applySegment(seg, translatedText) {
    var src = (seg && seg.source) || {};
    var res = applyToTextNode(src.node, translatedText, { original: src.original });
    res.id = seg && seg.id;
    res.path = src.path || null;
    if (!res.ok) {
      log.debug('renderer: skipped ' + (seg && seg.id) + ' [' + res.reason + '] ' + (src.path || ''));
    }
    return res;
  }

  // Old signature (element, text) is deliberately gone: replacing an element's
  // text is what destroyed the page. This alias only accepts a Text node.
  function applyTranslation(node, translatedText, originalText) {
    return applyToTextNode(node, translatedText, { original: originalText }).ok;
  }

  function restore(node) {
    var record = applied.get(node);
    if (!record) return false;
    if (node && node.nodeType === TEXT_NODE && node.parentNode) node.nodeValue = record.original;
    unflagParent(record.parent);
    applied.delete(node);
    return true;
  }

  // root: only nodes inside this subtree are restored (default: everything we
  // have touched). Nodes the page removed are dropped from the registry.
  function restoreAll(root) {
    var restored = 0;
    var dropped = 0;
    var scope = (root && root !== root.ownerDocument) ? root : null;
    applied.forEach(function (record, node) {
      var parent = (node && node.parentNode) || record.parent;
      if (scope && scope.contains && parent && !scope.contains(parent)) return;
      if (!node || node.nodeType !== TEXT_NODE || !node.parentNode) {
        unflagParent(record.parent);
        applied.delete(node);
        dropped++;
        return;
      }
      node.nodeValue = record.original;
      unflagParent(record.parent);
      applied.delete(node);
      restored++;
    });
    if (dropped) log.debug('renderer: dropped ' + dropped + ' registry entry/ies whose node left the DOM');
    return restored;
  }

  function appliedCount() { return applied.size; }

  // Sample of what was changed, for __plamo.getApplied(): path + both texts, so
  // a wrong-looking render can be traced to one node without opening DevTools
  // on the page source.
  function appliedSample(limit) {
    var out = [];
    var max = limit == null ? 10 : limit;
    applied.forEach(function (record, node) {
      if (out.length >= max) return;
      out.push({
        path: ns.segmenter && ns.segmenter.describePath ? ns.segmenter.describePath(record.parent) : '',
        before: String(record.original == null ? '' : record.original).slice(0, 60),
        after: String(node.nodeValue == null ? '' : node.nodeValue).slice(0, 60)
      });
    });
    return out;
  }

  // Everything we touched that is still in the document (diagnostics only).
  function liveCount() {
    var live = 0;
    applied.forEach(function (record, node) {
      if (node && node.parentNode) live++;
    });
    return live;
  }

  ns.renderer = {
    applySegment: applySegment,
    applyToTextNode: applyToTextNode,
    applyTranslation: applyTranslation, // text-node only; never an element
    restore: restore,
    restoreAll: restoreAll,
    appliedCount: appliedCount,
    liveCount: liveCount,
    appliedSample: appliedSample,
    normalizeTranslation: normalizeTranslation,
    FLAG_ATTR: FLAG_ATTR
  };
})();
