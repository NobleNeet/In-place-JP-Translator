// test/dom.test.cjs
//
// Layout-safety tests for the text-node pipeline (extractor -> segmenter ->
// renderer). This repository has no jsdom dependency, so a small DOM is
// implemented right here: elements, text nodes, attributes and a TreeWalker over
// elements + text nodes — exactly the surface those modules touch (they are
// deliberately duck-typed, they never use instanceof on DOM hosts). The packer
// is loaded too, so the grouping keys the segmenter assigns get checked where
// the nodes are real elements.
//
// What these tests guard:
//   * a text node is collected once, never once per ancestor element;
//   * scripts / code / form controls / aria-hidden / translate="no" subtrees
//     are never collected;
//   * writing a translation changes ONLY Text.nodeValue: the element tree,
//     every attribute and every untouched text node stay byte-identical;
//   * leading/trailing whitespace survives, so inline siblings do not glue;
//   * restore()/restoreAll() put the original values back and leave no
//     attributes behind;
//   * the fragments of one paragraph (text around an inline link) and the items
//     of one list are packed into the same API request, never split apart.
//
// Run: node test/dom.test.cjs

'use strict';

const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const dir = path.join(__dirname, '..');
const order = ['shared/logger.js', 'shared/constants.js', 'content/extractor.js',
  'content/segmenter.js', 'content/renderer.js', 'translation/batcher.js'];

// --- mini DOM -----------------------------------------------------------------
class MiniNode {
  constructor(doc) {
    this.ownerDocument = doc;
    this.parentNode = null;
    this.childNodes = [];
    this.nextSibling = null;
    this.previousSibling = null;
  }
  get firstChild() { return this.childNodes[0] || null; }
  get lastChild() { return this.childNodes[this.childNodes.length - 1] || null; }
  get children() { return this.childNodes.filter((n) => n.nodeType === 1); }
  appendChild(child) {
    if (child.parentNode) child.parentNode.removeChild(child);
    const last = this.lastChild;
    if (last) { last.nextSibling = child; child.previousSibling = last; }
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }
  removeChild(child) {
    const i = this.childNodes.indexOf(child);
    if (i === -1) return child;
    this.childNodes.splice(i, 1);
    if (child.previousSibling) child.previousSibling.nextSibling = child.nextSibling;
    if (child.nextSibling) child.nextSibling.previousSibling = child.previousSibling;
    child.previousSibling = null; child.nextSibling = null; child.parentNode = null;
    return child;
  }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  contains(other) { for (let n = other; n; n = n.parentNode) { if (n === this) return true; } return false; }
  get textContent() {
    return this.childNodes.map((c) => (c.nodeType === 3 ? String(c.nodeValue) : c.textContent)).join('');
  }
}

class MiniText extends MiniNode {
  constructor(doc, value) { super(doc); this.nodeType = 3; this.nodeName = '#text'; this.nodeValue = String(value); }
}
class MiniElement extends MiniNode {
  constructor(doc, tagName) {
    super(doc);
    this.nodeType = 1;
    this.tagName = String(tagName).toUpperCase();
    this.nodeName = this.tagName;
    this.attributes = new Map();
    this._rect = { top: 100, bottom: 140, left: 0, right: 600 };
  }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  removeAttribute(name) { this.attributes.delete(name); }
  hasAttribute(name) { return this.attributes.has(name); }
  attributeNames() { return Array.from(this.attributes.keys()); }
  get className() { return this.getAttribute('class') || ''; }
  set className(v) { this.setAttribute('class', v); }
  get id() { return this.getAttribute('id') || ''; }
  set id(v) { this.setAttribute('id', v); }
  get isContentEditable() { return (this.getAttribute('contenteditable') || '').toLowerCase() === 'true'; }
  getBoundingClientRect() { return this._rect; }
  // Only '.class' / 'tag' selectors are needed here.
  querySelectorAll(sel) {
    const out = [];
    const want = sel[0] === '.' ? { cls: sel.slice(1) } : { tag: sel.toUpperCase() };
    (function walk(n) {
      n.childNodes.forEach((c) => {
        if (c.nodeType !== 1) return;
        if (want.cls) { if ((' ' + c.className + ' ').indexOf(' ' + want.cls + ' ') !== -1) out.push(c); }
        else if (c.tagName === want.tag) out.push(c);
        walk(c);
      });
    })(this);
    return out;
  }
}

