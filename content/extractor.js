// content/extractor.js
// Classic-script module. Exports: ns.extractor
// Selects text-bearing elements from a page, skipping noise/script elements.
(function () {
  var ns = globalThis.__PLAMO__;
  var log = ns.logger.log;

  var SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'CODE', 'PRE', 'TEXTAREA', 'INPUT', 'SELECT', 'SVG', 'CANVAS', 'MATH']);
  var SKIP_CLASS = new Set(['no-translate', 'no-translate-block', 'no-translate-children']);

  function shouldIgnore(el) {
    var tag = el.tagName;
    if (SKIP_TAGS.has(tag)) return true;
    var role = el.getAttribute && el.getAttribute('aria-hidden');
    if (role === 'true') return true;
    var cls = (el.className && el.className.baseVal) || el.className;
    if (typeof cls === 'string') {
      var names = cls.split(/\s+/);
      for (var i = 0; i < names.length; i++) {
        if (SKIP_CLASS.has(names[i])) return true;
      }
    }
    var style = el.getAttribute && el.getAttribute('style');
    if (style && /display:\s*none|visibility:\s*hidden/.test(style)) return true;
    return false;
  }

  function collectTextNodes(root) {
    var nodes = [];
    var doc = root.ownerDocument || root;
    var walker = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
      acceptNode: function (el) {
        if (el !== root && shouldIgnore(el)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    var el;
    while ((el = walker.nextNode())) {
      if (el.textContent.trim().length > 0) nodes.push(el);
    }
    return nodes;
  }

  function extractReadableElements(root) {
    root = root || document;
    var elements = collectTextNodes(root);
    log.debug('extract: found ' + elements.length + ' element(s) under root ' + (root === document ? 'document' : root.tagName));
    return elements;
  }

  ns.extractor = {
    extractReadableElements: extractReadableElements,
    shouldIgnore: shouldIgnore,
    SKIP_TAGS: SKIP_TAGS,
    SKIP_CLASS: SKIP_CLASS
  };
})();
