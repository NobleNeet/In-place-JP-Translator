// background/background.js
// Centralizes all OpenAI-compatible API access.
// Content scripts never touch the network directly.
//
// Each incoming batch becomes one or more API tasks (1 segment = 1 task in
// this phase), executed with bounded concurrency (Semaphore), a hard timeout,
// and per-task error isolation.

import { log } from '../shared/logger.js';
import { getProfile } from '../api/profiles.js';
import { translateSegment } from '../api/openai-client.js';
import { Semaphore } from '../translation/scheduler.js';
import { MSG_TRANSLATE, MSG_STOP, DEFAULT_MAX_CONCURRENT, DEFAULT_TIMEOUT_MS } from '../shared/constants.js';

const appController = new AbortController();
let semaphore = new Semaphore(DEFAULT_MAX_CONCURRENT);
let maxConcurrent = DEFAULT_MAX_CONCURRENT;
let aborted = false;

function runTask(profile, segment) {
  return semaphore
    .acquire()
    .then(() => {
      const t0 = performance.now();
      return translateSegment(profile, segment, {
        timeoutMs: DEFAULT_TIMEOUT_MS,
        signal: appController.signal,
      }).then((res) => ({
        ...res,
        id: segment.id,
        elapsedMs: Math.round(performance.now() - t0),
      }));
    })
    .finally(() => semaphore.release());
}

async function handleTranslate(msg, sendResponse) {
  if (aborted) {
    sendResponse({ ok: false, error: 'stopped', profileName: null });
    return;
  }

  const profileName = msg.profileName || 'evo-x2-plamo2';
  const profile = getProfile(profileName);
  const segments = msg.segments || [];
  const maxC = Math.max(1, (msg.maxConcurrent || maxConcurrent) | 0);
  maxConcurrent = maxC;
  semaphore.update(maxC);

  const estTokens = segments.reduce((sum, seg) => sum + (seg.tokenEstimate || 0), 0);
  const tStart = performance.now();

  const results = await Promise.all(segments.map((seg) => runTask(profile, seg)));

  const elapsedMs = Math.round(performance.now() - tStart);
  const succeeded = results.filter((r) => r.translatedText).length;
  const failed = results.length - succeeded;

  log.batch({
    batch: (handleTranslate.batchId = (handleTranslate.batchId || 0) + 1),
    server: profile.name,
    segments: segments.length,
    estimatedTokens: estTokens,
    elapsedMs,
    status: failed === 0 ? 'success' : failed === results.length ? 'failure' : 'partial',
  });

  sendResponse({
    ok: true,
    profileName: profile.name,
    count: results.length,
    results,
    elapsedMs,
  });
}

function handleStop() {
  aborted = true;
  appController.abort();
  log.warn('translation stopped by user');
}

chrome.runtime.onMessage.addListener((msg, sendResponse) => {
  if (msg && msg.type === MSG_TRANSLATE) {
    handleTranslate(msg, sendResponse);
    return true;
  }
  if (msg && msg.type === MSG_STOP) {
    handleStop();
    sendResponse({ ok: true });
    return true;
  }
  return false;
});
