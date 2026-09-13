// content/renderer.js
// Classic-script module. Exports: ns.renderer
// Applies translations to the DOM, preserving the original text for toggling.
(function () {
  var ns = globalThis.__PLAMO__;
  var log = ns.logger.log;

  function applyTranslation(el, translatedText, originalText) {
    if (!el) return false;
    if (el.dataset.plamoOriginal == null) {
      el.dataset.plamoOriginal = originalText != null ? originalText : el.textContent;
    } else if (el.textContent === el.dataset.plamoOriginal) {
      el.dataset.plamoOriginal = originalText != null ? originalText : el.textContent;
    }
    el.textContent = translatedText;
    el.classList.add('plamo-translated');
    return true;
  }

  function restore(el) {
    if (!el) return false;
    var original = el.dataset.plamoOriginal;
    if (original != null) {
      el.textContent = original;
      delete el.dataset.plamoOriginal;
    }
    el.classList.remove('plamo-translated');
    return true;
  }

  ns.renderer = {
    applyTranslation: applyTranslation,
    restore: restore
  };
})();
