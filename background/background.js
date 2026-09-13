// background/background.js
// Classic-script background worker. Loads in order:
// logger, api/profiles, api/openai-client, translation/scheduler, constants.
//
// Centralizes ALL API access so the page never talks to the API directly
// (keeps page secrets out of the request body). Translates a batch of
// segments in parallel, bounded by concurrency, with per-request timeout,
// error classification, and per-segment isolation.
//
// MV3 allows only one service-worker entry file. The shared modules needed by
// the background are loaded here into the same global scope via importScripts
// (logger, constants, profiles, openai-client, scheduler) so globalThis.__PLAMO__
// is populated before the IIFE below runs.
importScripts(
  '../shared/logger.js',
  '../shared/constants.js',
  '../api/profiles.js',
  '../api/openai-client.js',
  '../translation/scheduler.js'
);

(function () {
  var ns = globalThis.__PLAMO__;

  var log = ns.logger.log;
  var MSG_TRANSLATE = ns.constants.MSG_TRANSLATE;
  var MSG_STATUS = ns.constants.MSG_STATUS;

  var semaphore = new ns.Semaphore(ns.constants.DEFAULT_MAX_CONCURRENT);
  var profiles = ns.profiles;
  var translateSegment = ns.openaiClient.translateSegment;

  async function translateBatch(batch, profileName, concurrency, timeoutMs, cache) {
    var profile = profiles.getProfile(profileName);
    log.debug('translateBatch start: ' + batch.segments.length + ' segments, est ' + batch.estimatedTokens + ' tokens, profile=' + profile.name + ', concurrency=' + concurrency);
    var t0 = performance.now();
    var results = {};
    var translated = 0, failed = 0, cacheHits = 0;

    var tasks = batch.segments.map(function (segment) {
      return semaphore.run(function () {
        return new Promise(function (resolve) {
          var cached = cache.get(segment.text);
          if (cached != null) {
            cacheHits++;
            results[segment.id] = { id: segment.id, text: segment.text, translatedText: cached };
            translated++;
            resolve();
            return;
          }

          var done = false;
          var timer = setTimeout(function () {
            if (done) return;
            done = true;
            results[segment.id] = { id: segment.id, text: segment.text, error: 'Request timed out', errorType: 'timeout' };
            failed++;
            resolve();
          }, timeoutMs);

          translateSegment(profile, segment, { timeoutMs: timeoutMs }).then(function (res) {
            if (done) return;
            done = true;
            clearTimeout(timer);
            if (res.translatedText) {
              results[segment.id] = { id: segment.id, text: segment.text, translatedText: res.translatedText };
              cache.set(segment.text, res.translatedText);
              translated++;
            } else {
              results[segment.id] = { id: segment.id, text: segment.text, error: res.error, errorType: res.errorType };
              failed++;
            }
            resolve();
          }).catch(function (err) {
            if (done) return;
            done = true;
            clearTimeout(timer);
            results[segment.id] = { id: segment.id, text: segment.text, error: String(err && err.message || err), errorType: 'connection' };
            failed++;
            resolve();
          });
        });
      });
    });

    await Promise.all(tasks);
    var elapsedMs = Math.round(performance.now() - t0);
    var status = failed === 0 ? 'success' : (translated === 0 ? 'failure' : 'partial');
    log.debug('translateBatch done: translated=' + translated + ' failed=' + failed + ' cacheHits=' + cacheHits + ' ' + elapsedMs + 'ms');
    return {
      profile: profile.name,
      segments: batch.segments.length,
      estimatedTokens: batch.estimatedTokens,
      elapsedMs: elapsedMs,
      results: results,
      translated: translated,
      failed: failed,
      cacheHits: cacheHits,
      status: status
    };
  }

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || !msg.type) { sendResponse({ error: 'unknown message type' }); return; }
    if (msg.type === MSG_TRANSLATE) {
      var p = translateBatch(msg.batch, msg.profileName, msg.concurrency, msg.timeoutMs, msg.cache || new Map());
      p.then(function (res) { sendResponse(res); }, function (err) { log.error('translateBatch error', err); sendResponse({ segments: (msg.batch && msg.batch.segments ? msg.batch.segments.length : 0), error: String(err && err.message || err), status: 'failure' }); });
      return;
    }
    if (msg.type === MSG_STATUS) {
      sendResponse({ phase: 'idle', segments: 0, translated: 0, failed: 0 });
      return;
    }
    sendResponse({ error: 'unknown message type' });
  });

  chrome.runtime.onInstalled.addListener(function () { log.info('installed', { version: chrome.runtime.getManifest().version }); });
})();
