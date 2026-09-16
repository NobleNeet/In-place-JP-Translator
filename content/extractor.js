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
//
// WHAT IS RETURNED: collect(root) -> { visible: Text[], hidden: Text[] } (both in
// document order). Text the user cannot see right now — display:none,
// visibility:hidden, [hidden] — is collected too, but apart: a closed menu, a
// modal and a mobile header are all copies of text nobody is reading, and each is
// translated when it is displayed rather than up front. The rules for hidden text
// and for the article/menu/heading ordering live in content/priority.js; this file
// splits first and throws away only what no request could carry (a node over
// EXTRACT.maxTextLength, screen-reader text) - and it reports every refusal in
// scanStats()/the console, never silently. extractTextNodes(root) returns the
// visible part only.
//
// Exports: collect, extractTextNodes, extractTextNodesSplit, shouldIgnore,
//          isTranslatableText, scanStats
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

  // Screen-reader text: CSS hides it (.sr-only in Tailwind, .visually-hidden in
  // Bootstrap and friends), only a reader using assistive technology ever sees
  // it. It is not text anybody reads with their eyes, so translating it costs
  // tokens for nothing - and short link/icon labels are exactly what a model
  // answers with a copy of the English, which is where the `identical` console
  // noise on real pages came from. It is skipped outright: not sent, not even
  // deferred. Checked per node (not subtree-rejected) because an .sr-only span
  // is usually a sibling of real text, and climbing one class above the text
  // node's parent still catches <div class="sr-only"><span>text</span></div>.
  var VISUALLY_HIDDEN_CLASS = new Set([
    'sr-only', 'visually-hidden', 'visuallyhidden', 'screen-reader-text',
    'screen-reader-only', 'a11y-hidden'
  ]);

  function isVisuallyHiddenText(node) {
    var el = node.parentNode;
    var guard = 0;
    while (el && el.nodeType === 1 && guard++ < 3) {
      var cls = classString(el);
      if (cls) {
        var names = cls.split(/\s+/);
        for (var i = 0; i < names.length; i++) {
          if (VISUALLY_HIDDEN_CLASS.has(names[i])) return true;
        }
      }
      el = el.parentNode;
    }
    return false;
  }

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
    // NOTE: aria-hidden is deliberately NOT checked here. Per the ARIA spec it
    // takes the element out of the *accessibility tree*, not off the screen, and
    // plenty of publishing platforms put aria-hidden="true" on ordinary visible
    // body paragraphs (the kiosq markup `p.kiosq-b[aria-hidden]` on a real
    // article page did exactly that), so rejecting those subtrees threw away
    // article text the reader was looking at. Text nobody can actually see is
    // split out by content/priority.js, which asks the CSS instead of trusting
    // an ARIA hint (see the visibility note below).
    if (getAttr(el, 'data-plamo-skip') != null) return true;
    var translate = getAttr(el, 'translate');
    if (translate && String(translate).toLowerCase() === 'no') return true;
    var editable = getAttr(el, 'contenteditable');
    if (editable && String(editable).toLowerCase() !== 'false') return true;
    if (el.isContentEditable === true) return true; // set from script, no attribute
    // NOTE: display:none / visibility:hidden is deliberately NOT checked here any
    // more. Hidden text is still collected, but separately from the visible text,
    // so it can be translated when it is displayed instead of never (see
    // content/priority.js and collect() below). This list stays for subtrees that
    // must never be touched at all: code, form state, SVG layout, <head>.
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

  // null = collect it; a string = the one reason it was refused. Answering
  // *why* matters: a paragraph left in English because it was over the length
  // cap used to be indistinguishable from one nobody ever scanned.
  function textSkipReason(node, limits) {
    var value = node.nodeValue;
    if (typeof value !== 'string' || !value) return 'empty';
    var trimmed = value.trim();
    if (trimmed.length < limits.min) return 'short';
    if (trimmed.length > limits.max) return 'long';
    if (!LETTER_RE.test(trimmed)) return 'no-letters';
    if (/[\r\n]/.test(value) && preservesWhitespace(node.parentNode)) return 'pre';
    return null;
  }

  function isTranslatableText(node, limits) { return textSkipReason(node, limits) === null; }

  // A refused-too-long node gets a short address in the log (tag#id.first-class
  // chain, a few steps up), because "1 node was too long" is not actionable.
  function longNodeAddress(el) {
    var out = [];
    var node = el;
    var guard = 0;
    while (node && node.nodeType === 1 && guard++ < 4) {
      var tag = String(node.tagName || '').toLowerCase();
      if (node.id) tag += '#' + node.id;
      else {
        var cls = classString(node).trim().split(/\s+/)[0];
        if (cls) tag += '.' + cls;
      }
      out.unshift(tag);
      node = node.parentNode;
    }
    return out.join(' > ');
  }

  var lastScan = { root: null, elements: 0, skippedSubtrees: 0, textNodes: 0, skippedText: 0,
    skippedA11y: 0, tooLong: 0, hiddenText: 0, styleLookups: 0, at: 0 };

  // ns.priority, with a loud warning when it is missing: load order in
  // manifest.json decides this, and a silent "everything is visible" answer is
  // the kind of bug that costs hours on a real page.
  function priorityModule() {
    if (!ns.priority) {
      log.warn('extractor: content/priority.js is not loaded before extractor.js; ' +
        'hidden text is treated as visible and translated right away');
      return null;
    }
    return ns.priority;
  }

  // One segment per *direct* text child: that is what keeps one piece of text
  // from becoming one segment per ancestor. A single TreeWalker over elements
  // and text nodes keeps the result in document order, so a paragraph reads in
  // the order it is displayed even when it contains inline <a>/<strong> etc.
  // Elements are only gates (FILTER_SKIP descends into them, FILTER_REJECT
  // drops their whole subtree); the nodes handed back are always Text nodes.
  //
  // -> { visible: Text[], hidden: Text[] }, both in document order. `hidden`
  // holds the text nodes the user cannot see right now: real text on the page,
  // just not text anybody is reading at this moment (see content/priority.js).
  function collect(root, opts) {
    root = root || (typeof document !== 'undefined' ? document : null);
    if (!root) { log.warn('extract: no root to walk'); return { visible: [], hidden: [] }; }
    var visible = [];
    var hidden = [];
    if (root.nodeType === 1 && shouldIgnore(root)) {
      log.warn('extract: root ' + (tagNameOf(root) || 'node') + ' is on the skip list, nothing to do');
      return { visible: visible, hidden: hidden };
    }
    var doc = root.ownerDocument || root;
    var limits = bounds(opts);
    var skippedSubtrees = 0;
    var NF = globalThis.NodeFilter;
    var prio = priorityModule();
    var vis = prio ? prio.createVisibility(root, opts && opts.visibility) : null;
    lastScan = { root: (root.nodeType === 9) ? 'document' : tagNameOf(root), elements: 0,
      skippedSubtrees: 0, textNodes: 0, skippedText: 0, skippedA11y: 0, tooLong: 0,
      hiddenText: 0, styleLookups: 0, at: Date.now() };
    var longNotes = [];
    var walker;
    try {
      walker = doc.createTreeWalker(root, NF.SHOW_ELEMENT | NF.SHOW_TEXT, {
        acceptNode: function (node) {
          if (node.nodeType === TEXT_NODE) {
            lastScan.textNodes++;
            if (isVisuallyHiddenText(node)) { lastScan.skippedText++; lastScan.skippedA11y++; return NF.FILTER_SKIP; }
            var reason = textSkipReason(node, limits);
            if (reason) {
              lastScan.skippedText++;
              if (reason === 'long') {
                lastScan.tooLong++;
                if (longNotes.length < 4) {
                  longNotes.push(longNodeAddress(node.parentNode) + ' ' +
                    String(node.nodeValue || '').trim().length + ' chars');
                }
              }
              return NF.FILTER_SKIP;
            }
            return NF.FILTER_ACCEPT;
          }
          if (node !== root && shouldIgnore(node)) { skippedSubtrees++; return NF.FILTER_REJECT; }
          lastScan.elements++;
          return NF.FILTER_SKIP;
        }
      });
    } catch (e) {
      log.error('extract: createTreeWalker failed: ' + ((e && e.message) || e));
      return { visible: visible, hidden: hidden };
    }
    var node;
    while ((node = walker.nextNode())) {
      // The one question asked per collected node: can the user see it?
      if (vis && vis.hidden(node.parentNode)) hidden.push(node);
      else visible.push(node);
    }
    lastScan.skippedSubtrees = skippedSubtrees;
    lastScan.hiddenText = hidden.length;
    if (vis) {
      var vs = vis.stats();
      lastScan.styleLookups = vs.styleLookups;
      lastScan.hiddenElements = vs.hiddenElements;
      lastScan.visibilityBudgetHit = vs.budgetHit;
    }
    log.debug('extract: ' + visible.length + ' visible + ' + hidden.length + ' hidden text node(s) under ' +
      lastScan.root + ' (elements=' + lastScan.elements + ' skipped-subtrees=' + skippedSubtrees +
      ' text-nodes=' + lastScan.textNodes + ' skipped-text=' + lastScan.skippedText +
      ' a11y-hidden=' + lastScan.skippedA11y + ' too-long=' + lastScan.tooLong +
      ' css-lookups=' + lastScan.styleLookups + ')');
    // A paragraph over the length cap stays in English until the cap is raised;
    // saying so loudly is the entire difference between a diagnosable page and
    // a mysterious "a few paragraphs were left behind" report.
    if (lastScan.tooLong) {
      log.warn('extract: ' + lastScan.tooLong + ' text node(s) exceed EXTRACT.maxTextLength (' +
        limits.max + ' chars) and are LEFT UNTRANSLATED: ' + longNotes.join(' | ') +
        (lastScan.tooLong > longNotes.length ? ' ...' : '') +
        ' (raise EXTRACT.maxTextLength in shared/constants.js, or split the node; __plamo.getUntranslated() lists what stayed in English)');
    }
    return { visible: visible, hidden: hidden };
  }

  // The visible part only: what a run sends right now.
  function extractTextNodes(root, opts) { return collect(root, opts).visible; }
  // Both parts, so the caller can hold the hidden part back (see content/content.js).
  function extractTextNodesSplit(root, opts) { return collect(root, opts); }

  function scanStats() { return Object.assign({}, lastScan); }

  ns.extractor = {
    extractTextNodes: extractTextNodes,
    extractTextNodesSplit: extractTextNodesSplit,
    collect: collect,
    // Old names, kept working (same semantics: text nodes, not elements).
    extractReadableElements: extractTextNodes,
    collectTextNodes: extractTextNodes,
    shouldIgnore: shouldIgnore,
    isTranslatableText: function (node, opts) { return isTranslatableText(node, bounds(opts)); },
    textSkipReason: function (node, opts) { return textSkipReason(node, bounds(opts)); },
    scanStats: scanStats,
    SKIP_TAGS: SKIP_TAGS,
    SKIP_CLASS: SKIP_CLASS,
    VISUALLY_HIDDEN_CLASS: VISUALLY_HIDDEN_CLASS
  };
})();