// TreeWalker over elements *and* text nodes: the filter decides per node,
// FILTER_REJECT drops the subtree, FILTER_SKIP drops the node but keeps
// walking below it (TreeWalker semantics). Accepted nodes come back in
// document order, which is what nextNode() must guarantee.
class MiniWalker {
  constructor(root, filter) {
    this.list = [];
    const ACCEPT = 1, REJECT = 2, SKIP = 3;
    const self = this;
    (function visit(node) {
      node.childNodes.forEach((child) => {
        const code = filter ? filter.acceptNode(child) : ACCEPT;
        if (code === REJECT) return;
        if (code === ACCEPT) self.list.push(child);
        visit(child); // a Text node has no children, so this is a no-op there
      });
    })(root);
    this.i = 0;
  }
  nextNode() { return this.i < this.list.length ? this.list[this.i++] : null; }
}

class MiniDocument extends MiniNode {
  constructor() {
    super(null);
    this.ownerDocument = this;
    this.nodeType = 9;
    this.nodeName = '#document';
    this.defaultView = null;
  }
  createElement(tag) { return new MiniElement(this, tag); }
  createTextNode(value) { return new MiniText(this, value); }
  createTreeWalker(root, whatToShow, filter) { return new MiniWalker(root, filter); }
  get documentElement() { return this.children[0] || null; }
  querySelectorAll(sel) {
    return this.documentElement ? this.documentElement.querySelectorAll(sel) : [];
  }
  get body() { return this.documentElement ? this.documentElement.querySelectorAll('body')[0] : null; }
}
const documentMock = new MiniDocument();
const windowMock = {
  innerHeight: 800,
  getComputedStyle(el) { return { whiteSpace: (el && el.getAttribute('data-ws')) || 'normal' }; }
};
documentMock.defaultView = windowMock;

// Builder: E('p', { class: 'x' }, 'text', E('a', { href: '/' }, 'link'))
function E(tag, attrs) {
  const el = documentMock.createElement(tag);
  if (attrs) Object.keys(attrs).forEach((k) => el.setAttribute(k, attrs[k]));
  for (let i = 2; i < arguments.length; i++) {
    const kid = arguments[i];
    if (kid == null) continue;
    el.appendChild(typeof kid === 'string' ? documentMock.createTextNode(kid) : kid);
  }
  return el;
}

// --- the page under test ------------------------------------------------------
// A page with the structures that used to break: nested containers, inline
// siblings around a link, form controls, code, and every skip convention.
const page = E('div', { id: 'site', class: 'wrap' },
  E('nav', { class: 'nav' }, E('a', { href: '/' }, 'Home'), ' | ', E('a', { href: '/docs' }, 'Docs')),
  E('main', { id: 'main' },
    E('h1', {}, 'Getting Started'),
    E('p', {}, 'Read the ', E('a', { href: '/manual' }, 'manual'), ' first.'),
    E('p', { class: 'lead' }, 'Welcome to the product.'),
    E('div', {}, '  Whitespace matters  '),
    E('pre', { 'data-ws': 'pre' }, 'const a = 1;\nconst b = 2;'),
    E('code', {}, 'npm install plamo'),
    E('textarea', { rows: '3' }, 'Type your message'),
    E('input', { type: 'text', value: 'search text' }),
    E('select', {}, E('option', {}, 'First choice')),
    E('script', {}, 'var tracker = function () { return "Script text here"; };'),
    E('style', {}, '.nav { color: red; }'),
    E('div', { 'aria-hidden': 'true' }, 'Decorative glyph'),
    E('div', { translate: 'no' }, 'Legal Code'),
    E('div', { class: 'notranslate' }, 'Do Not Translate'),
    E('div', { style: 'display:none' }, 'Hidden text body'),
    E('div', { contenteditable: 'true' }, 'Editable area text'),
    E('svg', { viewBox: '0 0 10 10' }, E('text', {}, 'SVG label')),
    E('ul', {}, E('li', {}, 'First item'), E('li', {}, 'Second item')),
    E('div', {}, 'a'),
    E('div', {}, '12345'),
    E('div', {}, 'これは日本語です。'),
    documentMock.createTextNode('  ')
  )
);
documentMock.appendChild(E('html', {}, E('body', {}, page)));

