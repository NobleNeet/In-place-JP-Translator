// content/extractor.js
// Extract readable text-bearing elements from the page.
//
// Includes: headings, paragraphs, list items, blockquotes, table cells,
// labels, buttons, etc.
// Excludes: script/style/noscript/code/pre/textarea/input, hidden elements,
// aria-hidden, contenteditable, and the extension's own UI.
//
// Inline elements (<strong>, <em>, <a>, ...) are merged into their parent
// block so a fragment like
//   <p>This is <strong>an important</strong> sentence.</p>
// yields a single segment "This is an important sentence.".

const SEGMENT_TAGS = new Set([
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'P', 'LI', 'BLOCKQUOTE', 'TD', 'TH', 'CAPTION',
  'LABEL', 'BUTTON', 'SUMMARY', 'DD', 'DT', 'OPTION', 'FIGCAPTION',
]);

// Subtrees whose text must never be translated.
const EXCLUDED_SUBTREES = new Set([
  'SCRIPT', 'STYLE', 'NOSCRIPT', 'CODE', 'PRE', 'TEXTAREA', 'INPUT', 'SELECT', 'SVG', 'CANVAS',
]);

function isHidden(el) {
  if (el.hidden) return true;
  let style;
  try {
    style = window.getComputedStyle(el);
  } catch {
    return true;
  }
  if (!style) return true;
  if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return true;
  if (parseFloat(style.opacity) === 0) return true;
  return false;
}

function isExcluded(el) {
  if (el.isContentEditable) return true;
  if (el.getAttribute('aria-hidden') === 'true') return true;
  if (el.getAttribute('data-plamo-translation-state')) return true; // our own UI
  if (el.closest && el.closest('[data-plamo-translation-state]')) return true;
  return false;
}

function isSegmentCandidate(el) {
  if (!SEGMENT_TAGS.has(el.tagName)) return false;
  return !isExcluded(el) && !isHidden(el);
}

export function getReadableText(root) {
  const parts = [];
  function walk(node) {
    if (node.nodeType === 3 /* Text */) {
      parts.push(node.textContent);
    } else if (node.nodeType === 1 /* Element */) {
      if (EXCLUDED_SUBTREES.has(node.tagName)) return;
      if (isHidden(node) || isExcluded(node)) return;
      const kids = node.childNodes;
      for (let i = 0; i < kids.length; i += 1) walk(kids[i]);
    }
  }
  walk(root);
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

// If a descendant element is itself a segment candidate, this element should
// not be extracted on its own (let the descendant be the segment).
function hasSegmentChild(el) {
  const selector = Array.from(SEGMENT_TAGS).join(',');
  const child = el.querySelector(selector);
  if (!child) return false;
  return isSegmentCandidate(child);
}

export function extractReadableElements(root = document) {
  const results = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
    acceptNode(node) {
      if (!isSegmentCandidate(node)) return NodeFilter.FILTER_REJECT;
      if (hasSegmentChild(node)) return NodeFilter.FILTER_REJECT;
      if (!getReadableText(node)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  let node;
  while ((node = walker.nextNode())) {
    if (node.nodeType === 1) results.push({ element: node, text: getReadableText(node) });
  }
  return results;
}
