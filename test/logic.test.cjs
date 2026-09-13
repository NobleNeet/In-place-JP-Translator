// test/logic.test.cjs
// Loads the classic-script modules in dependency order into a shared
// globalThis.__PLAMO__ namespace (vm context) and asserts the core logic.
// Run: node test/logic.test.cjs

const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const dir = '/mnt/240GB01/chrome_addon/In-place-JP-Translator';
const order = [
  'shared/logger.js','shared/constants.js','shared/settings.js','api/profiles.js',
  'api/openai-client.js','translation/scheduler.js','translation/cache.js',
  'translation/batcher.js','translation/queue.js','content/extractor.js',
  'content/segmenter.js','content/renderer.js','background/background.js',
  'content/content.js','popup/popup.js'
];

const _d = {};
const chromeFake = {
  storage: { local: { get: async () => Object.assign({}, _d), set: async (o) => { Object.assign(_d, o); } } },
  runtime: { onMessage: { addListener() {} }, onInstalled: { addListener() {} }, getManifest: () => ({ version: '0.1.0' }) }
};

const sandbox = {
  console, performance: globalThis.performance, Map, Set, Promise, Object,
  Number, JSON, parseInt, Math, AbortController, setTimeout, clearTimeout,
  fetch: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: 'test' } }] }), text: async () => '' }),
  chrome: chromeFake,
  window: {}, document: { createTreeWalker: () => ({ nextNode: () => null }), addEventListener: () => {} }
};
sandbox.globalThis = sandbox;
const ctx = vm.createContext(sandbox);
for (const f of order) vm.runInContext(readFileSync(path.join(dir, f), 'utf8'), ctx, { filename: f });

const ns = sandbox.globalThis.__PLAMO__;
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.log('  FAIL' + name); } };

async function main() {
  console.log('== modules loaded ==');
  ['logger','constants','settings','profiles','openaiClient','Semaphore','SessionCache','createBatcher','Queue','extractor','segmenter','renderer'].forEach(k => ok('ns.' + k, typeof ns[k] !== 'undefined'));

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

  console.log('== semaphore ==');
  async function testConcurrency(max, n) { const sem = new ns.Semaphore(max); var maxObs = 0, active = 0;
    const p = Array.from({ length: n }, (_, i) => sem.run(() => new Promise((res) => { active++; if (active > maxObs) maxObs = active; setTimeout(() => { active--; res(i); }, 5); })));
    await Promise.all(p); return maxObs; }
  for (const c of [1,2,4,8]) { const o = await testConcurrency(c, 20); ok('conc <= '+c, o <= c); ok('conc reached '+c, o === c); }

  console.log('== settings ==');
  await chromeFake.storage.local.set({ plamo: { profileName: 'local-plamo2', maxConcurrent: 3, batch: { maxSegmentsPerBatch: 8 } } });
  const s = await ns.settings.loadSettings();
  ok('profile', s.profileName === 'local-plamo2'); ok('batch override', s.batch.maxSegmentsPerBatch === 8); ok('maxConcurrent clamp 3->4', s.maxConcurrent === 4);
  ok('isModeSupported single', ns.settings.isModeSupported('single') === true); ok('isModeSupported fallback', ns.settings.isModeSupported('fallback') === true);

  console.log('== profiles ==');
  ok('getProfile evo', ns.profiles.getProfile('evo-x2-plamo2').url.includes('plamo2')); ok('fallback', ns.profiles.getProfile('nope').name === ns.profiles.profileNames()[0]);

  console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
}
main();