// --- load the modules the way the content script does -------------------------
const warnings = [];
const sandbox = {
  console: { log() {}, warn() { warnings.push(Array.prototype.join.call(arguments, ' ')); }, error() { warnings.push(Array.prototype.join.call(arguments, ' ')); }, debug() {}, trace() {} },
  Map, Set, WeakMap, Promise, Object, Array, String, Number, Boolean, Math, JSON, Date, RegExp,
  Error, TypeError, Symbol, parseInt, parseFloat, isNaN, setTimeout, clearTimeout,
  performance: { now: () => Date.now() },
  document: documentMock, window: windowMock,
  NodeFilter: { SHOW_ELEMENT: 1, SHOW_TEXT: 4, SHOW_ALL: -1, FILTER_ACCEPT: 1, FILTER_REJECT: 2, FILTER_SKIP: 3 }
};
sandbox.globalThis = sandbox;
const ctx = vm.createContext(sandbox);
for (const f of order) vm.runInContext(readFileSync(path.join(dir, f), 'utf8'), ctx, { filename: f });

const ns = sandbox.__PLAMO__;
const extractor = ns.extractor;
const segmenter = ns.segmenter;
const renderer = ns.renderer;

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.log('  FAIL' + name + (extra != null ? '  << ' + JSON.stringify(extra) : '')); }
}

// --- DOM snapshot helpers -----------------------------------------------------
// Shape = tags + attributes (ignoring our own bookkeeping attribute) + the
// number and position of text-node slots. If this string is identical before
// and after a translation run, the page structure provably did not change.
function shape(node) {
  if (node.nodeType === 3) return '#text';
  if (node.nodeType !== 1) { // the document node itself: transparent container
    var all = '';
    node.childNodes.forEach((c) => { all += shape(c); });
    return all;
  }
  const attrs = node.attributeNames().filter((a) => a !== 'data-plamo-t').sort()
    .map((a) => a + '=' + node.getAttribute(a));
  let s = '<' + node.tagName + (attrs.length ? '[' + attrs.join(' ') + ']' : '');
  node.childNodes.forEach((c) => { s += shape(c); });
  return s + '</' + node.tagName + '>';
}
// Every value in the document: text-node values and attribute values.
function values(node, out) {
  out = out || [];
  if (node.nodeType === 3) { out.push('T ' + JSON.stringify(node.nodeValue)); return out; }
  if (node.nodeType === 1) {
    node.attributeNames().forEach((a) => out.push('A ' + node.tagName + '/' + a + ' ' + JSON.stringify(node.getAttribute(a))));
  }
  node.childNodes.forEach((c) => values(c, out));
  return out;
}
// All text nodes under root (document order), optionally filtered by value.
function textNodesOf(root, filterFn) {
  const out = [];
  (function walk(n) {
    n.childNodes.forEach((c) => {
      if (c.nodeType === 3) { if (!filterFn || filterFn(c.nodeValue)) out.push(c); }
      else walk(c);
    });
  })(root);
  return out;
}
const jp = (v) => /[\u3040-\u30ff]/.test(String(v)); // contains kana => translated
console.log('== extractor: collects text nodes, once each ==');
const nodes = extractor.extractTextNodes(documentMock);
const collected = new Set(nodes);
const findNode = (value) => textNodesOf(documentMock, (v) => v === value)[0] || null;
const isCollected = (n) => !!n && collected.has(n);

ok('all collected nodes are Text nodes', nodes.length > 0 && nodes.every((n) => n.nodeType === 3));
ok('no node collected twice (no per-ancestor duplicates)', new Set(nodes).size === nodes.length, nodes.length);
function insideSkippedSubtree(n) {
  for (let p = n.parentNode; p && p.nodeType === 1; p = p.parentNode) { if (extractor.shouldIgnore(p)) return true; }
  return false;
}
const eligible = textNodesOf(documentMock).filter((n) => !insideSkippedSubtree(n) && extractor.isTranslatableText(n));
ok('collected exactly the eligible text nodes', nodes.length === eligible.length, [nodes.length, eligible.length]);
const scan = extractor.scanStats();
ok('scan stats: elements walked', scan.elements > 10, scan.elements);
ok('scan stats: skipped subtrees counted', scan.skippedSubtrees >= 8, scan.skippedSubtrees);
ok('scan stats: whitespace-only text nodes skipped', scan.skippedText >= 1, scan.skippedText);

