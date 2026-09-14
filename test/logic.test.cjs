// test/logic.test.cjs
// Loads the classic-script modules in dependency order into a shared
// globalThis.__PLAMO__ namespace (vm context) and asserts the core logic.
//
// Multi-segment request coverage: a batch prompt is one line per segment, the
// answer is mapped back by line count, and a line-count mismatch is retried with
// numbers and finally re-requested one segment per request — never guessed. The
// background tests count real POSTs, so a regression that silently turns one
// batch back into N requests fails here instead of in the browser.
// Run: node test/logic.test.cjs

const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const dir = '/mnt/240GB01/chrome_addon/In-place-JP-Translator';
const order = [
  'shared/logger.js','shared/constants.js','shared/messaging.js','shared/settings.js',
  'api/profiles.js','api/openai-client.js','translation/scheduler.js','translation/cache.js',
  'translation/batcher.js','translation/queue.js','content/extractor.js',
  'content/segmenter.js','content/renderer.js','background/background.js',
  'content/content.js','popup/popup.js'
];

const _d = {};
// Minimal extension emulation: onMessage listeners are recorded (so a test can
// call them the way Chrome would) and runtime.sendMessage from a content script
// is routed to the background listener, including the "port closed" case that
// happens when a listener answers asynchronously without returning true.
const chromeFake = {
  storage: { local: { get: async () => Object.assign({}, _d), set: async (o) => { Object.assign(_d, o); } } },
  runtime: {
    id: 'test-extension',
    lastError: null,
    onMessage: { listeners: [], addListener(fn) { this.listeners.push(fn); } },
    onInstalled: { addListener() {} },
    getManifest: () => ({ version: '0.1.0' }),
    sendMessage(msg, cb) {
      const target = chromeFake.runtime.onMessage.listeners[bag.bgListenerIndex];
      if (!target) return;
      let answered = false;
      const keepOpen = target(msg, { id: 'test-extension' }, (payload) => {
        if (answered) return;
        answered = true;
        chromeFake.runtime.lastError = null;
        if (cb) setTimeout(() => cb(payload), 0);
      });
      if (!answered && keepOpen !== true) {
        chromeFake.runtime.lastError = { message: 'The message port closed before a response was received.' };
        if (cb) setTimeout(() => cb(undefined), 0);
      }
    }
  },
  tabs: { query: (_q, cb) => cb([{ id: 1 }]), sendMessage(tabId, msg, cb) { cb(undefined); } }
};
const bag = { bgListenerIndex: -1, listenerCounts: {} };

// Fake API server: records the last fetch call so the client's resolved URL and
// request body can be asserted, and can be flipped into failure modes.
const server = { mode: 'ok', last: null, calls: 0 };
function resetServer(mode) { server.mode = mode || 'ok'; server.last = null; server.calls = 0; }

const sandbox = {
  console, performance: globalThis.performance, Map, Set, Promise, Object,
  Number, JSON, parseInt, Math, AbortController, setTimeout, clearTimeout,
  fetch: async (url, opts) => {
    server.calls++;
    server.last = { url, opts, body: (opts && opts.body) ? JSON.parse(opts.body) : null };
    if (server.mode === 'http_error') return { ok: false, status: 500, statusText: 'Internal Server Error', text: async () => 'no such endpoint' };
    if (server.mode === 'json_error') return { ok: true, json: async () => { throw new Error('not json'); }, text: async () => 'not json' };
    if (server.mode === 'empty') return { ok: true, json: async () => ({ choices: [{ message: { content: '' }, finish_reason: 'length' }] }), text: async () => '' };
    if (server.mode === 'connection') throw new Error('Connection refused');
    if (server.mode === 'hang') return new Promise((_resolve, reject) => { const sig = opts && opts.signal; if (sig) sig.addEventListener('abort', () => reject(new Error('aborted'))); });
    // Answers a multi-segment prompt the way a translation model that keeps the
    // line structure does: one line per input line.
    if (server.mode === 'echo_lines') {
      const b = server.last.body || {};
      const sent = b.messages ? b.messages[b.messages.length - 1].content : b.prompt;
      const out = String(sent).split('\n').map((l, i) => 'YAKU' + i + ' ' + l).join('\n');
      return { ok: true, json: async () => ({ choices: [{ message: { content: out }, finish_reason: 'stop' }] }), text: async () => '' };
    }
    // Ignores the line structure on purpose: one line back for a many-line prompt.
    if (server.mode === 'one_line') return { ok: true, json: async () => ({ choices: [{ message: { content: 'こんにちは世界' }, finish_reason: 'stop' }] }), text: async () => '' };
    if (server.mode === 'completions') return { ok: true, json: async () => ({ choices: [{ text: 'こんにちは世界', finish_reason: 'stop' }] }), text: async () => '' };
    return { ok: true, json: async () => ({ choices: [{ message: { content: 'こんにちは世界' }, finish_reason: 'stop' }] }), text: async () => '' };
  },
  chrome: chromeFake,
  window: {}, document: { createTreeWalker: () => ({ nextNode: () => null }), addEventListener: () => {} },
  importScripts: () => {}
};
sandbox.globalThis = sandbox;
const ctx = vm.createContext(sandbox);
for (const f of order) {
  vm.runInContext(readFileSync(path.join(dir, f), 'utf8'), ctx, { filename: f });
  bag.listenerCounts[f] = chromeFake.runtime.onMessage.listeners.length;
}
bag.bgListenerIndex = bag.listenerCounts['background/background.js'] - 1;
bag.contentListenerIndex = chromeFake.runtime.onMessage.listeners.length - 1;
const bgListener = chromeFake.runtime.onMessage.listeners[bag.bgListenerIndex];
const contentListener = chromeFake.runtime.onMessage.listeners[bag.contentListenerIndex];

