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
//     of one list are packed into the same API request, never split apart;
//   * a run sends the article first and the menu last (content/priority.js),
//     and text the user cannot see is not sent until the page displays it.
//
// Run: node test/dom.test.cjs

'use strict';

const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const dir = path.join(__dirname, '..');
// priority.js comes before extractor.js: the extractor asks it whether the user
// can see a text node, and the segmenter asks it what region the node is in.
const order = ['shared/logger.js', 'shared/constants.js', 'content/priority.js', 'content/extractor.js',
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
  console: { log() {}, info() {}, warn() { warnings.push(Array.prototype.join.call(arguments, ' ')); }, error() { warnings.push(Array.prototype.join.call(arguments, ' ')); }, debug() {}, trace() {} },
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
// The extractor splits the page into what the user could see and what they
// could not: hidden text is no longer thrown away, it waits (see the reveal
// section further down for the waiting part).
const split = extractor.extractTextNodesSplit(documentMock);
const nodes = split.visible;
const hiddenNodes = split.hidden;
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
ok('collected exactly the eligible text nodes (visible + hidden)', nodes.length + hiddenNodes.length === eligible.length,
  [nodes.length, hiddenNodes.length, eligible.length]);
ok('every held-back node was eligible too', hiddenNodes.every((n) => eligible.indexOf(n) !== -1));
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
const hiddenBodyNode = findNode('Hidden text body');
ok('display:none text is not sent up front', !isCollected(hiddenBodyNode));
ok('display:none text is held back instead of dropped', hiddenNodes.indexOf(hiddenBodyNode) !== -1);
ok('hidden text is not translated while it is hidden', findNode('Hidden text body') === hiddenBodyNode);
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

// The order a run sends segments in. The <nav> sits at the top of the document,
// but it is page chrome: the article goes first, then its headings, then the
// chrome — and inside one class whatever is on screen before the rest.
const PR = ns.constants.PRIORITY_ROLES;
const ordered = segmenter.sortSegments(segs2);
const at = (text) => ordered.map((s) => s.text).indexOf(text);
ok('every segment carries its region and that region number',
  segs2.every((s) => s.priority === PR.indexOf(s.role)), segs2.map((s) => [s.role, s.priority]));
ok('article text is sent before the menu', at('Welcome to the product.') < at('Home'),
  [at('Welcome to the product.'), at('Home')]);
ok('a heading follows the body it heads', at('Welcome to the product.') < at('Getting Started'),
  [at('Welcome to the product.'), at('Getting Started')]);
ok('page chrome is last even though it comes first in the document',
  at('Home') > at('Getting Started') && at('Docs') > at('Getting Started'),
  [at('Home'), at('Docs'), at('Getting Started')]);
const priorities = ordered.map((s) => s.priority);
ok('the queue never goes back to a class it already passed',
  priorities.every((p, i) => i === 0 || priorities[i - 1] <= p), priorities);
const contentBands = ordered.filter((s) => s.role === 'content').map((s) => s.viewport);
ok('inside one class the viewport band still decides',
  contentBands.every((b, i) => i === 0 || contentBands[i - 1] <= b), contentBands);
const docIndexOf = (s) => textNodesOf(documentMock).indexOf(s.source.node);
const keptDocOrder = (() => {
  const last = new Map();
  for (const s of ordered) {
    const key = s.priority + ':' + s.viewport;
    const prev = last.get(key);
    if (prev !== undefined && docIndexOf(prev) > docIndexOf(s)) return false;
    last.set(key, s);
  }
  return true;
})();
ok('document order kept inside one class and band', keptDocOrder);
console.log('== priority: what region a text node sits in, and what waits ==');
const roleOfText = (text) => (segs2.filter((s) => s.text === text)[0] || {}).role;
ok('running-on text inside <main> is the article', roleOfText('Welcome to the product.') === 'content', roleOfText('Welcome to the product.'));
ok('a heading inside the article is still a heading', roleOfText('Getting Started') === 'heading', roleOfText('Getting Started'));
ok('a link inside <nav> is page chrome', roleOfText('Home') === 'navigation', roleOfText('Home'));
ok('nothing was left without a region', segs2.every((s) => !!s.role), segs2.map((s) => s.source.path));
const held = segmenter.buildSegmentsResult(documentMock);
const sentNow = segmenter.buildSegmentsResult(documentMock, { deferHidden: false });
ok('text the user could not see becomes no segment',
  !held.segments.some((s) => s.text === 'Hidden text body') && held.deferred.length === 1,
  [held.segments.length, held.deferred.length]);
ok('turning the deferral off sends the same text, marked hidden',
  sentNow.segments.some((s) => s.text === 'Hidden text body' && s.hidden === true) && sentNow.deferred.length === 0,
  [sentNow.segments.length, sentNow.deferred.length]);
ok('deferring is one segment fewer in the run', held.segments.length === sentNow.segments.length - 1);
ok('held-back text is last in the queue when it is sent at all',
  segmenter.sortSegments(sentNow.segments).slice(-1)[0].text === 'Hidden text body');
const st = held.stats;
ok('the run says what it held back', st.deferred === 1 && st.hiddenNodes === 1 && st.deferHidden === true, st);
ok('the role histogram covers every class in constants',
  PR.every((r) => st.roles[r] >= 0), st.roles);
const plan = ns.segmenter.sortSegments(held.segments);
ok('a run that holds text back still covers the whole visible page',
  plan.length === segs.filter((s) => s.text !== 'Hidden text body').length, [plan.length, segs.length]);
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

console.log('== reveal: text the user could not see, and then could ==');
// The held-back list is only worth keeping if the text comes back: a closed
// dropdown is translated when the reader opens it. This is the page-side half of
// that (content/content.js watches for the style/class change and re-asks).
const closedMenu = documentMock.querySelectorAll('div').filter((d) =>
  /display:none/.test(d.getAttribute('style') || ''))[0];
const closedNode = findNode('Hidden text body');
const vis = ns.priority.createVisibility(documentMock);
ok('priority: the closed subtree is hidden', vis.hidden(closedMenu) === true);
ok('priority: so is the text inside it', vis.hidden(closedNode.parentNode) === true);
const beforeOpen = extractor.extractTextNodesSplit(documentMock);
ok('the closed text is in the held-back list, not in the run',
  beforeOpen.hidden.indexOf(closedNode) !== -1 && beforeOpen.visible.indexOf(closedNode) === -1,
  [beforeOpen.visible.length, beforeOpen.hidden.length]);
closedMenu.setAttribute('style', 'display:block'); // the reader opened the menu
const afterOpen = extractor.extractTextNodesSplit(documentMock);
ok('once it is displayed it is collected as visible',
  afterOpen.visible.indexOf(closedNode) !== -1 && afterOpen.hidden.indexOf(closedNode) === -1);
const revealed = segmenter.buildSegments(documentMock).filter((s) => s.source.node === closedNode)[0];
ok('the revealed text is an ordinary segment now', !!revealed && revealed.hidden === false &&
  revealed.source.original === 'Hidden text body', revealed && [revealed.hidden, revealed.source.original]);
ok('and it knows what region it sits in', !!revealed && !!revealed.role, revealed && revealed.role);
const revealedWrite = renderer.applySegment(revealed, 'ヒミツノナオン');
ok('it is written into the same text node it was held back from',
  revealedWrite.ok === true && jp(closedNode.nodeValue));
renderer.restore(closedNode);
ok('restore puts the hidden original back', closedNode.nodeValue === 'Hidden text body');
const poorVis = ns.priority.createVisibility(documentMock, { maxHiddenChecks: 0 });
ok('past the CSS budget the answer is visible and it says so',
  poorVis.hidden(documentMock.querySelectorAll('main')[0]) === false && poorVis.stats().budgetHit === true, poorVis.stats());
const orphan = mkScratch('Orphan text here');
ok('a node the page threw away is not waited on for ever',
  ns.priority.createVisibility(documentMock).attached(orphan) === false);

// --- the orchestrator on top of the same page -----------------------------------
// Everything above asked a single module. This last section loads the orchestrator
// (content/content.js) over the same mini page with a fake extension that answers
// translation requests, and drives the one thing only the orchestrator owns: hold
// text back while the user cannot see it, and translate it when the page shows it.
console.log('== reveal watch: hidden text waits and is translated when displayed ==');

const stored = {};
const bg = { requests: 0, sent: [] }; // the fake worker: what it was asked to translate
function answerTranslate(msg, respond) {
  const wire = (msg && msg.batch && msg.batch.segments) || [];
  const results = {};
  wire.forEach((s) => {
    bg.requests++;
    bg.sent.push(s.text);
    // A translation with no Latin letters in it, so the page's own "is this
    // English?" rule refuses to collect it a second time.
    results[s.id] = { text: s.text, translatedText: 'ヒミツノモジ' };
  });
  setTimeout(() => respond({
    requestId: msg.id, status: 'success', results, translated: wire.length, failed: 0,
    cacheHits: 0, requests: 1, segments: wire.length, units: (msg.batch && msg.batch.units) || 1,
    elapsedMs: 1, profile: 'fake', endpoint: 'http://127.0.0.1:9/v1', strategy: 'multi'
  }), 0);
}
sandbox.chrome = {
  runtime: {
    id: 'test-extension', lastError: null,
    getManifest: () => ({ version: '0.1.0' }),
    // No connect() on purpose: the page then uses sendMessage per request, which
    // is the one path this fake can answer without a port pair.
    onMessage: { listeners: [], addListener(fn) { this.listeners.push(fn); } },
    sendMessage(msg, cb) {
      if (msg && msg.type === ns.constants.MSG_TRANSLATE) return answerTranslate(msg, cb || (() => {}));
      if (typeof cb === 'function') setTimeout(() => cb({ ok: true }), 0); // status pings
    }
  },
  storage: { local: { get: async () => Object.assign({}, stored), set: async (o) => Object.assign(stored, o) } }
};
sandbox.setInterval = setInterval; // the watcher's fallback poll (no MutationObserver here)
// The orchestrator's own log lines, kept so a failing expectation below can be
// read out with DOM_DEBUG=1 instead of being guessed at.
const infos = [];
sandbox.console.info = function () { infos.push(Array.prototype.join.call(arguments, ' ')); };
sandbox.console.warn = function () { infos.push('WARN ' + Array.prototype.join.call(arguments, ' ')); };
const debugLogs = (from) => {
  if (process.env.DOM_DEBUG) console.log(infos.slice(from || -30).join('\n'));
};
// The mini DOM above needed no real timers; the orchestrator does — it waits for
// the fake worker's answers through setTimeout, and stops its watcher through
// clearInterval/clearTimeout. All four must be the host's, not stubs.
sandbox.setTimeout = setTimeout;
sandbox.clearTimeout = clearTimeout;
sandbox.clearInterval = clearInterval;
const contentOrder = ['shared/messaging.js', 'shared/settings.js', 'api/profiles.js',
  'api/openai-client.js', 'translation/cache.js', 'content/content.js'];
for (const f of contentOrder) vm.runInContext(readFileSync(path.join(dir, f), 'utf8'), ctx, { filename: f });

const api = sandbox.window.__plamo;
const contentListener = sandbox.chrome.runtime.onMessage.listeners[0];
const send = (msg) => new Promise((resolve) => contentListener(msg, {}, resolve));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mainEl = documentMock.querySelectorAll('main')[0];
// A closed dropdown with two texts in it: exactly what must not cost a request
// while it is closed. `texts` keeps the Text nodes, because looking them up by
// value stops working once they are translated.
function closedBox(tag) {
  const box = E('div', { class: 'menu ' + tag, style: 'display:none' },
    E('a', { href: '#' }, 'Secret entry ' + tag), E('p', {}, 'Hidden until opened ' + tag));
  mainEl.appendChild(box);
  return { box, texts: box.childNodes.map((c) => c.firstChild) };
}
async function waitIdle(limit) {
  for (let i = 0; i < (limit || 80) && api.getState().phase !== 'idle'; i++) await sleep(10);
  return api.getState();
}
const putSettings = (patch) => sandbox.chrome.storage.local.set(patch);

(async function revealWatch() {
  const first = closedBox('a');
  const sentBefore = bg.sent.slice();
  await api.translatePage();
  await waitIdle();
  ok('a closed dropdown is left in English while it is closed',
    first.texts.every((n) => !jp(n.nodeValue) && /Secret entry|Hidden until/.test(n.nodeValue)),
    first.texts.map((t) => t.nodeValue));
  ok('and nothing of it went out in a request',
    !bg.sent.slice(sentBefore.length).some((t) => /Secret entry|Hidden until/.test(t)),
    bg.sent.slice(sentBefore.length).filter((t) => /Secret|Hidden/.test(t)));
  const st1 = api.getState();
  debugLogs();
  if (process.env.DOM_DEBUG) console.log('DBG applied=' + st1.applied + ' registry=' + renderer.appliedCount() +
    ' jpMain=' + jp(mainEl.textContent) + ' bgRequests=' + bg.requests);
  ok('the run says what it held back (both texts of the closed box)',
    st1.deferred === 2 && st1.waitingForDisplay === 2,
    [st1.deferred, st1.waitingForDisplay]);
  ok('the visible text of the page did go out, and getState() reports it',
    st1.applied > 0 && st1.applied === st1.renderedNodes && jp(mainEl.textContent),
    [st1.applied, st1.renderedNodes]);
  const held = api.getDeferred();
  ok('the waiting list names the text and says it is watching',
    held.waiting === 2 && held.watching === true && held.sample.length === 2 &&
    /Secret entry a/.test(held.sample.map((s) => s.text).join('|')), held);
  ok('the last scan reports the deferral too',
    api.getSegmentStats().deferred === 2 && api.getSegmentStats().deferHidden === true, api.getSegmentStats());

  // The reader opens the dropdown.
  first.box.setAttribute('style', 'display:block');
  const ready = api.revealNow();
  ok('the check a style change triggers finds the two displayed nodes', ready.length === 2, ready.length);
  await sleep(20);
  await waitIdle();
  ok('and they are translated by a run of their own', first.texts.every((n) => jp(n.nodeValue)),
    first.texts.map((t) => t.nodeValue));
  const afterReveal = bg.requests;
  const statsAfter = api.getDeferred();
  ok('nothing is waiting any more', statsAfter.waiting === 0 && statsAfter.stats.revealed >= 2, statsAfter);
  ok('revealing the same menu again costs nothing',
    api.revealNow().length === 0 && bg.requests === afterReveal, [api.revealNow().length, bg.requests]);
  // Stop means "no more requests": the watcher must not start a run of its own.
  const second = closedBox('b');
  await api.translatePage();
  await waitIdle();
  ok('the next run holds the new closed text back', api.getState().waitingForDisplay === 2,
    api.getState().waitingForDisplay);
  const stopped = await send({ type: ns.constants.MSG_STOP, id: 'stop-reveal' });
  ok('Stop keeps the waiting list but stops the watching',
    stopped.waitingForDisplay === 2 && api.getDeferred().watching === false,
    [stopped.waitingForDisplay, api.getDeferred().watching]);
  second.box.setAttribute('style', 'display:block');
  const requestsWhileStopped = bg.requests;
  const readyWhileStopped = api.revealNow();
  await sleep(20);
  ok('while Stop is in effect a displayed node is not translated',
    readyWhileStopped.length === 2 && bg.requests === requestsWhileStopped &&
    second.texts.every((n) => !jp(n.nodeValue)),
    [readyWhileStopped.length, bg.requests - requestsWhileStopped]);
  ok('and it goes back on the waiting list instead of being lost',
    api.getState().waitingForDisplay === 2, api.getState().waitingForDisplay);
  const sentBeforeNext = bg.sent.length;
  await api.translatePage(); // a fresh run clears the Stop
  await waitIdle();
  ok('the next run picks the waiting text up', second.texts.every((n) => jp(n.nodeValue)) &&
    bg.sent.slice(sentBeforeNext).filter((t) => /Secret entry b/.test(t)).length === 1,
    bg.sent.slice(sentBeforeNext).filter((t) => /Secret|Hidden/.test(t)));
  ok('a node that run translated is not left waiting to be revealed again',
    api.getState().waitingForDisplay === 0, api.getDeferred().sample.map((s) => s.text));

  // "Translate hidden text at once" has to mean exactly that.
  await putSettings({ plamo: { priority: { deferHidden: false } } });
  const third = closedBox('c');
  await api.translatePage();
  await waitIdle();
  ok('with deferHidden off the hidden text is translated in the same run',
    third.texts.every((n) => jp(n.nodeValue)) && api.getState().deferred === 0,
    [api.getState().deferred, third.texts.map((t) => t.nodeValue)]);
  ok('hidden text that run translated is not queued for a reveal',
    api.getState().waitingForDisplay === 0, api.getDeferred().sample.map((s) => s.text));
  await putSettings({ plamo: { priority: { deferHidden: true } } });

  const fourth = closedBox('d');
  await api.translatePage();
  await waitIdle();
  ok('a closed box is waited for again', api.getDeferred().waiting === 2, api.getDeferred());
  ok('forgetDeferred drops the waiting list', api.forgetDeferred() === 2 &&
    api.getDeferred().waiting === 0 && api.getDeferred().watching === false, api.getDeferred());
  const fifth = closedBox('e');
  await api.translatePage();
  await waitIdle();
  // forgetDeferred only drops the list; the closed text is still on the page, so
  // the next run holds both of the still-closed boxes back again.
  ok('a new run waits for every text still closed', api.getState().waitingForDisplay === 4,
    api.getDeferred().sample.map((s) => s.text));
  ok('the text that is being waited for was left in English',
    fifth.texts.every((n) => !jp(n.nodeValue)), fifth.texts.map((t) => t.nodeValue));
  api.restoreAll();
  ok('and restoreAll() clears what was being waited for',
    api.getState().waitingForDisplay === 0 && fifth.texts.every((n) => !jp(n.nodeValue)) &&
    renderer.appliedCount() === 0 && !jp(first.texts[0].nodeValue),
    [api.getState().waitingForDisplay, renderer.appliedCount(), first.texts[0].nodeValue]);
  await sleep(30); // give the fallback poll a chance to show any stray request
  ok('the watcher is quiet once nothing is waiting', api.getDeferred().watching === false, api.getDeferred());

})().then(finish, function (err) {
  fail++;
  console.log('  FAIL reveal watch section threw: ' + ((err && err.stack) || err));
  finish();
});

function finish() {
  console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
}