console.log('== extractor: what it refuses ==');
ok('h1 text collected', isCollected(findNode('Getting Started')));
ok('text before an inline link collected', isCollected(findNode('Read the ')));
ok('text after an inline link collected', isCollected(findNode(' first.')));
ok('link text collected (it is a text node of <a>)', isCollected(findNode('manual')));
ok('Japanese text still collected (language is the segmenter job)', isCollected(findNode('これは日本語です。')));
ok('<pre> left alone', !isCollected(findNode('const a = 1;\nconst b = 2;')));
ok('<code> left alone', !isCollected(findNode('npm install plamo')));
ok('<textarea> left alone', !isCollected(findNode('Type your message')));
ok('<option> left alone', !isCollected(findNode('First choice')));
ok('<script> left alone', !isCollected(findNode('var tracker = function () { return "Script text here"; };')));
ok('<style> left alone', !isCollected(findNode('.nav { color: red; }')));
ok('aria-hidden subtree left alone', !isCollected(findNode('Decorative glyph')));
ok('translate="no" left alone', !isCollected(findNode('Legal Code')));
ok('.notranslate left alone', !isCollected(findNode('Do Not Translate')));
ok('display:none subtree left alone', !isCollected(findNode('Hidden text body')));
ok('contenteditable left alone', !isCollected(findNode('Editable area text')));
ok('<svg> left alone', !isCollected(findNode('SVG label')));
ok('one-letter fragment dropped', !isCollected(findNode('a')));
ok('digit-only fragment dropped', !isCollected(findNode('12345')));
ok('whitespace-only node dropped', !isCollected(findNode('  ')));

console.log('== segmenter: one segment per text node ==');
const segs = segmenter.buildSegments(documentMock);
ok('every segment carries a Text node reference', segs.length > 0 && segs.every((s) => s.source && s.source.node && s.source.node.nodeType === 3));
ok('segment ids unique', new Set(segs.map((s) => s.id)).size === segs.length);
ok('non-English text not segmented', !segs.some((s) => s.text === 'これは日本語です。'));
ok('leading whitespace kept out of the text', segs.filter((s) => /^\s|\s$/.test(s.text)).length === 0);
const wsSeg = segs.filter((s) => s.text === 'Whitespace matters')[0];
ok('surrounding whitespace remembered', !!wsSeg && wsSeg.source.leading === '  ' && wsSeg.source.trailing === '  ',
  wsSeg && [wsSeg.source.leading, wsSeg.source.trailing]);
ok('original value stored for restore', !!wsSeg && wsSeg.source.original === '  Whitespace matters  ');
const beforeLink = segs.filter((s) => s.source.original === 'Read the ')[0];
ok('inline sibling keeps its trailing space in source', !!beforeLink && beforeLink.source.trailing === ' ' && beforeLink.text === 'Read the');
const afterLink = segs.filter((s) => s.source.original === ' first.')[0];
ok('inline sibling keeps its leading space in source', !!afterLink && afterLink.source.leading === ' ' && afterLink.text === 'first.');
const linkSeg = segs.filter((s) => s.text === 'manual')[0];
ok('link text is its own segment', !!linkSeg && linkSeg.source.parentTag === 'A' && linkSeg.source.node.parentNode.getAttribute('href') === '/manual');
const pSegs = segs.filter((s) => s.source.parentTag === 'P' && /Welcome/.test(s.text));
ok('a <p> yields one segment, not one per ancestor', pSegs.length === 1);
ok('path points at the parent element', !!pSegs[0] && /\.lead$/.test(pSegs[0].source.path), pSegs[0] && pSegs[0].source.path);
console.log('== segmenter: block / container grouping keys ==');
const linkTrio = [beforeLink, linkSeg, afterLink];
ok('every segment carries both grouping keys', segs.every((s) => !!s.block && !!s.container));
ok('inline siblings around a link share one block', linkTrio.every((s) => !!s && !!s.block) &&
  new Set(linkTrio.map((s) => s.block)).size === 1, linkTrio.map((s) => s && s.block));
