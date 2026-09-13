// content/renderer.js
// Applies a translation to a segment's DOM node and preserves the original.
//
// The original English text is preserved via data-* attributes so a future
// UI can toggle between: translation only / original only / both.

export function applyTranslation(segment, translatedText) {
  const el = segment.source && segment.source.element;
  if (!el || typeof el.textContent !== 'string') return false;

  el.dataset.plamoId = segment.id;
  el.dataset.plamoState = 'translated';
  el.dataset.plamoOriginal = segment.text;
  el.textContent = translatedText;

  segment.translatedText = translatedText;
  segment.state = 'translated';
  return true;
}

export function restoreOriginal(segment) {
  const el = segment.source && segment.source.element;
  if (!el) return false;

  el.textContent = segment.text;
  el.dataset.plamoState = 'untranslated';
  delete el.dataset.plamoId;
  delete el.dataset.plamoOriginal;

  segment.state = 'untranslated';
  return true;
}
