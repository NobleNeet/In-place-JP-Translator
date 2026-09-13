// content/content.js
// Page orchestrator:
//   extract -> segment -> (cache) -> priority order -> batch ->
//   send to background -> map results by id -> apply to DOM -> metrics.
//
// The API is never called from here; all network access goes through the
// background service worker.

import { log } from '../shared/logger.js';
import { extractReadableElements } from './extractor.js';
import { buildSegments } from './segmenter.js';
import { applyTranslation } from './renderer.js';
import { createBatcher } from '../translation/batcher.js';
import { SessionCache } from '../translation/cache.js';
import { MSG_TRANSLATE_PAGE, MSG_STOP, MSG_STATUS } from '../shared/constants.js';
import { loadSettings } from '../shared/settings.js';

const batcher = createBatcher();
const cache = new SessionCache();

const state = {
  phase: 'idle', // idle | extracting | translating | completed | error
  aborted: false,
  segments: 0,
  translated: 0,
  failed: 0,
  cacheHits: 0,
};

let settings = await loadSettings();
let appController = new AbortController();
let batchId = 0;
let firstTranslatedAt = 0;
let firstViewportAt = 0;

// Exposed on window for manual inspection from devtools.
window.__plamo = {
  getState: () => state,
  getCache: () => cache,
  getSettings: () => settings,
};

function broadcastStatus() {
  chrome.runtime.sendMessage({ type: MSG_STATUS, state: { ...state } });
}

function setPhase(phase) {
  state.phase = phase;
  broadcastStatus();
}

async function translatePage() {
  if (state.phase === 'translating') return;

  appController = new AbortController();
  state.aborted = false;

  // Read fresh settings so popup changes (profile/concurrency) take effect.
  settings = await loadSettings();

  setPhase('extracting');
  const tAll = performance.now();

  const readables = extractReadableElements(document);
  const allSegments = buildSegments(readables);

  // Cache hits are applied without any API call.
  let toTranslate = [];
  for (const seg of allSegments) {
    if (cache.has(seg.text)) {
      if (applyTranslation(seg, cache.get(seg.text))) {
        state.translated += 1;
        cache.recordHit();
        state.cacheHits += 1;
      }
      continue;
    }
    cache.recordMiss();
    toTranslate.push(seg);
  }

  // Priority order: currently visible first, then near, then the rest.
  toTranslate.sort((a, b) => (a.priority - b.priority) || (allSegments.indexOf(a) - allSegments.indexOf(b)));

  const batches = batcher(toTranslate);
  state.segments = toTranslate.length;
  setPhase('translating');

  log.info(`start: ${toTranslate.length} segments in ${batches.length} batch(es)`, {
    byPriority: {
      visible: toTranslate.filter((s) => s.priority === 1).length,
      near: toTranslate.filter((s) => s.priority === 2).length,
      other: toTranslate.filter((s) => s.priority === 3).length,
    },
  });

  for (const batchSegs of batches) {
    if (appController.signal.aborted) break;

    const estTokens = batchSegs.reduce((sum, s) => sum + (s.tokenEstimate || 0), 0);
    const t0 = performance.now();
    const res = await requestTranslate(batchSegs);
    const elapsedMs = Math.round(performance.now() - t0);

    batchId += 1;
    log.batch({
      batch: batchId,
      server: res.profileName || 'none',
      segments: batchSegs.length,
      estimatedTokens: estTokens,
      elapsedMs,
      status: res.ok ? 'success' : 'failure',
    });

    for (const r of res.results) {
      const seg = batchSegs.find((x) => x.id === r.id);
      if (!seg) {
        log.error(`segment/response mismatch: ${r.id}`);
        continue;
      }
      if (r.error) {
        seg.state = 'failed';
        state.failed += 1;
        log.warn(`failed ${seg.id} [${r.errorType}] ${r.error}`);
      } else {
        if (firstTranslatedAt === 0) firstTranslatedAt = performance.now() - tAll;
        applyTranslation(seg, r.translatedText);
        cache.set(seg.text, r.translatedText);
        state.translated += 1;
        if (seg.priority <= 2 && firstViewportAt === 0) firstViewportAt = performance.now() - tAll;
      }
    }
  }

  setPhase(state.aborted ? 'idle' : 'completed');

  log.info('done', {
    total: state.segments,
    translated: state.translated,
    failed: state.failed,
    cacheHits: state.cacheHits,
    elapsedMs: Math.round(performance.now() - tAll),
    firstTranslatedLatencyMs: firstTranslatedAt,
    firstViewportLatencyMs: firstViewportAt,
  });
}

function requestTranslate(segments) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      {
        type: MSG_TRANSLATE,
        profileName: settings.profileName,
        mode: settings.mode,
        maxConcurrent: settings.maxConcurrent,
        segments,
      },
      (resp) => {
        if (resp && resp.ok) {
          resolve({ ok: true, profileName: resp.profileName, results: resp.results });
          return;
        }
        log.warn('translate response ok=false', resp && resp.error);
        resolve({
          ok: false,
          profileName: null,
          results: segments.map((s) => ({
            id: s.id,
            error: resp ? resp.error || 'no response' : 'no response',
            errorType: 'no_response',
          })),
        });
      },
    );
  });
}

function stopTranslation() {
  state.aborted = true;
  appController.abort();
  log.info('user requested stop');
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === MSG_TRANSLATE_PAGE) {
    translatePage();
    return true;
  }
  if (msg && msg.type === MSG_STOP) {
    stopTranslation();
    return true;
  }
  if (msg && msg.type === MSG_STATUS) {
    return true;
  }
  return false;
});
