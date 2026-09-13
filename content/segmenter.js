// content/segmenter.js
// Turns extracted readable fragments into translation segments with:
//   - unique id
//   - token estimate (loose heuristic)
//   - language heuristic (skip obvious non-English)
//   - viewport priority (visible / near / far)
//   - a stable DOM source so results can be mapped back reliably.

const JAPANESE = /[㐀-鿿ぁ-んァ-ン]/; // kanji + hiragana + katakana

let counter = 0;
export function makeSegmentId() {
  counter += 1;
  return `segment-${Date.now().toString(36)}-${counter}`;
}

// 1 token ~= 4 characters (English). Separated as its own function so the
// heuristic can be replaced with a real tokenizer later.
export function estimateTokens(text, charPerToken = 4) {
  const len = (text || '').length;
  return Math.max(1, Math.ceil(len / Math.max(1, charPerToken | 0)));
}

// Lightweight English heuristic. Text with kana/kanji is skipped as already
// Japanese; pure numbers/symbols are skipped; mixed Latin+numbers/proper
// nouns (e.g. "Version 2.1 supports Linux.") are kept.
export function isLikelyEnglish(text) {
  const t = (text || '').trim();
  if (t.length < 2) return false;
  if (JAPANESE.test(t)) return false;
  const letters = (t.match(/[A-Za-z]/g) || []).length;
  if (letters === 0) return false;
  return letters / t.length >= 0.3;
}

function computePriority(el) {
  let rect;
  try {
    rect = el.getBoundingClientRect();
  } catch {
    return 3;
  }
  if (rect.width === 0 && rect.height === 0) return 3;
  const viewBottom = Math.max(window.innerHeight || 0, document.documentElement.clientHeight || 0);
  if (rect.top < viewBottom) return 1; // currently visible
  if (rect.top < viewBottom * 1.5) return 2; // just below the fold
  return 3; // further down
}

export function buildSegments(readables) {
  const segments = [];
  for (const { element, text } of readables) {
    if (!isLikelyEnglish(text)) continue;
    segments.push({
      id: makeSegmentId(),
      text,
      tokenEstimate: estimateTokens(text),
      priority: computePriority(element),
      state: 'untranslated',
      source: { element, renderMode: 'textContent' },
    });
  }
  return segments;
}