const ns = sandbox.globalThis.__PLAMO__;
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.log('  FAIL' + name); } };

async function main() {
  console.log('== modules loaded ==');
  ['logger','constants','messaging','settings','profiles','openaiClient','Semaphore','SessionCache','createBatcher','Queue','extractor','segmenter','renderer','background'].forEach(k => ok('ns.' + k, typeof ns[k] !== 'undefined'));

  console.log('== estimateTokens ==');
  const est = ns.segmenter.estimateTokens;
  ok('empty', est('') === 0); ok('one letter', est('a') === 1); ok('short', est('Hello') === 2); ok('longer', est('The quick brown fox') === 5);

  console.log('== isLikelyEnglish ==');
  ok('en phrase', ns.segmenter.isLikelyEnglish('Version 2.1 supports Linux.') === true);
  ok('en sentence', ns.segmenter.isLikelyEnglish('OpenAI released GPT-X today.') === true);
  ok('jp only', ns.segmenter.isLikelyEnglish('これはテストです。') === false);
  ok('digits only', ns.segmenter.isLikelyEnglish('2024') === false);
  ok('mixed ok', ns.segmenter.isLikelyEnglish('GPT-4 出力') === true); ok('empty', ns.segmenter.isLikelyEnglish('') === false);

  console.log('== batcher bounds ==');
  const b = ns.createBatcher({ maxSegmentsPerBatch: 3, maxEstimatedTokensPerBatch: 10, charPerToken: 4 });
  const segs = [];
  for (let i = 0; i < 20; i++) { let t = i % 3 === 0 ? 'x'.repeat(20) : 'y'; segs.push({ text: t, estimatedTokens: b.estimateTokens(t), id: i, source: {} }); }
  const batches = b.batch(segs);
  batches.forEach((bt, i) => { ok('batch ' + i + ' count<=3', bt.segments.length <= 3); ok('batch ' + i + ' tokens<=10', bt.estimatedTokens <= 10); });
  ok('all placed', batches.reduce((a, bt) => a + bt.segments.length, 0) === 20);
  const big = ns.createBatcher({ maxSegmentsPerBatch: 16, maxEstimatedTokensPerBatch: 100 });
  const bigB = big.batch([{ text: 'z'.repeat(200), estimatedTokens: big.estimateTokens('z'.repeat(200)), id: 1, source: {} }]);
  ok('oversized own batch', bigB.length === 1 && bigB[0].segments.length === 1);

  console.log('== batcher packs blocks into requests (one request per batch) ==');
  // One <p> cut into 3 fragments by inline tags, then 8 menu items (each its own
  // block, all in the same container).
  const structSegs = [];
  for (let i = 0; i < 3; i++) structSegs.push({ id: 'p' + i, text: 'paragraph fragment number ' + i, block: 'b1', container: 'c1', source: {} });
  for (let i = 0; i < 8; i++) structSegs.push({ id: 'm' + i, text: 'Menu item ' + i, block: 'b' + (2 + i), container: 'c0', source: {} });
  const pb = ns.createBatcher({ maxSegmentsPerBatch: 48, maxEstimatedTokensPerBatch: 3000, firstBatchMaxSegments: 48, charPerToken: 4 });
  const pUnits = pb.units(structSegs);
  const pBatches = pb.batchUnits(structSegs);
  ok('paragraph fragments are one unit', pUnits.length === 9 && pUnits[0].segments.length === 3);
  ok('11 blocks packed into 1 request', pBatches.length === 1 && pBatches[0].segments.length === 11, pBatches.map((b) => b.segments.length));
  ok('batch reports its block count', pBatches[0].units === 9);
  const tight = ns.createBatcher({ maxSegmentsPerBatch: 4, maxEstimatedTokensPerBatch: 100000, firstBatchMaxSegments: 4 });
  const tightB = tight.batchUnits(structSegs);
  ok('segment cap still respected', tightB.every((b) => b.segments.length <= 4) &&
    tightB.reduce((a, b) => a + b.segments.length, 0) === 11, tightB.map((b) => b.segments.length));
  const tightHead = tight.batchUnits(structSegs.slice(0, 5))[0].segments.map((s) => s.id).join(',');
  ok('a block is never split below its own size', tightHead === 'p0,p1,p2,m0', tightHead);
  // First-batch cap: the visible area should not wait for a full-sized request.
  const firstSmall = ns.createBatcher({ maxSegmentsPerBatch: 48, maxEstimatedTokensPerBatch: 100000, firstBatchMaxSegments: 2 });
  const fsPlain = firstSmall.batchUnits(structSegs.map((s) => ({ id: s.id, text: s.text, source: {} })));
  ok('first batch stays small, later ones go out big',
    fsPlain.length === 2 && fsPlain[0].segments.length === 2 && fsPlain[1].segments.length === 9,
    fsPlain.map((b) => b.segments.length));
  const fsBlocks = firstSmall.batchUnits(structSegs);
  ok('a block bigger than the first cap is not split', fsBlocks[0].segments.length === 3 && fsBlocks[1].segments.length === 8,
    fsBlocks.map((b) => b.segments.length));
  const noBlocks = ns.createBatcher({ maxSegmentsPerBatch: 3, maxEstimatedTokensPerBatch: 100000 });
  const nb = noBlocks.batchUnits(structSegs.map((s) => ({ id: s.id, text: s.text, source: {} })));
  ok('segments without block info still pack', nb.length === 4 && nb[0].segments.length === 3);
  const oneSeg = ns.createBatcher({ maxSegmentsPerBatch: 1, maxEstimatedTokensPerBatch: 100000 });
  ok('a tight popup setting survives the first-batch cap', oneSeg.caps().firstBatchMaxSegments === 1, oneSeg.caps());
  ok('one segment per request, except a paragraph that needs 3',
    oneSeg.batchUnits(structSegs).map((b) => b.segments.length).join(',') === '3,1,1,1,1,1,1,1,1',
    oneSeg.batchUnits(structSegs).map((b) => b.segments.length));
  ok('the packer reports its own caps', ns.createBatcher({ maxSegmentsPerBatch: 7, maxEstimatedTokensPerBatch: 90,
    firstBatchMaxSegments: 3, charPerToken: 5 }).caps().maxSegmentsPerBatch === 7);

  console.log('== semaphore ==');
  async function testConcurrency(max, n) { const sem = new ns.Semaphore(max); var maxObs = 0, active = 0;
    const p = Array.from({ length: n }, (_, i) => sem.run(() => new Promise((res) => { active++; if (active > maxObs) maxObs = active; setTimeout(() => { active--; res(i); }, 5); })));
    await Promise.all(p); return maxObs; }
  for (const c of [1,2,4,8]) { const o = await testConcurrency(c, 20); ok('conc <= '+c, o <= c); ok('conc reached '+c, o === c); }

  console.log('== semaphore setMax (popup concurrency setting) ==');
  const semTuned = new ns.Semaphore(1);
  const tunedInfo = semTuned.setMax(4);
  ok('setMax reports prev/max', tunedInfo.prev === 1 && tunedInfo.max === 4 && semTuned.getMax() === 4);
  ok('setMax ignores junk values', semTuned.setMax(0).max === 4 && semTuned.setMax('x').max === 4);
  async function runWithLimit(sem, n) {
    let active = 0, maxObserved = 0;
    await Promise.all(Array.from({ length: n }, () => sem.run(() => new Promise((res) => {
      active++; if (active > maxObserved) maxObserved = active;
      setTimeout(() => { active--; res(); }, 3);
    }))));
    return maxObserved;
  }
  const tunedObserved = await runWithLimit(semTuned, 12);
  ok('raised limit enforced', tunedObserved <= 4 && tunedObserved >= 2);

  console.log('== settings ==');
  await chromeFake.storage.local.set({ plamo: { profileName: 'local-plamo2', maxConcurrent: 3, batch: { maxSegmentsPerBatch: 8 } } });
  const s = await ns.settings.loadSettings();
  ok('profile', s.profileName === 'local-plamo2'); ok('batch override', s.batch.maxSegmentsPerBatch === 8); ok('maxConcurrent clamp 3->4', s.maxConcurrent === 4);
  ok('isModeSupported single', ns.settings.isModeSupported('single') === true); ok('isModeSupported fallback', ns.settings.isModeSupported('fallback') === true);
  const dflt = ns.settings.defaultSettings();
  ok('request packing defaults present', dflt.request.strategy === ns.constants.REQUEST_SETTINGS.strategy &&
    dflt.request.format === 'line' && dflt.request.retryWithNumbers === true);
  ok('batch segment caps default', dflt.batch.maxSegmentsPerBatch === ns.constants.BATCH_SETTINGS.maxSegmentsPerBatch &&
    dflt.batch.firstBatchMaxSegments === ns.constants.BATCH_SETTINGS.firstBatchMaxSegments);
  ok('clampStrategy junk falls back', ns.settings.clampStrategy('nonsense') === ns.constants.REQUEST_SETTINGS.strategy &&
    ns.settings.clampStrategy(undefined) === ns.constants.REQUEST_SETTINGS.strategy);
  ok('clampStrategy single kept', ns.settings.clampStrategy('single') === 'single');

  console.log('== profiles (base url + endpoint) ==');
  const evo = ns.profiles.getProfile('evo-x2-plamo2');
  const local = ns.profiles.getProfile('local-plamo2');
  ok('evo base url', evo.url === 'http://192.168.50.28:8080/v1');
  ok('local base url', local.url === 'http://127.0.0.1:8080/v1');
  ok('models set (names live in profiles.js)', typeof evo.model === 'string' && evo.model.length > 0 && typeof local.model === 'string' && local.model.length > 0);
  ok('unknown profile falls back', ns.profiles.getProfile('nope').name === ns.profiles.profileNames()[0]);
  ok('resolve chat endpoint', ns.profiles.resolveEndpointUrl(local) === 'http://127.0.0.1:8080/v1/chat/completions');
  ok('resolve completions endpoint', ns.profiles.resolveEndpointUrl({ url: 'http://127.0.0.1:8080/v1/', endpoint: 'completions' }) === 'http://127.0.0.1:8080/v1/completions');
  ok('default endpoint when unset', ns.profiles.resolveEndpointUrl({ url: 'http://h:1/v1' }) === 'http://h:1/v1/chat/completions');
  ok('already-full url kept', ns.profiles.resolveEndpointUrl({ url: 'http://h:1/v1/chat/completions' }) === 'http://h:1/v1/chat/completions');
  ok('describeProfile logs resolved url', ns.profiles.describeProfile(evo).includes('http://192.168.50.28:8080/v1/chat/completions'));

  console.log('== openai client request shape ==');
  resetServer('ok');
  const rOk = await ns.openaiClient.translateSegment(local, { id: 'seg-0', text: 'Hello world' }, { timeoutMs: 5000 });
  ok('segment translated', rOk.translatedText === 'こんにちは世界');
  ok('POST to resolved endpoint', server.last.url === 'http://127.0.0.1:8080/v1/chat/completions');
  ok('method POST', server.last.opts.method === 'POST');
  ok('model taken from profile', server.last.body.model === local.model);
  ok('segment text sent as user message', server.last.body.messages[server.last.body.messages.length - 1].content === 'Hello world');
  ok('no system message while systemPrompt empty', !server.last.body.messages.some((m) => m.role === 'system'));
  ok('max_tokens omitted (max_tokens:0 truncated)', server.last.body.max_tokens === undefined);
  ok('no Authorization while apiKey empty', !('Authorization' in server.last.opts.headers));
  ok('AbortSignal attached', !!(server.last.opts.signal && server.last.opts.signal.aborted === false));

  resetServer('completions');
  const compProfile = { name: 'local-completions', url: 'http://127.0.0.1:8080/v1', model: 'plamo-2-translate', apiKey: 'k', systemPrompt: 'Translate to Japanese.', endpoint: 'completions' };
  const rComp = await ns.openaiClient.translateSegment(compProfile, { id: 'seg-1', text: 'Hi' }, {});
  ok('endpoint path from profile.endpoint', server.last.url === 'http://127.0.0.1:8080/v1/completions');
  ok('completions body sends prompt', server.last.body.prompt === 'Hi' && server.last.body.messages === undefined);
  ok('no stop sequence by default', server.last.body.stop === undefined);
  ok('completions response parsed', rComp.translatedText === 'こんにちは世界');
  ok('Authorization sent when apiKey set', server.last.opts.headers.Authorization === 'Bearer k');
  ok('endpointKind', ns.openaiClient.endpointKind(compProfile) === 'completions' && ns.openaiClient.endpointKind(local) === 'chat/completions');
  ok('extractOutputText completions', ns.openaiClient.extractOutputText({ choices: [{ text: 'ok' }] }, 'completions') === 'ok');
  ok('extractOutputText chat', ns.openaiClient.extractOutputText({ choices: [{ message: { content: 'ok' } }] }, 'chat/completions') === 'ok');

  resetServer('ok');
  const sysProfile = Object.assign({}, local, { name: 'with-system', systemPrompt: 'Translate to Japanese.' });
  await ns.openaiClient.translateSegment(sysProfile, { id: 'seg-8', text: 'Hello' }, {});
  ok('system message only when systemPrompt set', server.last.body.messages.length === 2 &&
    server.last.body.messages[0].role === 'system' && server.last.body.messages[0].content === 'Translate to Japanese.');

  console.log('== openai client error classes ==');
  resetServer('http_error');
  const rHttp = await ns.openaiClient.translateSegment(local, { id: 'seg-2', text: 'x' }, {});
  ok('http_error', rHttp.errorType === 'http_error' && /500/.test(rHttp.error));
  resetServer('json_error');
  const rJson = await ns.openaiClient.translateSegment(local, { id: 'seg-3', text: 'x' }, {});
  ok('json_error', rJson.errorType === 'json_error');
  resetServer('empty');
  const rEmpty = await ns.openaiClient.translateSegment(local, { id: 'seg-4', text: 'x' }, {});
  ok('empty_response', rEmpty.errorType === 'empty_response');
  resetServer('connection');
  const rConn = await ns.openaiClient.translateSegment(local, { id: 'seg-5', text: 'x' }, {});
  ok('connection', rConn.errorType === 'connection');
  resetServer('hang');
  const rTimeout = await ns.openaiClient.translateSegment(local, { id: 'seg-6', text: 'x' }, { timeoutMs: 10 });
  ok('timeout', rTimeout.errorType === 'timeout');
  const rCfg = await ns.openaiClient.translateSegment({ name: 'broken', url: '' }, { id: 'seg-7', text: 'x' }, {});
  ok('config (empty base url)', rCfg.errorType === 'config');

  console.log('== multi-segment request: prompt shape + line alignment ==');
  const bSegs = [{ id: 'a', text: 'First\n   line' }, { id: 'b', text: '  Second line  ' }];
  const bLine = ns.openaiClient.buildBatchPrompt(bSegs);
  ok('one prompt line per segment, newlines collapsed', bLine.text === 'First line\nSecond line' && bLine.lines === 2);
  ok('default prompt format is line', bLine.format === 'line');
  ok('numbered format numbers from 1',
    ns.openaiClient.buildBatchPrompt(bSegs, { format: 'numbered' }).text === '1. First line\n2. Second line');
  const sc = ns.openaiClient.splitBatchOutput('yakukurai\nyakusan', 2);
  ok('equal line count aligns', sc.status === 'aligned' && sc.lines[1] === 'yakusan' && sc.usedNumbers === false);
  ok('too many lines is a mismatch, not a guess', ns.openaiClient.splitBatchOutput('a\nb\nc', 2).status === 'mismatch');
  ok('too few lines is a mismatch', ns.openaiClient.splitBatchOutput('a', 2).status === 'mismatch');
  ok('empty answer is a mismatch', ns.openaiClient.splitBatchOutput('', 2).status === 'mismatch');
  ok('blank lines in the answer are ignored', ns.openaiClient.splitBatchOutput('a\n\n\nb', 2).status === 'aligned');
  const fenced = ns.openaiClient.splitBatchOutput('```ja\na\nb\n```', 2);
  ok('a code fence is unwrapped before splitting', fenced.status === 'aligned' && fenced.lines[0] === 'a', fenced.lines);
  const numbered = ns.openaiClient.splitBatchOutput('1. a\n2. b', 2);
  ok('numbering is trusted and stripped', numbered.status === 'aligned' && numbered.usedNumbers === true &&
    numbered.lines[0] === 'a', numbered.lines);
  const reordered = ns.openaiClient.splitBatchOutput('2. b\n1. a', 2);
  ok('numbering fixes a reordered answer', reordered.status === 'aligned' && reordered.lines.join(',') === 'a,b',
    reordered.lines);
  const dupNum = ns.openaiClient.splitBatchOutput('1. a\n1. b', 2);
  ok('duplicate numbering falls back to position', dupNum.status === 'aligned' && dupNum.usedNumbers === false &&
    dupNum.lines.join(',') === 'a,b', dupNum.lines);
  const outNum = ns.openaiClient.splitBatchOutput('9. a\n8. b', 2);
  ok('out-of-range numbering falls back to position', outNum.status === 'aligned' && outNum.lines.join(',') === 'a,b',
    outNum.lines);

  resetServer('echo_lines');
  const tsMulti = await ns.openaiClient.translateSegments(local, [{ id: 'a', text: 'One' }, { id: 'b', text: 'Two' }], { timeoutMs: 5000 });
  ok('two segments cost one request', server.calls === 1 && tsMulti.status === 'aligned' && tsMulti.sent === 2, server.calls);
  ok('both segments went out on their own line',
    server.last.body.messages[server.last.body.messages.length - 1].content === 'One\nTwo');
  ok('each segment got its own line back', tsMulti.results.a.translatedText === 'YAKU0 One' &&
    tsMulti.results.b.translatedText === 'YAKU1 Two');
  resetServer('one_line');
  const tsMis = await ns.openaiClient.translateSegments(local, [{ id: 'a', text: 'One' }, { id: 'b', text: 'Two' }], { timeoutMs: 5000 });
  ok('a one-line answer to a two-segment prompt is a mismatch', tsMis.status === 'mismatch' && tsMis.got === 1);
  ok('nothing is placed on a mismatch', tsMis.results.a.errorType === 'align' && tsMis.results.b.errorType === 'align' &&
    tsMis.results.a.translatedText === undefined);
  resetServer('connection');
  const tsErr = await ns.openaiClient.translateSegments(local, [{ id: 'a', text: 'One' }, { id: 'b', text: 'Two' }], {});
  ok('a transport failure is reported once for the batch', tsErr.status === 'error' && tsErr.errorType === 'connection' &&
    Object.keys(tsErr.results).length === 0);
  resetServer('ok');
  const tsEmpty = await ns.openaiClient.translateSegments(local, [], {});
  ok('an empty batch sends no request', tsEmpty.status === 'empty' && server.calls === 0);

  console.log('== logger ring buffer (diagnostics) ==');
  ns.logger.clearLogs();
  ns.logger.log.trace('trace-marker');
  ns.logger.log.debug('debug-marker');
  ns.logger.log.warn('warn-marker');
  const markerLogs = ns.logger.getLogs({ contains: 'marker' });
  ok('trace records stored', markerLogs.length === 3);
  ok('levels recorded', markerLogs.map(r => r.level).join(',') === 'trace,debug,warn');
  ok('level filter', ns.logger.getLogs({ level: 'warn' }).every(r => r.level === 'warn'));
  ok('limit keeps the newest', ns.logger.getLogs({ limit: 2 }).length === 2);
  ok('stats', ns.logger.stats().stored === 3 && ns.logger.stats().counts.trace === 1);
  const circ = { name: 'root' }; circ.self = circ;
  ok('describe handles circular', ns.logger.describe(circ).includes('[Circular]'));
  ok('describe labels DOM nodes', ns.logger.describe({ nodeType: 1, nodeName: 'P', textContent: 'hi' }).startsWith('[DOM p'));
  ok('describe labels Maps', ns.logger.describe(new Map([['a', 1]])).includes('Map size=1'));

  console.log('== messaging wire helpers (serialization traps) ==');
  const domish = { nodeType: 1, nodeName: 'P', textContent: 'Hello' };
  const segWire = { id: 7, text: 'Hello', estimatedTokens: 2, viewport: 1, source: { element: domish, text: 'Hello' } };
  const wireBatch = ns.messaging.toWireBatch({ segments: [segWire], estimatedTokens: 2 });
  ok('wire batch drops element refs', wireBatch.segments.length === 1 && !('source' in wireBatch.segments[0]));
  ok('wire batch keeps ids and text', wireBatch.segments[0].id === 7 && wireBatch.segments[0].text === 'Hello');
  const wireSession = new ns.SessionCache();
  wireSession.set('Hello', 'こんにちは');
  const wireCache = ns.messaging.toWireCache(wireSession, [{ text: 'Hello' }, { text: 'NotCached' }]);
  const wireJson = JSON.parse(JSON.stringify(wireCache));
  ok('wire cache survives JSON serialization', wireJson.Hello === 'こんにちは' && Object.keys(wireJson).length === 1);
  ok('wire cache limited to this batch', Object.keys(wireCache).length === 1);
  ok('toWireCache survives a missing cache', Object.keys(ns.messaging.toWireCache(null, [{ text: 'x' }])).length === 0);
  const traps = ns.messaging.findUnserializable({ cache: wireSession.map, segs: [segWire], fn: function () {}, set: new Set([1]) });
  const trapAt = (key) => traps.filter(t => t.path.endsWith('.' + key))[0];
  ok('detects a Map on the wire', !!trapAt('cache') && /Map/.test(trapAt('cache').kind));
  ok('detects a Set on the wire', !!trapAt('set') && /Set/.test(trapAt('set').kind));
  ok('detects a DOM node on the wire', traps.some(t => t.kind.startsWith('dom-node')));
  ok('detects a function on the wire', !!trapAt('fn') && trapAt('fn').kind === 'function');
  // A Map arrives as "{}" after serialization: exactly the payload that crashed.
  const normalizedEmpty = ns.messaging.normalizeCache({});
  ok('object cache: safe, no hit', normalizedEmpty.form === 'object' && normalizedEmpty.has('Hello') === false);
  const normalizedHit = ns.messaging.normalizeCache({ Hello: 'こんにちは' });
  ok('object cache: hit and value', normalizedHit.has('Hello') === true && normalizedHit.get('Hello') === 'こんにちは');
  ok('Map cache still supported', ns.messaging.normalizeCache(new Map([['k', 'v']])).get('k') === 'v');
  ok('missing cache is safe', ns.messaging.normalizeCache(undefined).has('x') === false);
  ok('summarizeResults samples failures', ns.messaging.summarizeResults({ 1: { translatedText: 'a' }, 2: { error: 'boom', errorType: 'http_error' } }).text.includes('http_error'));
  ok('hint explains a closed port', ns.messaging.hintFor('The message port closed before a response was received.').includes('hint'));

  console.log('== background message handler (regression: cache + async reply) ==');
  ok('background listener registered', typeof bgListener === 'function');
  function bgCall(msg) {
    return new Promise((resolve) => {
      let payload = 'NO-RESPONSE';
      const returned = bgListener(msg, { id: 'test-extension' }, (p) => { payload = p; });
      setTimeout(() => resolve({ returned, payload }), 60);
    });
  }
  resetServer('ok');
  const okCall = await bgCall({
    type: ns.constants.MSG_TRANSLATE, id: 'bg-ok', profileName: 'local-plamo2',
    batch: { estimatedTokens: 3, segments: [{ id: 1, text: 'Hello world', estimatedTokens: 3, viewport: 1 }] },
    concurrency: 2, timeoutMs: 5000, cache: {}
  });
  ok('async reply keeps the port open (returns true)', okCall.returned === true);
  ok('response actually arrives', okCall.payload !== 'NO-RESPONSE' && okCall.payload.status === 'success');
  ok('per-segment result', okCall.payload.results['1'].translatedText === 'こんにちは世界');
  ok('request id echoed', okCall.payload.requestId === 'bg-ok');
  ok('resolved endpoint reported', okCall.payload.endpoint === 'http://127.0.0.1:8080/v1/chat/completions');

  server.last = null;
  const hitCall = await bgCall({
    type: ns.constants.MSG_TRANSLATE, id: 'bg-hit', profileName: 'local-plamo2',
    batch: { estimatedTokens: 3, segments: [{ id: 2, text: 'Hello world', estimatedTokens: 3, viewport: 1 }] },
    concurrency: 2, timeoutMs: 5000, cache: { 'Hello world': 'キャッシュ' }
  });
  ok('plain-object cache hit, no network call', hitCall.payload.cacheHits === 1 && server.last === null);
  ok('cache hit flagged in the result', hitCall.payload.results['2'].cached === true && hitCall.payload.results['2'].translatedText === 'キャッシュ');

  const badCall = await bgCall({ type: ns.constants.MSG_TRANSLATE, id: 'bg-bad', profileName: 'local-plamo2' });
  ok('missing batch rejected with a config error', badCall.payload.errorType === 'config' && badCall.payload.status === 'failure');
  ok('rejected request is still answered', badCall.returned === true && badCall.payload.requestId === 'bg-bad');

  resetServer('http_error');
  const errCall = await bgCall({
    type: ns.constants.MSG_TRANSLATE, id: 'bg-err', profileName: 'local-plamo2',
    batch: { estimatedTokens: 1, segments: [{ id: 3, text: 'Boom', estimatedTokens: 1, viewport: 1 }] }, timeoutMs: 5000
  });
  ok('http failure isolated to its segment', errCall.payload.status === 'failure' && errCall.payload.results['3'].errorType === 'http_error');
  ok('failure written to the log ring buffer', ns.logger.getLogs({ contains: 'FAILED http_error' }).length >= 1);

  resetServer('ok');
  const concCall = await bgCall({
    type: ns.constants.MSG_TRANSLATE, id: 'bg-conc', profileName: 'local-plamo2',
    batch: { estimatedTokens: 1, segments: [{ id: 4, text: 'Conc', estimatedTokens: 1, viewport: 1 }] }, concurrency: 4, timeoutMs: 5000
  });
  ok('popup concurrency retunes the shared limiter', ns.background.semaphore.getMax() === 4);
  ok('batch after the retune still succeeded', concCall.payload.status === 'success');

  const pingCall = await bgCall({ type: ns.constants.MSG_PING, id: 'bg-ping' });
  ok('ping answered synchronously', pingCall.returned === false && pingCall.payload.pong === true);
  const diagCall = await bgCall({ type: ns.constants.MSG_DIAGNOSTICS, id: 'bg-diag', limit: 5 });
  ok('diagnostics returns logs and state', Array.isArray(diagCall.payload.logs) && diagCall.payload.logs.length <= 5 && !!diagCall.payload.state);
  const unkCall = await bgCall({ type: 'not-a-type', id: 'bg-unk' });
  ok('unknown type answered with handledTypes', /unknown message type/.test(unkCall.payload.error) && unkCall.returned === false);

  console.log('== background: packing many segments into one request ==');
  const threeSegs = [
    { id: 'm1', text: 'First line', estimatedTokens: 4, viewport: 1 },
    { id: 'm2', text: 'Second line', estimatedTokens: 4, viewport: 1 },
    { id: 'm3', text: 'Third line', estimatedTokens: 4, viewport: 1 }
  ];
  function bgBatch(id, strategy, mode) {
    resetServer(mode);
    return bgCall({
      type: ns.constants.MSG_TRANSLATE, id: id, profileName: 'local-plamo2', strategy: strategy,
      batch: { estimatedTokens: 12, units: 2, segments: threeSegs.map((s) => Object.assign({}, s)) },
      concurrency: 2, timeoutMs: 5000, cache: {}
    }).then((r) => ({ r, calls: server.calls, sent: server.last ? server.last.body.messages.slice(-1)[0].content : '' }));
  }
  const multiRun = await bgBatch('bg-multi', 'multi', 'echo_lines');
  ok('3 segments cost 1 request', multiRun.calls === 1, multiRun.calls);
  ok('the batch went out as 3 prompt lines', multiRun.sent === 'First line\nSecond line\nThird line', multiRun.sent);
  ok('multi strategy and request count reported', multiRun.r.payload.strategy === 'multi' && multiRun.r.payload.requests === 1);
  ok('each segment answered from its own line', multiRun.r.payload.results.m1.translatedText === 'YAKU0 First line' &&
    multiRun.r.payload.results.m3.translatedText === 'YAKU2 Third line');
  ok('alignment counted once, nothing failed', multiRun.r.payload.align.aligned === 1 && multiRun.r.payload.failed === 0 &&
    multiRun.r.payload.translated === 3);

  const misRun = await bgBatch('bg-mis', 'multi', 'one_line');
  ok('a mismatch retried numbered, then fell back per segment', misRun.calls === 5, misRun.calls);
  ok('retry + mismatch + fallback all logged in align', misRun.r.payload.align.retried === 1 &&
    misRun.r.payload.align.mismatch === 1 && misRun.r.payload.align.fallback === 3, misRun.r.payload.align);
  ok('every segment still translated by the fallback', misRun.r.payload.translated === 3 && misRun.r.payload.failed === 0 &&
    misRun.r.payload.results.m2.translatedText === 'こんにちは世界', misRun.r.payload.results.m2);
  ok('fallback requests counted', misRun.r.payload.requests === 5, misRun.r.payload.requests);

  const singleRun = await bgBatch('bg-single', 'single', 'echo_lines');
  ok('strategy single sends one request per segment', singleRun.calls === 3 && singleRun.r.payload.requests === 3 &&
    singleRun.r.payload.strategy === 'single', singleRun.calls);
  ok('single strategy still returns every segment', singleRun.r.payload.results.m2.translatedText === 'YAKU0 Second line');
  const stateAfter = await bgCall({ type: ns.constants.MSG_PING, id: 'bg-ping-after' });
  ok('worker keeps a request counter', typeof ns.background.state.requests === 'number' && ns.background.state.requests > 0,
    JSON.stringify(stateAfter.payload.state || {}));

  console.log('== content diagnostics API ==');
  const api = sandbox.window.__plamo;
  ok('window.__plamo exposed', typeof api === 'object' && api !== null);
  ['getState', 'getPending', 'getLogs', 'dumpLogs', 'backgroundLogs', 'pingBackground', 'translatePage', 'restoreAll', 'getCache', 'getSettings', 'getBatchPlan', 'getBatcherCaps']
    .forEach(fn => ok('__plamo.' + fn + '()', typeof api[fn] === 'function'));
  await chromeFake.storage.local.set({ plamo: { profileName: 'local-plamo2', maxConcurrent: 3, batch: { maxSegmentsPerBatch: 8, firstBatchMaxSegments: 4 }, request: { strategy: 'single' } } });
  await api.translatePage(); // reads settings, then rebuilds the packer from them
  ok('saved segment caps reach the packer in use', api.getBatcherCaps().maxSegmentsPerBatch === 8 &&
    api.getBatcherCaps().firstBatchMaxSegments === 4, api.getBatcherCaps());
  ok('packing plan reports what a run would do', api.getBatchPlan().strategy === 'single' &&
    api.getBatchPlan().caps.maxSegmentsPerBatch === 8 && api.getBatchPlan().requests === 0, api.getBatchPlan());
  const stateNow = api.getState();
  ok('getState exposes counters', typeof stateNow.translated === 'number' && typeof stateNow.cache.entries === 'number');
  ok('ring buffer shared with the page', api.getLogs().length > 0 && api.getLogs().length === ns.logger.getLogs().length);
  const pong = await api.pingBackground();
  ok('pingBackground reaches the worker', !!pong && pong.pong === true);
  const bgDiag = await api.backgroundLogs({ limit: 3 });
  ok('backgroundLogs pulls the worker logs', !!bgDiag && Array.isArray(bgDiag.logs) && bgDiag.logs.length <= 3);
  ok('content listener registered', typeof contentListener === 'function');
  const statusReply = await new Promise((resolve) => {
    let payload;
    const returned = contentListener({ type: ns.constants.MSG_STATUS, id: 'c-status' }, {}, (p) => { payload = p; });
    setTimeout(() => resolve({ returned, payload }), 30);
  });
  ok('content answers MSG_STATUS asynchronously', statusReply.returned === true && statusReply.payload.phase !== undefined);

  console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
}
main();
