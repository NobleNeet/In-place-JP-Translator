// content/extractor.js
// Classic-script module. Exports: ns.extractor
//
// GRANULARITY: text nodes, never elements.
// An element's text is the concatenation of the text nodes inside it, so
// treating elements as the translation unit has two consequences:
//   1. every ancestor of a text node produces a segment as well, so the same
//      words are translated once per level of nesting (and one of those
//      segments ends up holding the text of the whole page);
//   2. writing such a translation back — element.textContent = ... — deletes
//      every descendant node (links, images, forms, layout containers), which
//      is exactly how the page layout used to collapse.
// The extractor hands over individual Text nodes and the renderer only ever
// assigns node.nodeValue, so the element tree is never modified and the layout
// cannot change.
(function () {
  var ns = globalThis.__PLAMO__;
  var log = ns.logger.log;
  var EXTRACT = (ns.constants && ns.constants.EXTRACT) || {};

  var TEXT_NODE = 3;

  // Subtrees that never hold translatable prose, or where replacing the text
  // would break behaviour: form state, code samples, SVG/MathML layout, <head>.
  var SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'TITLE', 'META', 'LINK',
    'CODE', 'PRE', 'SAMP', 'KBD', 'VAR', 'TEXTAREA', 'INPUT', 'SELECT', 'OPTION',
    'OPTGROUP', 'DATALIST', 'SVG', 'MATH', 'CANVAS', 'PICTURE', 'IFRAME',
    'OBJECT', 'EMBED', 'VIDEO', 'AUDIO', 'SOURCE', 'TRACK', 'BR', 'HR', 'WBR'
  ]);

  // 'notranslate' / translate="no" are the conventions other translators use.
  var SKIP_CLASS = new Set([
    'no-translate', 'no-translate-block', 'no-translate-children', 'notranslate',
    'plamo-ui', 'plamo-translated'
  ]);

  // Letters of any script: drops nodes that are only punctuation/digits, which
  // a translation model answers with an unrelated completion.
  var LETTER_RE;
  try { LETTER_RE = /\p{L}/u; } catch (e) { LETTER_RE = /[A-Za-z\u00C0-\u024F]/; }

  function tagNameOf(el) {
    return el && el.tagName ? String(el.tagName).toUpperCase() : '';
  }

  function classString(el) {
    var cls = (el.className && el.className.baseVal !== undefined) ? el.className.baseVal : el.className;
    return typeof cls === 'string' ? cls : '';
  }

  function getAttr(el, name) {
    if (!el || !el.getAttribute) return null;
    try { return el.getAttribute(name); } catch (e) { return null; }
  }

  // True when this element (and therefore its subtree) must not be touched.
  function shouldIgnore(el) {
    if (!el || el.nodeType !== 1) return false;
    if (SKIP_TAGS.has(tagNameOf(el))) return true;
    if (getAttr(el, 'aria-hidden') === 'true') return true;
    if (getAttr(el, 'data-plamo-skip') != null) return true;
    var translate = getAttr(el, 'translate');
    if (translate && String(translate).toLowerCase() === 'no') return true;
    var editable = getAttr(el, 'contenteditable');
    if (editable && String(editable).toLowerCase() !== 'false') return true;
    if (el.isContentEditable === true) return true; // set from script, no attribute
    var style = getAttr(el, 'style');
    if (style && /display\s*:\s*none|visibility\s*:\s*hidden/.test(style)) return true;
    var cls = classString(el);
    if (cls) {
      var names = cls.split(/\s+/);
      for (var i = 0; i < names.length; i++) {
        if (SKIP_CLASS.has(names[i]) || names[i].indexOf('plamo-') === 0) return true;
      }
    }
    return false;
  }

  // Newlines are load-bearing when CSS preserves them, so those nodes are left
  // exactly as they are rather than whitespace-collapsed.
  function preservesWhitespace(el) {
    var win = (typeof window !== 'undefined' && window.getComputedStyle) ? window
      : (typeof document !== 'undefined' ? document.defaultView : null);
    if (!win || !win.getComputedStyle || !el) return false;
    try {
      var ws = win.getComputedStyle(el).whiteSpace;
      return ws === 'pre' || ws === 'pre-wrap' || ws === 'pre-line' || ws === 'break-spaces';
    } catch (e) {
      return false;
    }
  }

  function bounds(opts) {
    var min = (opts && opts.minTextLength != null) ? opts.minTextLength
      : (EXTRACT.minTextLength != null ? EXTRACT.minTextLength : 3);
    var max = (opts && opts.maxTextLength != null) ? opts.maxTextLength
      : (EXTRACT.maxTextLength != null ? EXTRACT.maxTextLength : 5000);
    return { min: min, max: max };
  }

  function isTranslatableText(node, limits) {
    var value = node.nodeValue;
    if (typeof value !== 'string' || !value) return false;
    var trimmed = value.trim();
    if (trimmed.length < limits.min) return false;
    if (trimmed.length > limits.max) return false;
    if (!LETTER_RE.test(trimmed)) return false;
    if (/[\r\n]/.test(value) && preservesWhitespace(node.parentNode)) return false;
    return true;
  }

  var lastScan = { root: null, elements: 0, skippedSubtrees: 0, textNodes: 0, skippedText: 0, at: 0 };

  // One segment per *direct* text child: that is what keeps one piece of text
  // from becoming one segment per ancestor. A single TreeWalker over elements
  // and text nodes keeps the result in document order, so a paragraph reads in
  // the order it is displayed even when it contains inline <a>/<strong> etc.
  // Elements are only gates (FILTER_SKIP descends into them, FILTER_REJECT
  // drops their whole subtree); the nodes handed back are always Text nodes.
  function extractTextNodes(root, opts) {
    root = root || (typeof document !== 'undefined' ? document : null);
    if (!root) { log.warn('extract: no root to walk'); return []; }
    var nodes = [];
    if (root.nodeType === 1 && shouldIgnore(root)) {
      log.warn('extract: root ' + (tagNameOf(root) || 'node') + ' is on the skip list, nothing to do');
      return nodes;
    }
    var doc = root.ownerDocument || root;
    var limits = bounds(opts);
    var skippedSubtrees = 0;
    var NF = globalThis.NodeFilter;
    lastScan = { root: (root.nodeType === 9) ? 'document' : tagNameOf(root), elements: 0,
      skippedSubtrees: 0, textNodes: 0, skippedText: 0, at: Date.now() };
    var walker;
    try {
      walker = doc.createTreeWalker(root, NF.SHOW_ELEMENT | NF.SHOW_TEXT, {
        acceptNode: function (node) {
          if (node.nodeType === TEXT_NODE) {
            lastScan.textNodes++;
            if (!isTranslatableText(node, limits)) { lastScan.skippedText++; return NF.FILTER_SKIP; }
            return NF.FILTER_ACCEPT;
          }
          if (node !== root && shouldIgnore(node)) { skippedSubtrees++; return NF.FILTER_REJECT; }
          lastScan.elements++;
          return NF.FILTER_SKIP;
        }
      });
    } catch (e) {
      log.error('extract: createTreeWalker failed: ' + ((e && e.message) || e));
      return nodes;
    }
    var node;
    while ((node = walker.nextNode())) nodes.push(node);
    lastScan.skippedSubtrees = skippedSubtrees;
    log.debug('extract: ' + nodes.length + ' translatable text node(s) under ' + lastScan.root +
      ' (elements=' + lastScan.elements + ' skipped-subtrees=' + skippedSubtrees +
      ' text-nodes=' + lastScan.textNodes + ' skipped-text=' + lastScan.skippedText + ')');
    return nodes;
  }

  function scanStats() { return Object.assign({}, lastScan); }

  ns.extractor = {
    extractTextNodes: extractTextNodes,
    // Old names, kept working (same semantics: text nodes, not elements).
    extractReadableElements: extractTextNodes,
    collectTextNodes: extractTextNodes,
    shouldIgnore: shouldIgnore,
    isTranslatableText: function (node, opts) { return isTranslatableText(node, bounds(opts)); },
    scanStats: scanStats,
    SKIP_TAGS: SKIP_TAGS,
    SKIP_CLASS: SKIP_CLASS
  };
})();

