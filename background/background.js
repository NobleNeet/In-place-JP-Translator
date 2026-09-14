// background/background.js
// Classic-script background worker. Loads in order:
// logger, constants, messaging, api/profiles, api/openai-client, scheduler.
//
// Centralizes ALL API access so the page never talks to the API directly
// (keeps page secrets out of the request body). One batch = ONE request: every
// segment of a batch is one line of one prompt and the answer is split back by
// lines. Requests run in parallel, bounded by concurrency (which now limits
// requests, not segments), with per-request timeout, error classification, and
// per-segment isolation.
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
  //
  // A batch is ONE API request now: translateSegments() puts every segment of
  // the batch on its own line of one prompt and the answer is split back by
  // lines. The semaphore therefore limits *requests* instead of segments, which
  // is the whole speed-up: a request costs a fixed prompt+decode round trip, so
  // 300 segments used to be 300 of them and are now a handful.
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
    var R = Object.assign({}, C.REQUEST_SETTINGS, opts.request || {});
    var strategy = (C.REQUEST_STRATEGIES.indexOf(opts.strategy) !== -1) ? opts.strategy : (R.strategy || C.REQUEST_SETTINGS.strategy);
    var explicitTimeout = (typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0);
    // A request that is *allowed* to run for minutes is not a patient client, it
    // is a batch that will come back as "the message channel closed before a
    // response was received" (the worker gets recycled long before). So both
    // timeouts are clamped to MAX_REQUEST_TIMEOUT_MS: better a clean timeout
    // error, which the retry and the per-segment fallback can act on.
    var capMs = C.MAX_REQUEST_TIMEOUT_MS || C.DEFAULT_TIMEOUT_MS;
    var timeoutWanted = explicitTimeout ? opts.timeoutMs : C.DEFAULT_TIMEOUT_MS;
    var timeoutMs = Math.min(timeoutWanted, capMs);
    var batchTokens = (typeof batch.estimatedTokens === 'number') ? batch.estimatedTokens : 0;
    // A batched request answers many segments at once, so it gets its own,
    // longer timeout that grows with the amount of text in it.
    var batchTimeoutWanted = explicitTimeout ? opts.timeoutMs
      : Math.round((R.timeoutBaseMs || C.DEFAULT_TIMEOUT_MS) + batchTokens * (R.timeoutPerTokenMs || 0));
    var batchTimeoutMs = Math.min(batchTimeoutWanted, capMs);
    var cappedNote = (batchTimeoutMs < batchTimeoutWanted || timeoutMs < timeoutWanted)
      ? ' (capped at ' + capMs + 'ms from ' + Math.max(batchTimeoutWanted, timeoutWanted) +
        'ms: a longer request outlives the extension message channel)'
      : '';
    var guardMs = timeoutMs + 5000;        // the client aborts at timeoutMs; this only fires if it never returns
    var batchGuardMs = batchTimeoutMs + 5000;
    var cache = messaging.normalizeCache(opts.cache);
    var conc = applyConcurrency(opts.concurrency, tag);

    log.debug(tag + ' start ' + messaging.summarizeBatch(batch) + ' | ' + profiles.describeProfile(profile) +
      ' | POST ' + profiles.resolveEndpointUrl(profile) + ' | strategy=' + strategy +
      ' | timeout=' + timeoutMs + 'ms batchTimeout=' + batchTimeoutMs + 'ms' + cappedNote +
      ' | cache=' + cache.form + '(' + cache.size + ')' + ' | limit=' + conc.limit +
      ' active=' + conc.active + ' pending=' + conc.pending);

    var t0 = performance.now();
    var results = {};
    var requests = 0;
    var firstSuccessLogged = false;
    // Alignment bookkeeping: 'aligned' is the happy path, 'fallback' counts the
    // segments that had to be redone one by one.
    var align = { requests: 0, aligned: 0, retried: 0, mismatch: 0, fallback: 0 };

    // Resolves to { timedOut, value, error }: the client never rejects, but a
    // fetch that never comes back must not hold the message port open forever.
    function guarded(ms, onTrip, promise) {
      return new Promise(function (resolve) {
        var settled = false;
        var timer = setTimeout(function () {
          if (settled) return;
          settled = true;
          onTrip();
          resolve({ timedOut: true });
        }, ms);
        promise.then(function (value) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({ timedOut: false, value: value });
        }, function (error) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({ timedOut: false, error: error });
        });
      });
    }

    function markFailed(segments, message, errorType) {
      segments.forEach(function (segment) {
        results[segment.id] = { id: segment.id, text: segment.text, error: message, errorType: errorType };
      });
    }

    // One request carrying the whole batch. A batch answer whose line count does
    // not match is retried once with numbers; whatever is still unplaced keeps an
    // errorType 'align' entry, which is what the per-segment fallback picks up.
    async function batchRequest(segments) {
      var formats = [R.format === 'numbered' ? 'numbered' : 'line'];
      if (R.retryWithNumbers && formats[0] !== 'numbered') formats.push('numbered');
      var textById = {};
      segments.forEach(function (segment) { textById[segment.id] = segment.text; });

      for (var f = 0; f < formats.length; f++) {
        var format = formats[f];
        if (f > 0) {
          align.retried++;
          log.warn(tag + ' line count did not match, retrying the batch with numbered lines');
        }
        requests++; align.requests++; state.requests++;
        var reqT0 = performance.now();
        var out = await guarded(batchGuardMs, function () {
          log.warn(tag + ' BATCH GUARD TIMEOUT after ' + batchGuardMs + 'ms segments=' + segments.length);
        }, ns.openaiClient.translateSegments(profile, segments, {
          timeoutMs: batchTimeoutMs,
          format: format,
          systemPrompt: R.batchSystemPrompt || undefined,
          maxTokens: R.maxTokensPerRequest || undefined
        }));
        var ms = Math.round(performance.now() - reqT0);

        if (out.timedOut) {
          markFailed(segments, 'no result within ' + batchGuardMs + 'ms', 'timeout');
          return 'timeout';
        }
        if (out.error) {
          var thrown = String((out.error && out.error.message) || out.error);
          markFailed(segments, thrown, 'internal');
          log.error(tag + ' BATCH THREW ' + thrown +
            ' stack=' + String((out.error && out.error.stack) || '').split('\n').slice(0, 3).join(' | '));
          return 'internal';
        }

        var res = out.value;
        if (res.status === 'error') {
          // A transport failure says nothing about the line count, and repeating
          // it once per segment would only hammer a server that is already down.
          markFailed(segments, res.error || 'request failed', res.errorType || 'unknown');
          log.warn(tag + ' BATCH FAILED ' + (res.errorType || 'unknown') + ' ' + ms + 'ms segments=' + res.sent +
            ' :: ' + String(res.error || '').slice(0, 200));
          return 'error';
        }
        Object.keys(res.results).forEach(function (id) {
          results[id] = Object.assign({ text: textById[id] }, res.results[id]);
        });
        if (res.status === 'aligned') {
          align.aligned++;
          log.debug(tag + ' BATCH OK segments=' + res.sent + ' lines=' + res.got + ' format=' + format +
            ' ' + ms + 'ms in=' + res.inChars + ' out=' + res.outChars + (res.usedNumbers ? ' numbered' : ''));
          return 'aligned';
        }
        log.warn(tag + ' BATCH MISMATCH segments=' + res.sent + ' lines=' + res.got + ' format=' + format + ' ' + ms + 'ms');
      }
      align.mismatch++;
      return 'mismatch';
    }

    // One request, one segment: used for a batch of one, for strategy 'single',
    // and for the segments a batched answer could not be split back for.
    function segmentRequest(segment) {
      var preview = JSON.stringify(String(segment.text == null ? '' : segment.text).slice(0, 60));
      var t1 = performance.now();
      requests++; state.requests++;
      return guarded(guardMs, function () {
        results[segment.id] = { id: segment.id, text: segment.text, error: 'no result within ' + guardMs + 'ms', errorType: 'timeout' };
        log.warn(tag + ' seg#' + segment.id + ' GUARD TIMEOUT after ' + guardMs + 'ms text=' + preview);
      }, translateSegment(profile, segment, { timeoutMs: timeoutMs })).then(function (out) {
        if (out.timedOut) return;
        var ms = Math.round(performance.now() - t1);
        if (out.error) {
          var thrown = String((out.error && out.error.message) || out.error);
          results[segment.id] = { id: segment.id, text: segment.text, error: thrown, errorType: 'internal' };
          log.error(tag + ' seg#' + segment.id + ' THREW ' + thrown +
            ' stack=' + String((out.error && out.error.stack) || '').split('\n').slice(0, 3).join(' | '));
          return;
        }
        var res = out.value;
        if (res && res.translatedText) {
          results[segment.id] = { id: segment.id, text: segment.text, translatedText: res.translatedText };
          if (!firstSuccessLogged) {
            firstSuccessLogged = true;
            log.debug(tag + ' first success seg#' + segment.id + ' ' + ms + 'ms chars=' + String(res.translatedText).length +
              ' -> ' + JSON.stringify(String(res.translatedText).slice(0, 40)));
          }
          log.trace(tag + ' seg#' + segment.id + ' ok ' + ms + 'ms in=' + String(segment.text == null ? '' : segment.text).length +
            ' out=' + String(res.translatedText).length);
        } else {
          var errorType = (res && res.errorType) || 'unknown';
          var errorMessage = (res && res.error) || 'client reported no error and no text';
          results[segment.id] = { id: segment.id, text: segment.text, error: errorMessage, errorType: errorType };
          log.warn(tag + ' seg#' + segment.id + ' FAILED ' + errorType + ' ' + ms + 'ms :: ' +
            String(errorMessage).slice(0, 200) + ' :: text=' + preview);
        }
      });
    }

    // Cache hits never reach the API, so they are taken out before packing.
    var pending = [];
    batch.segments.forEach(function (segment) {
      if (!cache.has(segment.text)) { pending.push(segment); return; }
      var cached = cache.get(segment.text);
      if (typeof cached === 'string' && cached.length) {
        results[segment.id] = { id: segment.id, text: segment.text, translatedText: cached, cached: true };
        log.trace(tag + ' seg#' + segment.id + ' cache-hit chars=' + cached.length);
        return;
      }
      log.warn(tag + ' seg#' + segment.id + ' cache entry is not a usable string (' + typeof cached + '); calling the API');
      pending.push(segment);
    });

    if (pending.length) {
      if (strategy !== 'single' && pending.length > 1) {
        // One limiter slot for the whole batch: a slot is a request now.
        await semaphore.run(function () { return batchRequest(pending); });
        var retryableFailure = function (r) {
          // 'align'  : the answer did not split back into lines;
          // 'timeout' : the request died at the ceiling (a too-big batch);
          // 'empty_response' : the model answered nothing to a batch prompt.
          return !r || r.errorType === 'align' || r.errorType === 'timeout' || r.errorType === 'empty_response';
        };
        var unplaced = pending.filter(function (segment) {
          var r = results[segment.id];
          if (r && r.translatedText) return false;
          // A server that answered 404/500 or refused the connection will not do
          // better when asked 16 more times, so only the failures that mean "the
          // answer was unusable, or never came in time" are retried one by one.
          // The timeout case matters most: a batched request is capped to
          // MAX_REQUEST_TIMEOUT_MS, so a too-big batch times out as a whole and
          // each of its segments is worth a second, smaller attempt.
          return retryableFailure(r);
        });
        var hardFailed = pending.filter(function (segment) {
          var r = results[segment.id];
          return r && r.error && !retryableFailure(r);
        });
        if (hardFailed.length && !unplaced.length) {
          log.warn(tag + ' ' + hardFailed.length + ' segment(s) not retried one by one: the request itself failed (' +
            hardFailed.map(function (segment) { return results[segment.id].errorType; })
              .filter(function (v, i, a) { return a.indexOf(v) === i; }).join(',') + ')');
        }
        if (unplaced.length && R.perSegmentFallback) {
          align.fallback = unplaced.length;
          log.warn(tag + ' ' + unplaced.length + ' of ' + pending.length + ' segment(s) fall back to one request each');
          await Promise.all(unplaced.map(function (segment) {
            return semaphore.run(function () { return segmentRequest(segment); });
          }));
        }
      } else {
        await Promise.all(pending.map(function (segment) {
          return semaphore.run(function () { return segmentRequest(segment); });
        }));
      }
    }

    // Counters are derived from the results, so a segment that failed in the
    // batched pass and then succeeded in the fallback pass is counted once.
    var translated = 0, failed = 0, cacheHits = 0;
    batch.segments.forEach(function (segment) {
      var r = results[segment.id];
      if (!r) return;
      if (r.error) failed++;
      else if (r.translatedText) translated++;
      if (r.cached) cacheHits++;
    });

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
      strategy: strategy,
      requests: requests, // how many HTTP POSTs this batch cost — the number to watch
      align: align,
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
      ' requests=' + requests + ' strategy=' + strategy +
      ' cache=' + cache.hits + 'hit/' + cache.misses + 'miss in ' + elapsedMs + 'ms';
    if (status === 'success') log.debug(doneLine); else log.warn(doneLine);
    // One machine-readable record per batch: the segments/requests ratio is what
    // shows whether the packing is doing its job (grep the log for "batch").
    log.batch({
      request: requestId, server: profile.name, strategy: strategy, requests: requests,
      segments: segCount, units: batch.units, estimatedTokens: batch.estimatedTokens,
      align: align, cacheHits: cacheHits, elapsedMs: elapsedMs, status: status
    });
    state.recentBatches.push({
      requestId: requestId, at: Date.now(), status: status, segments: segCount, units: batch.units,
      requests: requests, strategy: strategy,
      translated: translated, failed: failed, cacheHits: cacheHits, elapsedMs: elapsedMs,
      profile: profile.name, endpoint: endpoint, outcome: summary.text
    });
    while (state.recentBatches.length > 12) state.recentBatches.shift();
    return response;
  }

  // Runs one translate request and hands the finished answer to `respond`.
  // Both entry points - sendMessage and the long-lived port - go through here,
  // so the two channels can never disagree about what a request does.
  function runTranslate(msg, respond, tag, from) {
    var requestId = (msg && msg.id) || '-';
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
        strategy: msg.strategy,
        request: msg.request,
        cache: msg.cache,
        rawSummary: messaging.summarizeMessage(msg)
      }));
    } catch (syncErr) {
      running = Promise.reject(syncErr); // e.g. an unknown profile name
    }

    running.then(function (res) {
      respond(res, tag);
    }, function (err) {
      var message = String((err && err.message) || err);
      log.error(tag + ' translateBatch THREW ' + message +
        ' stack=' + String((err && err.stack) || '').split('\n').slice(0, 4).join(' | '));
      respond({
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
  }

  // Translation requests normally come over this port instead of sendMessage.
  // A batched request can take minutes, and sendMessage's one-shot response
  // channel does not last that long: when the worker is recycled mid-request the
  // page only sees "A listener indicated an asynchronous response by returning
  // true, but the message channel closed before a response was received" and the
  // whole batch is lost. A port the page holds open answers whenever it is ready
  // (and a connected port counts as activity for the worker), and its disconnect
  // is logged with the requests that were still in flight, so the event that
  // killed a batch is visible in the diagnostics instead of being guessed at.
  var portSeq = 0;
  chrome.runtime.onConnect.addListener(function (port) {
    if (!port || port.name !== C.PORT_TRANSLATE) {
      var foreignName = port && port.name;
      if (foreignName) log.debug('ignoring port "' + foreignName + '" (this worker serves "' + C.PORT_TRANSLATE + '")');
      return;
    }
    var pid = 'port#' + (++portSeq);
    var from = describeSender(port.sender);
    var inFlight = 0;
    var openedAt = Date.now();
    log.debug(pid + ' opened from ' + from + ' (' + C.PORT_TRANSLATE + ')');

    port.onMessage.addListener(function (msg) {
      var type = msg && msg.type;
      var requestId = (msg && msg.id) || '-';
      var tag = 'batch[' + requestId + ']';
      if (type === MSG_PING) {
        port.postMessage(Object.assign({ ok: true, pong: true, via: 'port' }, semaphoreSnapshot()));
        return;
      }
      if (type !== MSG_TRANSLATE) {
        log.warn(pid + ' unknown message type "' + type + '" (' + requestId + ') | handled: ' + C.MSG_TRANSLATE + ', ' + MSG_PING);
        port.postMessage({ error: 'unknown message type on port: ' + type, errorType: 'config' });
        return;
      }
      state.messages++;
      inFlight++;
      runTranslate(msg, function (payload) {
        inFlight--;
        try {
          port.postMessage(payload);
          if (ns.logger.isVerbose()) {
            var size = 0;
            try { size = JSON.stringify(payload).length; } catch (e) { size = -1; }
            log.trace(tag + ' replied over ' + pid + ' bytes=' + size);
          }
        } catch (e) {
          log.warn(tag + ' port postMessage threw (' + pid + ' gone?): ' + String((e && e.message) || e));
        }
      }, tag, from + ' ' + pid);
    });

    port.onDisconnect.addListener(function () {
      var why = chrome.runtime.lastError;
      var ms = Date.now() - openedAt;
      var line = pid + ' closed after ' + ms + 'ms from ' + from + ' (requests answered on it: ' + state.requests + ')';
      if (inFlight > 0) {
        log.warn(line + ' WITH ' + inFlight + ' REQUEST(S) STILL IN FLIGHT: the worker was recycled (or crashed) ' +
          'mid-request, so those batches are lost in transport. The page retries them as smaller requests; ' +
          'if this repeats, lower "Segments per request".' +
          (why ? ' :: lastError=' + why.message : ''));
      } else {
        log.debug(line + (why ? ' :: lastError=' + why.message : ''));
      }
    });
  });


  // The returned boolean matters for sendMessage: returning true keeps the
  // response channel open so an asynchronous sendResponse() still reaches the
  // sender. Long translate requests belong on the port above, which does not
  // depend on one channel surviving for minutes.
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
      // Supported for compatibility (a page whose connect() failed, an older
      // build), but such a request is one worker recycling away from being lost.
      log.debug(tag + ' arrived over sendMessage; the "' + C.PORT_TRANSLATE + '" port is the durable channel');
      runTranslate(msg, function (payload, t) { reply(sendResponse, payload, t); }, tag, from);
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
      // The ceiling every per-request timeout is clamped to (see constants): a
      // batch that needs more than this has to be packed smaller.
      requestTimeoutCapMs: C.MAX_REQUEST_TIMEOUT_MS,
      batchCaps: C.BATCH_SETTINGS,
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