const welcomeSeg = segs.filter((s) => s.text === 'Welcome to the product.')[0];
ok('another paragraph is another block', !!welcomeSeg && linkTrio[0].block !== welcomeSeg.block,
  [linkTrio[0].block, welcomeSeg && welcomeSeg.block]);
const itemSegs = ['First item', 'Second item'].map((t) => segs.filter((s) => s.text === t)[0]);
ok('list items are separate blocks', itemSegs.every((s) => !!s) && itemSegs[0].block !== itemSegs[1].block,
  itemSegs.map((s) => s && s.block));
ok('list items share one container', !!itemSegs[0] && itemSegs[0].container === itemSegs[1].container && !!itemSegs[0].container,
  itemSegs.map((s) => s && s.container));

console.log('== packer: a paragraph or menu is not split across requests ==');
const packer = ns.createBatcher({
  maxSegmentsPerBatch: ns.constants.BATCH_SETTINGS.maxSegmentsPerBatch,
  maxEstimatedTokensPerBatch: ns.constants.BATCH_SETTINGS.maxEstimatedTokensPerBatch,
  firstBatchMaxSegments: ns.constants.BATCH_SETTINGS.maxSegmentsPerBatch
});
const packs = packer.batchUnits(segmenter.sortSegmentsByViewport(segs));
const inSameBatch = (a, b) => packs.some((bt) => bt.segments.indexOf(a) !== -1 && bt.segments.indexOf(b) !== -1);
ok('nothing lost or duplicated by the packer', packs.reduce((n, bt) => n + bt.segments.length, 0) === segs.length,
  [packs.reduce((n, bt) => n + bt.segments.length, 0), segs.length]);
ok('this small page fits in one request', packs.length === 1, packs.map((bt) => bt.segments.length));
ok('the fragments around a link are not split', inSameBatch(beforeLink, linkSeg) && inSameBatch(linkSeg, afterLink));
ok('list items travel together', inSameBatch(itemSegs[0], itemSegs[1]));
const tightPacker = ns.createBatcher({ maxSegmentsPerBatch: 3, maxEstimatedTokensPerBatch: 100000, firstBatchMaxSegments: 3 });
const tightPacks = tightPacker.batchUnits(segmenter.sortSegmentsByViewport(segs));
ok('a block bigger than the cap stays whole instead of being cut',
  tightPacks.some((bt) => linkTrio.every((s) => bt.segments.indexOf(s) !== -1)), tightPacks.map((bt) => bt.segments.length));
ok('tight packing still covers every segment',
  tightPacks.reduce((n, bt) => n + bt.segments.length, 0) === segs.length && tightPacks.length > 1,
  tightPacks.map((bt) => bt.segments.length));
const h1El = documentMock.querySelectorAll('h1')[0];
h1El._rect = { top: 5000, bottom: 5040, left: 0, right: 600 }; // far below the fold
const segs2 = segmenter.buildSegments(documentMock);
const h1Seg = segs2.filter((s) => s.text === 'Getting Started')[0];
ok('below-the-fold node gets a lower viewport band', !!h1Seg && h1Seg.viewport === 3, h1Seg && h1Seg.viewport);
const ordered = segmenter.sortSegmentsByViewport(segs2);
ok('viewport-first ordering', ordered[0].viewport === 1 && ordered[ordered.length - 1].viewport === 3,
  ordered.map((s) => s.viewport).slice(0, 3));
const inView = ordered.filter((s) => s.viewport === 1).map((s) => s.source.node);
const docOrder = textNodesOf(documentMock).filter((n) => inView.indexOf(n) !== -1);
ok('document order kept inside a band', inView.map((n) => n.nodeValue).join('|') === docOrder.map((n) => n.nodeValue).join('|'),
  [inView.map((n) => n.nodeValue), docOrder.map((n) => n.nodeValue)]);
