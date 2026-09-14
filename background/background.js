// background/background.js
// Classic-script background worker. Loads in order:
// logger, constants, messaging, api/profiles, api/openai-client, scheduler.
//
// Centralizes ALL API access so the page never talks to the API directly
// (keeps page secrets out of the request body). Translates a batch of
// segments in parallel, bounded by concurrency, with per-request timeout,
// error classification, and per-segment isolation.
//
// MV3 allows only one service-worker entry file. The shared modules needed by
// the background are loaded here into the same global scope via importScripts
// (logger, constants, messaging, profiles, openai-client, scheduler) so
// globalThis.__PLAMO__ is populated before the IIFE below runs.
importScripts(
  '../shared/logger.js',
  '../shared/constants.js',
  '../shared/messaging.js',
  '../api/profiles.js',
  '../api/openai-client.js',
  '../translation/scheduler.js'
);

(function () {
  var ns = globalThis.__PLAMO__;

  var log = ns.logger.log;
  var C = ns.constants;
  var messaging = ns.messaging;
  var MSG_TRANSLATE = C.MSG_TRANSLATE;
  var MSG_STATUS = C.MSG_STATUS;
  var MSG_PING = C.MSG_PING;
  var MSG_DIAGNOSTICS = C.MSG_DIAGNOSTICS;

  var semaphore = new ns.Semaphore(C.DEFAULT_MAX_CONCURRENT);
  var profiles = ns.profiles;
  var translateSegment = ns.openaiClient.translateSegment;

  // Aggregate counters, readable from the service-worker console:
  //   __PLAMO__.background.state
  //   __PLAMO__.background.getDiagnostics({ limit: 200 })
  var state = {
    startedAt: Date.now(),
    messages: 0, batches: 0, requests: 0,
    translated: 0, failed: 0, cacheHits: 0,
    lastRequest: null,
    recentBatches: []
  };

  function describeSender(sender) {
    if (!sender) return 'unknown';
    if (sender.tab) return 'tab#' + sender.tab.id + ' ' + String(sender.tab.url || '').slice(0, 60);
    return 'extension:' + (sender.extensionId || (chrome.runtime && chrome.runtime.id) || 'self');
  }

  function semaphoreSnapshot() {
    return { limit: semaphore.getMax(), active: semaphore.getActive(), pending: semaphore.getPending() };
  }

  // The popup's concurrency setting used to be ignored (the Semaphore was
  // created once, at load time, with the default). A request may now retune the
  // shared limiter, which is what keeps the bound global across batches.
  function applyConcurrency(wanted, tag) {
    var info = semaphoreSnapshot();
    var n = (typeof wanted === 'number') ? wanted : parseInt(wanted, 10);
    if (!Number.isFinite(n) || n < 1) return info;
    info = semaphore.setMax(n);
    if (info.prev !== info.max) {
      log.debug(tag + ' concurrency limit ' + info.prev + ' -> ' + info.max +
        ' (active=' + info.active + ' pending=' + info.pending + ')');
    }
    return { limit: info.max, active: info.active, pending: info.pending };
  }

  function reply(sendResponse, payload, tag) {
    try {
      sendResponse(payload);
      if (ns.logger.isVerbose()) {
        var size = 0;
        try { size = JSON.stringify(payload).length; } catch (e) { size = -1; }
        log.trace(tag + ' replied bytes=' + size);
      }
    } catch (e) {
      log.warn(tag + ' sendResponse threw (channel already closed?): ' + String((e && e.message) || e));
    }
  }

  log.info('background worker ready | ' + JSON.stringify(semaphoreSnapshot()) + ' | profiles: ' +
    profiles.profileNames().map(function (name) {
      return profiles.describeProfile(profiles.getProfile(name));
    }).join(' ; '));


  // Translates one batch. Never rejects: every per-segment problem becomes an
  // { error, errorType } entry plus its own log line, so a failing batch tells
  // us what actually went wrong instead of only "something failed".
  async function translateBatch(batch, opts) {
    opts = opts || {};
    var requestId = opts.requestId || '-';
    var tag = 'batch[' + requestId + ']';
    var segCount = (batch && batch.segments && batch.segments.length) || 0;

    if (!batch || !Array.isArray(batch.segments) || !segCount) {
      var reason = !batch ? 'message carried no batch payload'
        : (!Array.isArray(batch.segments)
          ? 'batch.segments is ' + (batch.segments === undefined ? 'undefined' : typeof batch.segments) + ', expected an array'
          : 'batch.segments is an empty array');
      log.warn(tag + ' REJECTED: ' + reason + ' | ' + (opts.rawSummary || 'no summary'));
      return {
        requestId: requestId, status: 'failure', error: reason, errorType: 'config',
        segments: segCount, translated: 0, failed: 0, cacheHits: 0, elapsedMs: 0, results: {}
      };
    }

    var profile = profiles.getProfile(opts.profileName);
    var timeoutMs = (typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0) ? opts.timeoutMs : C.DEFAULT_TIMEOUT_MS;
    var guardMs = timeoutMs + 5000; // the client aborts at timeoutMs; this only fires if it never returns
    var cache = messaging.normalizeCache(opts.cache);
    var conc = applyConcurrency(opts.concurrency, tag);

    log.debug(tag + ' start ' + messaging.summarizeBatch(batch) + ' | ' + profiles.describeProfile(profile) +
      ' | POST ' + profiles.resolveEndpointUrl(profile) + ' | timeout=' + timeoutMs + 'ms' +
      ' | cache=' + cache.form + '(' + cache.size + ')' + ' | limit=' + conc.limit +
      ' active=' + conc.active + ' pending=' + conc.pending);

    var t0 = performance.now();
    var results = {};
    var translated = 0, failed = 0, cacheHits = 0, firstSuccessLogged = false;

    var tasks = batch.segments.map(function (segment) {
      return semaphore.run(function () {
        return new Promise(function (resolve) {
          var text = String(segment.text == null ? '' : segment.text);
          var preview = JSON.stringify(text.slice(0, 60));

          if (cache.has(segment.text)) {
            var cached = cache.get(segment.text);
            if (typeof cached === 'string' && cached.length) {
              cacheHits++; translated++;
              results[segment.id] = { id: segment.id, text: segment.text, translatedText: cached, cached: true };
              log.trace(tag + ' seg#' + segment.id + ' cache-hit chars=' + cached.length);
              resolve();
              return;
            }
            log.warn(tag + ' seg#' + segment.id + ' cache entry is not a usable string (' + typeof cached + '); calling the API');
          }

          var done = false;
          var segT0 = performance.now();
          var guard = setTimeout(function () {
            if (done) return;
            done = true;
            failed++;
            results[segment.id] = { id: segment.id, text: segment.text, error: 'no result within ' + guardMs + 'ms', errorType: 'timeout' };
            log.warn(tag + ' seg#' + segment.id + ' GUARD TIMEOUT after ' + guardMs + 'ms text=' + preview);
            resolve();
          }, guardMs);

          state.requests++;
          translateSegment(profile, segment, { timeoutMs: timeoutMs }).then(function (res) {
            if (done) return;
            done = true;
            clearTimeout(guard);
            var ms = Math.round(performance.now() - segT0);
            if (res && res.translatedText) {
              translated++;
              results[segment.id] = { id: segment.id, text: segment.text, translatedText: res.translatedText };
              if (!firstSuccessLogged) {
                firstSuccessLogged = true;
                log.debug(tag + ' first success seg#' + segment.id + ' ' + ms + 'ms chars=' + String(res.translatedText).length +
                  ' -> ' + JSON.stringify(String(res.translatedText).slice(0, 40)));
              }
              log.trace(tag + ' seg#' + segment.id + ' ok ' + ms + 'ms in=' + text.length + ' out=' + String(res.translatedText).length);
            } else {
              failed++;
              var errorType = (res && res.errorType) || 'unknown';
              var errorMessage = (res && res.error) || 'client reported no error and no text';
              results[segment.id] = { id: segment.id, text: segment.text, error: errorMessage, errorType: errorType };
              log.warn(tag + ' seg#' + segment.id + ' FAILED ' + errorType + ' ' + ms + 'ms :: ' +
                String(errorMessage).slice(0, 200) + ' :: text=' + preview);
            }
            resolve();
          }).catch(function (err) {
            if (done) return;
            done = true;
            clearTimeout(guard);
            failed++;
            var message = String((err && err.message) || err);
            results[segment.id] = { id: segment.id, text: segment.text, error: message, errorType: 'internal' };
            log.error(tag + ' seg#' + segment.id + ' THREW ' + message +
              ' stack=' + String((err && err.stack) || '').split('\n').slice(0, 3).join(' | '));
            resolve();
          });
        });
      });
    });

    await Promise.all(tasks);
    var elapsedMs = Math.round(performance.now() - t0);
    var status = failed === 0 ? 'success' : (translated === 0 ? 'failure' : 'partial');
    var summary = messaging.summarizeResults(results);
    var endpoint = profiles.resolveEndpointUrl(profile);

    var response = {
      requestId: requestId,
      profile: profile.name,
      endpoint: endpoint,
      segments: segCount,
      estimatedTokens: batch.estimatedTokens,
      elapsedMs: elapsedMs,
      results: results,
      translated: translated,
      failed: failed,
      cacheHits: cacheHits,
      status: status
    };

    state.batches++;
    state.translated += translated;
    state.failed += failed;
    state.cacheHits += cacheHits;
    var doneLine = tag + ' done ' + status.toUpperCase() + ' ' + summary.text +
      ' cache=' + cache.hits + 'hit/' + cache.misses + 'miss in ' + elapsedMs + 'ms';
    if (status === 'success') log.debug(doneLine); else log.warn(doneLine);
    state.recentBatches.push({
      requestId: requestId, at: Date.now(), status: status, segments: segCount,
      translated: translated, failed: failed, cacheHits: cacheHits, elapsedMs: elapsedMs,
      profile: profile.name, endpoint: endpoint, outcome: summary.text
    });
    while (state.recentBatches.length > 12) state.recentBatches.shift();
    return response;
  }

  // The returned boolean matters: returning true keeps the message port open so
  // the asynchronous sendResponse() still reaches the sender. Returning
  // undefined closes the port at once and the sender sees
  // "The message port closed before a response was received."
  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    state.messages++;
    var from = describeSender(sender);
    var type = msg && msg.type;
    var requestId = (msg && msg.id) || '-';
    var tag = 'batch[' + requestId + ']';

    if (!type) {
      log.warn('message with no type from ' + from + ' keys=' + Object.keys(msg || {}).join('/'));
      sendResponse({ error: 'message without a "type" field', errorType: 'config' });
      return false;
    }

    if (type === MSG_TRANSLATE) {
      log.debug('recv ' + messaging.summarizeMessage(msg) + ' from ' + from);
      if (ns.logger.isVerbose()) messaging.warnUnserializable(msg, 'MSG_TRANSLATE');
      state.lastRequest = { id: requestId, at: Date.now(), from: from, summary: messaging.summarizeMessage(msg) };

      var running;
      try {
        running = Promise.resolve(translateBatch(msg.batch, {
          requestId: requestId,
          profileName: msg.profileName || msg.profile,
          concurrency: msg.concurrency,
          timeoutMs: msg.timeoutMs,
          cache: msg.cache,
          rawSummary: messaging.summarizeMessage(msg)
        }));
      } catch (syncErr) {
        running = Promise.reject(syncErr); // e.g. an unknown profile name
      }

      running.then(function (res) {
        reply(sendResponse, res, tag);
      }, function (err) {
        var message = String((err && err.message) || err);
        log.error(tag + ' translateBatch THREW ' + message +
          ' stack=' + String((err && err.stack) || '').split('\n').slice(0, 4).join(' | '));
        reply(sendResponse, {
          requestId: requestId,
          status: 'failure',
          error: message,
          errorType: 'internal',
          segments: (msg.batch && msg.batch.segments && msg.batch.segments.length) || 0,
          estimatedTokens: (msg.batch && msg.batch.estimatedTokens) || 0,
          results: {}, translated: 0, failed: (msg.batch && msg.batch.segments && msg.batch.segments.length) || 0,
          cacheHits: 0, elapsedMs: 0
        }, tag);
      });
      return true; // asynchronous response
    }

    if (type === MSG_STATUS) {
      sendResponse(Object.assign({ phase: 'idle' }, semaphoreSnapshot(), {
        batches: state.batches, requests: state.requests,
        translated: state.translated, failed: state.failed, cacheHits: state.cacheHits
      }));
      return false;
    }

    if (type === MSG_PING) {
      log.debug('pong ' + requestId + ' from ' + from + ' ' + JSON.stringify(semaphoreSnapshot()));
      sendResponse(Object.assign({ ok: true, pong: true, version: chrome.runtime.getManifest().version }, semaphoreSnapshot()));
      return false;
    }

    // The service-worker console is awkward to reach (and its logs vanish when
    // the worker restarts), so the page can pull them from here instead.
    if (type === MSG_DIAGNOSTICS) {
      var limit = (msg && msg.limit) || 200;
      var logs = ns.logger.getLogs({ limit: limit });
      log.debug('diagnostics ' + requestId + ' from ' + from + ' -> ' + logs.length + ' record(s)');
      sendResponse({ ok: true, requestId: requestId, stats: ns.logger.stats(), state: snapshot(), logs: logs });
      return false;
    }

    var handled = [C.MSG_TRANSLATE, MSG_STATUS, MSG_PING, MSG_DIAGNOSTICS];
    log.warn('unknown message type "' + type + '" (' + requestId + ') from ' + from + ' | handled: ' + handled.join(', '));
    sendResponse({ error: 'unknown message type: ' + type, handledTypes: handled, errorType: 'config' });
    return false;
  });

  function snapshot() {
    return Object.assign({
      startedAt: state.startedAt, messages: state.messages, batches: state.batches,
      requests: state.requests, translated: state.translated, failed: state.failed,
      cacheHits: state.cacheHits, lastRequest: state.lastRequest,
      recentBatches: state.recentBatches.slice(-8)
    }, semaphoreSnapshot());
  }

  // Debug helpers for the service-worker console (chrome://extensions ->
  // "Service Worker" -> console): __PLAMO__.background.getDiagnostics().
  ns.background = {
    state: state,
    semaphore: semaphore,
    snapshot: snapshot,
    getLogs: function (opts) { return ns.logger.getLogs(opts); },
    dumpLogs: function (opts) { return ns.logger.dumpLogs(opts); },
    getDiagnostics: function (opts) {
      return { stats: ns.logger.stats(), state: snapshot(), logs: ns.logger.getLogs(opts || { limit: 200 }) };
    }
  };

  chrome.runtime.onInstalled.addListener(function () {
    log.info('installed', { version: chrome.runtime.getManifest().version });
    log.info('profiles: ' + profiles.profileNames().map(function (name) {
      var p = profiles.getProfile(name);
      return p.name + ' -> ' + profiles.resolveEndpointUrl(p);
    }).join(' ; '));
  });
})();