console.log('== renderer: writing a translation changes ONLY Text.nodeValue ==');
const shapeBefore = shape(documentMock);
const valuesBefore = values(documentMock);
const textCountBefore = textNodesOf(documentMock).length;
const pEl = documentMock.querySelectorAll('p').filter((p) => /Welcome/.test(p.textContent))[0];
const inlineP = documentMock.querySelectorAll('p').filter((p) => p.childNodes.length === 3)[0];

const results = segs.map((s, i) => renderer.applySegment(s, 'ヤク' + i));
const appliedCount = results.filter((r) => r.ok).length;
ok('every segment written into its own text node', appliedCount === segs.length, [appliedCount, segs.length]);
ok('renderer counts the same', renderer.appliedCount() === appliedCount, [renderer.appliedCount(), appliedCount]);
ok('DOM STRUCTURE UNCHANGED (tags + attributes + text-node slots)', shape(documentMock) === shapeBefore);
ok('text-node count unchanged (nothing inserted or removed)', textNodesOf(documentMock).length === textCountBefore,
  [textNodesOf(documentMock).length, textCountBefore]);
ok('every target node now holds Japanese', segs.every((s) => jp(s.source.node.nodeValue)),
  segs.filter((s) => !jp(s.source.node.nodeValue)).map((s) => s.source.node.nodeValue));
ok('the number of text nodes never changed while writing', textNodesOf(documentMock).length === textCountBefore);
ok('untouched text nodes keep their exact value',
  !!findNode('const a = 1;\nconst b = 2;') && !!findNode('Type your message') && !!findNode('First choice') &&
  !!findNode('var tracker = function () { return "Script text here"; };') && !!findNode('Decorative glyph') &&
  !!findNode('Legal Code') && !!findNode('Do Not Translate') && !!findNode('Hidden text body') &&
  !!findNode('Editable area text') && !!findNode('SVG label') && !!findNode('これは日本語です。'));
const wsNode = findNode('  Whitespace matters  ') || segs.filter((s) => s.text === 'Whitespace matters')
  .map((s) => s.source.node)[0];
ok('surrounding whitespace restored around the translation', wsNode && /^\s+\S+\s+$/.test(wsNode.nodeValue) && jp(wsNode.nodeValue),
  wsNode && JSON.stringify(wsNode.nodeValue));
const linkNode = linkSeg.source.node;
ok('inline run still has its three separate pieces', inlineP.childNodes.length === 3 && inlineP.childNodes[1].tagName === 'A' &&
  inlineP.childNodes[1].childNodes.length === 1 && jp(inlineP.childNodes[1].firstChild.nodeValue));
ok('link element intact after its text was translated', linkNode.parentNode.getAttribute('href') === '/manual' && jp(linkNode.nodeValue));
ok('form control attribute intact', documentMock.querySelectorAll('input')[0].getAttribute('value') === 'search text');
ok('bookkeeping attribute marks the touched element', pEl.getAttribute('data-plamo-t') != null);
ok('a second write to the same node is refused as stale',
  renderer.applySegment(segs[0], 'ヤクagain').reason === 'changed-after-extract');
const sample = renderer.appliedSample(2);
ok('appliedSample reports before/after per node',
  sample.length === 2 && sample[0].before.length > 0 && jp(sample[0].after) && typeof sample[0].path === 'string');

console.log('== renderer: refusals protect the page ==');
const box = E('div', {}); // detached container: keeps the page untouched
const mkScratch = (v) => box.appendChild(documentMock.createTextNode(v));
const fenceNode = mkScratch('Some text');
renderer.applyToTextNode(fenceNode, '```\n日本語 の テキスト\n```');
ok('code fence stripped from the answer', fenceNode.nodeValue === '日本語 の テキスト', JSON.stringify(fenceNode.nodeValue));
const quoteNode = mkScratch('Some text two');
renderer.applyToTextNode(quoteNode, '“こんにちは”');
ok('wrapping quotes stripped', quoteNode.nodeValue === 'こんにちは', JSON.stringify(quoteNode.nodeValue));
const spaceNode = mkScratch('Some text three');
renderer.applyToTextNode(spaceNode, '  こんにちは   世界 \n');
ok('internal whitespace collapsed, none around it', spaceNode.nodeValue === 'こんにちは 世界', JSON.stringify(spaceNode.nodeValue));
const emptyNode = mkScratch('Some text four');
const emptyRes = renderer.applyToTextNode(emptyNode, '   ');
ok('empty answer refused, node untouched', !emptyRes.ok && emptyRes.reason === 'empty-translation' && emptyNode.nodeValue === 'Some text four');
const elRes = renderer.applyToTextNode(box, 'x');
ok('an element is never a write target', !elRes.ok && elRes.reason === 'not-a-text-node');
ok('the old element-shaped API returns false instead of wiping an element', renderer.applyTranslation(box, 'x') === false);
ok('renderer never adds or removes a child node', box.childNodes.length === 4 && box.firstChild.nodeType === 3);
const sameNode = mkScratch('同一');
const sameRes = renderer.applyToTextNode(sameNode, '同一');
ok('writing the identical value is reported, not counted', !sameRes.ok && sameRes.reason === 'identical');
const staleNode = mkScratch('Stale text');
staleNode.nodeValue = 'Re-rendered by the page';
const staleRes = renderer.applyToTextNode(staleNode, '日本語', { original: 'Stale text' });
ok('a node the page re-rendered is never overwritten', !staleRes.ok && staleRes.reason === 'changed-after-extract' &&
  staleNode.nodeValue === 'Re-rendered by the page');
const goneNode = documentMock.createTextNode('Gone text');
const goneRes = renderer.applyToTextNode(goneNode, '日本語');
ok('a node with no parent is refused', !goneRes.ok && goneRes.reason === 'detached');

console.log('== restore: the page returns to exactly what was loaded ==');
const pTextAfter = inlineP.textContent;
ok('inline run reads correctly after translation', inlineP.childNodes.length === 3 && /^\S.+ $/.test(inlineP.childNodes[0].nodeValue) &&
  /^ \S.+$/.test(inlineP.childNodes[2].nodeValue) && /\S \S/.test(pTextAfter), JSON.stringify(pTextAfter));
const navEl = documentMock.querySelectorAll('nav')[0];
const restoreTarget = segs.filter((s) => !navEl.contains(s.source.node))[0];
const countBeforeOne = renderer.appliedCount();
ok('restore(node) puts the original value back',
  renderer.restore(restoreTarget.source.node) === true && restoreTarget.source.node.nodeValue === restoreTarget.source.original);
ok('restore(node) unregisters that node', renderer.appliedCount() === countBeforeOne - 1, renderer.appliedCount());
ok('restore() on a node we never touched does nothing',
  renderer.restore(documentMock.querySelectorAll('textarea')[0].firstChild) === false);

const navSegCount = segs.filter((s) => navEl.contains(s.source.node)).length;
ok('the navigation links are segments too', navSegCount === 2 && jp(navEl.textContent));
const restoredScoped = renderer.restoreAll(navEl);
ok('restoreAll(root) limits itself to that subtree', restoredScoped === navSegCount, [restoredScoped, navSegCount]);
ok('restored subtree is English again', !jp(navEl.textContent));
ok('the rest of the page stays translated',
  segs.filter((s) => !navEl.contains(s.source.node) && s !== restoreTarget).every((s) => jp(s.source.node.nodeValue)),
  segs.filter((s) => !jp(s.source.node.nodeValue)).map((s) => s.source.node.nodeValue));

const detachNode = mkScratch('Detach me please');
renderer.applyToTextNode(detachNode, 'むす');
detachNode.remove(); // the page removed it (SPA re-render)
const countBefore = renderer.appliedCount();
const restoredAll = renderer.restoreAll();
ok('restoreAll() reports what it put back', restoredAll === countBefore - 1, [restoredAll, countBefore]);
ok('registry empty after restoreAll()', renderer.appliedCount() === 0);
ok('every value in the document matches the loaded state', values(documentMock).join('\n') === valuesBefore.join('\n'));
ok('no bookkeeping attribute left behind', !values(documentMock).some((v) => v.indexOf('data-plamo-t') !== -1));
ok('restoreAll() again has nothing to do', renderer.restoreAll() === 0);
ok('extractor still finds the same text nodes after a full cycle',
  extractor.extractTextNodes(documentMock).length === nodes.length);

console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
