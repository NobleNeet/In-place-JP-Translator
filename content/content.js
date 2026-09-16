// content/content.js
// Classic-script orchestrator. Runs in the page's content-script scope.
// Loads in order: logger, constants, settings, profiles, openai-client,
// priority, extractor, segmenter, renderer, batcher, cache, persistent, queue;
// content/ui.js (the corner button) loads after it and watches runs via
// ns.ui.onRunEvent.
//
// Flow: collect TEXT NODES -> one segment per text node -> order by region
// (article body, then headings, then page chrome) and inside a region by
// viewport band -> pack the segments into batches, where one batch is ONE API
// request (paragraph fragments stay together, menu/list items are piled into
// the same request) -> send each batch to the background (in parallel,
// concurrency bound = requests in flight) -> write each finished translation
// into its own text node (node.nodeValue only) as soon as its batch arrives.
// Because an element's children are never replaced, links/forms/images survive
// and the layout holds. A translation that is just a copy of the English
// ('identical') is not a success: it is never cached, and at the end of the run
// every copied segment gets one more small request with an explicit do-not-copy
// instruction (retryEchoSegments). MSG_RESTORE (or __plamo.restoreAll()) puts
// the original values back.
// Text the user could not see when the page was scanned is not sent at all: it
// is remembered and translated on its own as soon as the page displays it (see
// the reveal watch below, and content/priority.js for what counts as hidden).
(function () {
  var ns = globalThis.__PLAMO__;

  var log = ns.logger.log;
  var messaging = ns.messaging;
  var C = ns.constants;
  var MSG_TRANSLATE_PAGE = C.MSG_TRANSLATE_PAGE;
  var MSG_RESTORE = C.MSG_RESTORE;
  var MSG_STOP = C.MSG_STOP;
  var MSG_STATUS = C.MSG_STATUS;
  var MSG_TRANSLATE = C.MSG_TRANSLATE;
  var MSG_DIAGNOSTICS = C.MSG_DIAGNOSTICS;

  // buildSegmentsResult() walks the tree for translatable Text nodes (document
  // order) and answers two questions at once: the segments a run should send —
  // each holding its own Text node in segment.source.node — and the hidden text
  // nodes it held back instead of sending. sortSegments() is the send order:
  // article body, then headings, then page chrome, viewport band inside each.
  var buildSegmentsResult = ns.segmenter.buildSegmentsResult;
  var sortSegments = ns.segmenter.sortSegments;
  // applySegment writes into a Text node (node.nodeValue only); the renderer
  // keeps the registry that makes restoreAll possible.
  var renderer = ns.renderer;
  var applySegment = ns.renderer.applySegment;
  var restoreNode = ns.renderer.restore;
  var restoreNodes = ns.renderer.restoreAll;
  var createBatcher = ns.createBatcher;
  var SessionCache = ns.SessionCache;
  var loadSettings = ns.settings.loadSettings;
  var activeApis = ns.settings.activeApis;
  var apiPlan = ns.settings.apiPlan;
  var getProfile = ns.profiles.getProfile;
  var translateSegment = ns.openaiClient.translateSegment;

  var settings = {};
  // The batcher holds the caps from settings.batch, so it is created from the
  // defaults here and RE-created once loadSettings() has answered — a batcher
  // built once at load time would silently keep the defaults and ignore a saved
  // "segments per request". batcherCaps says what the packer really uses.
  var batcher = null;
  var batcherCaps = null;
  function applyBatchSettings() {
    batcher = createBatcher((settings && settings.batch) || {});
    // The packer reports the numbers it was built with, so a log line or a
    // __plamo.getBatcherCaps() answer can never disagree with the packer that
    // actually packed the page.
    batcherCaps = batcher.caps();
    return batcher;
  }
  applyBatchSettings();

  // The region/deferral knobs for one scan: defaults from shared/constants.js
  // (PRIORITY_SETTINGS) with the saved settings.priority on top. Read per scan,
  // so a popup change applies to the next run without reloading the page.
  function prioritySettings() {
    var P = C.PRIORITY_SETTINGS || {};
    var p = (settings && settings.priority) || {};
    return {
      deferHidden: p.deferHidden != null ? !!p.deferHidden : P.deferHidden !== false,
      revealDebounceMs: Number(p.revealDebounceMs) || P.revealDebounceMs || 250,
      revealIntervalMs: Number(p.revealIntervalMs) || P.revealIntervalMs || 4000,
      maxHiddenChecks: Number(p.maxHiddenChecks) || P.maxHiddenChecks || 6000
    };
  }

  // What one scan produces: the segments to send (in send order after
  // sortSegments) and the hidden Text nodes held back. opts.nodes limits the
  // scan to those nodes, which is how a revealed menu costs one small request
  // instead of a re-read of the whole page.
  function collectSegments(root, opts) {
    var o = prioritySettings();
    if (opts && opts.nodes) o.nodes = opts.nodes;
    return buildSegmentsResult(root, o);
  }
  var cache = new SessionCache();
  var abortRequested = false;
  var runSeq = 0;
  var lastRun = null;
  var live = null; // counters of the run in progress (see __plamo.getState())

  // chrome.runtime.lastError strings are cryptic; attach the fix that applies.
  function hintFor(message) { return messaging.hintFor(message); }

  function lastErrorMessage(err) {
    return String((err && err.message) || err || '');
  }

  // The corner widget (content/ui.js) watches the run to draw its button. It is
  // an optional module: a page keeps translating from the popup even if ui.js
  // failed to load, so every report is wrapped and loud exactly once.
  function uiEvent(kind) {
    try {
      if (ns.ui && ns.ui.onRunEvent) ns.ui.onRunEvent(kind);
    } catch (e) {
      log.trace('ui event "' + kind + '" failed: ' + lastErrorMessage(e));
    }
  }

  // The cache that outlives the page (translation/persistent.js) is likewise
  // optional in the load order, but losing it means every page view re-sends
  // text translated days ago, so say it out loud once.
  var persistentWarned = false;
  function persistent() {
    if (ns.persistentCache) return ns.persistentCache;
    if (!persistentWarned) {
      persistentWarned = true;
      log.warn('translation/persistent.js is not loaded: every page view will re-translate text earlier visits already knew '
        + '(check the content_scripts order in manifest.json)');
    }
    return null;
  }

  // sendMessage wrapper that logs the request/response pair with one id, so a
  // failure can be followed across the page <-> background boundary.
  function sendRuntime(msg) {
    var id = msg.id || (msg.id = messaging.makeRequestId('msg'));
    var t0 = performance.now();
    return new Promise(function (resolve, reject) {
      var settled = false;
      log.trace('send ' + messaging.summarizeMessage(msg));
      try {
        chrome.runtime.sendMessage(msg, function (response) {
          if (settled) return;
          settled = true;
          var ms = Math.round(performance.now() - t0);
          var lastErr = chrome.runtime.lastError;
          if (lastErr) {
            log.error('send ' + msg.type + ' [' + id + '] FAILED in ' + ms + 'ms :: ' + lastErr.message + hintFor(lastErr.message));
            reject(new Error(lastErr.message));
            return;
          }
          if (response === undefined) {
            log.warn('send ' + msg.type + ' [' + id + '] returned NO body after ' + ms + 'ms (listener returned true but never called sendResponse)');
          }
          log.trace('resp ' + msg.type + ' [' + id + '] in ' + ms + 'ms');
          resolve(response);
        });
      } catch (e) {
        if (settled) return;
        settled = true;
        log.error('send ' + msg.type + ' [' + id + '] THREW: ' + lastErrorMessage(e) + hintFor(lastErrorMessage(e)));
        reject(e);
      }
    });
  }

  // ---- the page <-> worker channel -------------------------------------
  // chrome.runtime.sendMessage() answers on a one-shot channel, and that channel
  // dies whenever the worker is recycled. One batch used to be one short request
  // so nobody noticed; a batch is now many segments on one prompt and can run for
  // minutes, which is exactly long enough for the channel to close first. The
  // page then sees "A listener indicated an asynchronous response by returning
  // true, but the message channel closed before a response was received" and the
  // whole batch - often a paragraph's worth of text - is lost. A port the page
  // keeps open for the length of a run answers whenever it is ready, and a
  // connected port counts as activity for the worker, so it also keeps it alive.
  var channel = null;

  function closeChannel(reason) {
    if (!channel) return;
    var c = channel;
    channel = null;
    var ids = Object.keys(c.pending);
    ids.forEach(function (id) {
      var p = c.pending[id];
      delete c.pending[id];
      if (p && p.reject) p.reject(new Error('channel closed before ' + id + ' was answered' + (reason ? ' (' + reason + ')' : '')));
    });
    try { c.port.disconnect(); } catch (e) { /* already gone */ }
    log.debug('channel closed' + (reason ? ' (' + reason + ')' : '') + ' requests=' + c.requests +
      (ids.length ? ' UNANSWERED=' + ids.length : ''));
  }

  function openChannel(tag) {
    closeChannel('re-open');
    if (!chrome.runtime.connect) {
      log.info(tag + ' no connect() available, every request goes over sendMessage (a long one can be lost)');
      return null;
    }
    var port;
    try {
      port = chrome.runtime.connect({ name: C.PORT_TRANSLATE });
    } catch (e) {
      log.warn(tag + ' connect() failed, falling back to sendMessage per request: ' + lastErrorMessage(e));
      return null;
    }
    var c = { port: port, pending: {}, requests: 0, openedAt: performance.now() };
    channel = c;
    port.onMessage.addListener(function (res) {
      var id = res && res.requestId;
      var p = c.pending[id];
      if (!p) {
        log.warn('channel: answer for unknown request "' + id + '" (waiting for: ' + (Object.keys(c.pending).join(',') || 'none') + ')');
        return;
      }
      delete c.pending[id];
      log.trace('resp ' + MSG_TRANSLATE + ' [' + id + '] over port in ' + Math.round(performance.now() - p.t0) + 'ms');
      p.resolve(res);
    });
    port.onDisconnect.addListener(function () {
      var why = chrome.runtime.lastError;
      var ids = Object.keys(c.pending);
      if (channel === c) channel = null;
      var message = 'the extension worker went away ' + (ids.length ? 'with ' + ids.length + ' request(s) in flight' : 'while idle') +
        (why && why.message ? ' :: ' + why.message : '');
      if (ids.length) log.error('channel LOST: ' + message + ' (those batches are retried as smaller requests)');
      else log.debug('channel closed: ' + message);
      ids.forEach(function (id) {
        var p = c.pending[id];
        delete c.pending[id];
        if (p && p.reject) p.reject(new Error(message + hintFor(message)));
      });
    });
    log.info(tag + ' channel opened (port "' + C.PORT_TRANSLATE + '")');
    return c;
  }

  // One request over the run's port, or over sendMessage when there is no port.
  // Rejects only for transport problems; a failed *translation* is a result.
  function sendTranslate(msg) {
    var c = channel;
    if (!c || !c.port) return sendRuntime(msg);
    var id = msg.id || (msg.id = messaging.makeRequestId('msg'));
    var t0 = performance.now();
    c.requests++;
    return new Promise(function (resolve, reject) {
      c.pending[id] = { resolve: resolve, reject: reject, t0: t0 };
      log.trace('send ' + messaging.summarizeMessage(msg) + ' over port');
      try {
        c.port.postMessage(msg);
      } catch (e) {
        delete c.pending[id];
        reject(new Error('port postMessage failed: ' + lastErrorMessage(e)));
      }
    }).then(null, function (err) {
      log.error('send ' + msg.type + ' [' + id + '] FAILED in ' + Math.round(performance.now() - t0) + 'ms :: ' +
        lastErrorMessage(err) + hintFor(lastErrorMessage(err)));
      throw err;
    });
  }

  function setStatus(status) {
    try { chrome.runtime.sendMessage({ type: MSG_STATUS, status: status }); }
    catch (e) { log.trace('setStatus("' + status + '") not delivered: ' + lastErrorMessage(e)); }
  }
  // --- per-run accounting ---------------------------------------------------
  function emptySummary() {
    return {
      total: 0, translated: 0, failed: 0, cacheHits: 0, applied: 0, skipped: 0,
      requests: 0, batches: 0, units: 0, persisted: 0, persistentHits: 0,
      elapsedMs: 0, firstTranslatedLatencyMs: 0, firstViewportLatencyMs: 0,
      errorCounts: {}, skipCounts: {}, errors: []
    };
  }

  // echoSegments: segments the model answered with a copy of the English
  // (renderer reason 'identical'). They get ONE more chance after the run
  // (retryEchoSegments); retryRound says "we are in that second chance now", so
  // a second copy is recorded as a fact instead of triggering another retry.
  function newStats() {
    return {
      translated: 0, failed: 0, cacheHits: 0, applied: 0, skipped: 0, requests: 0,
      errorCounts: {}, skipCounts: {}, errors: [],
      echoSegments: [], retryRound: false, echoRetried: 0
    };
  }

  // __plamo.getState() reports the counters of the run it is asked about, so they
  // are copied from the run's own stats at the places where those change -
  // otherwise a finished run reads back as "applied: 0" while the page is full of
  // translations, which is exactly the kind of thing that sends a user to the
  // console looking for a bug that is not there.
  function syncLive(stats) {
    if (!live || !stats) return;
    live.translated = stats.translated;
    live.failed = stats.failed;
    live.cacheHits = stats.cacheHits;
    live.applied = stats.applied;
    live.skipped = stats.skipped;
    live.errorCounts = stats.errorCounts;
    live.skipCounts = stats.skipCounts;
    uiEvent('progress'); // the widget reads getState() itself; this only says "look again"
  }

  function countError(stats, kind) {
    stats.errorCounts[kind] = (stats.errorCounts[kind] || 0) + 1;
    if (live) live.errorCounts = stats.errorCounts;
  }

  // A translated segment that could not be written back (node gone, page
  // re-rendered it, translation identical). Counted apart from API errors.
  function countSkip(stats, reason) {
    stats.skipCounts[reason] = (stats.skipCounts[reason] || 0) + 1;
    if (live) live.skipCounts = stats.skipCounts;
  }

  function pushError(stats, message) {
    if (stats.errors.length < 12) stats.errors.push(String(message).slice(0, 200));
  }

  // Writes a batch's translations into the DOM. The target text node always
  // comes from segmentsById (page side), because a DOM node cannot cross the
  // message boundary — that is why segments are sent as ids only. Each
  // translation lands in one Text node (node.nodeValue), never in an element,
  // so the page structure survives. Only a translation that ACTUALLY landed
  // goes into the session cache: caching before the write meant an 'identical'
  // answer (the model copying the English) was cached as a success, so every
  // later run served the copy from cache and the text was never translated
  // again. An identical answer is instead queued for one honest retry.
  function applyBatchResults(btag, res, segmentsById, stats) {
    var ids = Object.keys((res && res.results) || {});
    var applied = 0;
    var problems = [];
    ids.forEach(function (id) {
      var r = res.results[id];
      if (!r) return;
      if (r.error) {
        countError(stats, r.errorType || 'unknown');
        if (problems.length < 4) problems.push('seg#' + id + ' [' + (r.errorType || '?') + '] ' + String(r.error).slice(0, 100));
        return;
      }
      if (!r.translatedText) { countError(stats, 'empty'); return; }
      var textKey = (r.text != null) ? r.text : (segmentsById[id] && segmentsById[id].text);
      var seg = segmentsById[id];
      if (!seg) {
        stats.skipped++;
        countSkip(stats, 'unknown-segment');
        if (problems.length < 4) problems.push('seg#' + id + ' is unknown to this page (stale batch?)');
        return;
      }
      if (!seg.source || !seg.source.node) {
        stats.skipped++;
        countSkip(stats, 'no-node');
        if (problems.length < 4) problems.push('seg#' + id + ' carries no text-node reference');
        return;
      }
      var out = applySegment(seg, r.translatedText);
      if (out.ok) {
        applied++;
        if (typeof textKey === 'string' && typeof r.translatedText === 'string') {
          cache.set(textKey, r.translatedText);
          // Landed translations only: an 'identical' or refused answer must
          // never reach the cache that outlives the page, or the next visit
          // would serve the copy without ever retrying (translation/persistent.js
          // queues it here; the run's flush() writes once at the end).
          var persist = persistent();
          if (persist && persist.enabled()) persist.remember(textKey, r.translatedText);
        }
      }
      else {
        stats.skipped++;
        countSkip(stats, out.reason || 'refused');
        // The background counted this as translated; a copy of the English is
        // not a translation, so take it back out of the count.
        if (out.reason === 'identical') {
          stats.translated = Math.max(0, stats.translated - 1);
          if (!stats.retryRound) stats.echoSegments.push(seg);
        }
        if (problems.length < 4) {
          problems.push('seg#' + id + ' not written [' + out.reason + '] ' + (seg.source.path || seg.source.parentTag || ''));
        }
      }
    });
    stats.applied += applied;
    if (applied) log.trace(btag + ' wrote ' + applied + '/' + ids.length + ' translation(s) into text nodes');
    if (problems.length) log.warn(btag + ' ' + problems.length + ' problem(s): ' + problems.join(' | '));
    return applied;
  }



  // Turns one background response into counters plus log records. This is the
  // place that used to swallow every per-segment failure.
  function handleBatchResponse(btag, batchNumber, batch, res, segmentsById, stats, latencies) {
    if (!res) {
      stats.failed += batch.segments.length;
      countError(stats, 'no_response');
      pushError(stats, 'background sent no response body (' + batch.segments.length + ' segment(s) affected)');
      log.warn(btag + ' NO RESPONSE BODY :: ' + messaging.summarizeBatch(batch) + hintFor('message port closed'));
      return;
    }
    var status = res.status || (res.error ? 'failure' : 'unknown');
    var summary = messaging.summarizeResults(res.results);
    if (res.errorType === 'config' || res.errorType === 'internal') {
      log.warn(btag + ' background REJECTED the request [' + res.errorType + ']: ' + res.error);
      pushError(stats, '[' + res.errorType + '] ' + res.error);
      countError(stats, res.errorType);
    }
    var translatedCount = (typeof res.translated === 'number') ? res.translated : summary.translated;
    var failedCount = (typeof res.failed === 'number') ? res.failed : summary.failed;
    stats.translated += translatedCount;
    stats.failed += failedCount;
    stats.cacheHits += res.cacheHits || 0;
    stats.requests += (typeof res.requests === 'number') ? res.requests : 0;
    if (live) live.requests = stats.requests;
    applyBatchResults(btag, res, segmentsById, stats);
    syncLive(stats); // the counters getState() reports

    if (translatedCount && !latencies.firstTranslatedLatencyMs) {
      latencies.firstTranslatedLatencyMs = Math.round(performance.now() - latencies.t0);
      log.debug(btag + ' first translated batch in ' + latencies.firstTranslatedLatencyMs + 'ms (server=' +
        (res.profile || '?') + ' endpoint=' + (res.endpoint || '?') + ')');
    }
    if (!latencies.firstViewportLatencyMs && latencies.viewportId && res.results &&
        res.results[latencies.viewportId] && res.results[latencies.viewportId].translatedText) {
      latencies.firstViewportLatencyMs = Math.round(performance.now() - latencies.t0);
    }

    var line = btag + ' ' + status.toUpperCase() + ' ' + summary.text +
      ' server=' + (res.profile || '?') + ' endpoint=' + (res.endpoint || '?') + ' in ' + res.elapsedMs + 'ms';
    if (status === 'success') log.trace(line); else log.warn(line);
    log.batch({
      batch: batchNumber, server: res.profile || 'unknown', segments: res.segments,
      estimatedTokens: batch.estimatedTokens, elapsedMs: res.elapsedMs, status: status,
      cacheHits: res.cacheHits || 0, requests: res.requests, units: batch.units,
      strategy: res.strategy, align: res.align
    });
  }


  // A batch whose request never came back - the worker was recycled, the channel
  // closed, the request died at the timeout ceiling - is not written off. Its
  // segments are re-sent as a few small requests, one after another so a page
  // whose server is struggling is not flooded. This is what keeps "a few
  // paragraphs of the page" from staying in English after one bad request.
  // `api` is the server the batch went to the first time: a retry goes back to
  // the same API on purpose, because what died here was the extension's own
  // message channel, not the server (a server that answered 500 the first time
  // is not helped by a second server that never saw it).
  function recoverBatch(btag, batchNumber, batch, segmentsById, stats, latencies, api) {
    var per = (C.RECOVERY && C.RECOVERY.maxSegmentsPerRequest) || 6;
    var maxReq = (C.RECOVERY && C.RECOVERY.maxRequests) || 12;
    var chunks = batcher.split(batch, per);
    var droppedSegs = 0;
    if (chunks.length > maxReq) {
      droppedSegs = batch.segments.length - maxReq * per;
      log.warn(btag + ' recovery limited to ' + maxReq + ' request(s); ' + droppedSegs +
        ' segment(s) are left untranslated (raise RECOVERY.maxRequests or lower the batch caps)');
      chunks = chunks.slice(0, maxReq);
    }
    var retried = 0;
    chunks.forEach(function (ch) { retried += ch.segments.length; });
    log.warn(btag + ' RECOVERY: re-sending ' + retried + ' of ' + batch.segments.length + ' segment(s) as ' +
      chunks.length + ' smaller request(s) (' + per + ' segment(s) each, sequential)');

    var chain = Promise.resolve();
    chunks.forEach(function (chunkBatch, ci) {
      chain = chain.then(function () {
        if (abortRequested) {
          log.warn(btag + ' recovery stopped after ' + ci + ' chunk(s): stop requested');
          return;
        }
        var retryTag = btag + ' retry#' + (ci + 1);
        var payload = {
          id: messaging.makeRequestId(btag.replace(/\s+/g, '-') + '-retry' + (ci + 1)),
          type: MSG_TRANSLATE,
          batch: messaging.toWireBatch(chunkBatch),
          profileName: (api && api.name) || settings.profileName,
          concurrency: (api && api.concurrency) || settings.maxConcurrent,
          strategy: (settings.request && settings.request.strategy) || undefined,
          request: settings.request || undefined,
          cache: messaging.toWireCache(cache, chunkBatch.segments)
        };
        live.sent++;
        live.inFlight++;
        // The retries go over sendMessage on purpose: the port is what died, and
        // a small request is very likely to answer before anything else breaks.
        return sendRuntime(payload).then(function (res) {
          live.inFlight--;
          handleBatchResponse(retryTag, batchNumber, chunkBatch, res, segmentsById, stats, latencies);
        }, function (err) {
          live.inFlight--;
          stats.failed += chunkBatch.segments.length;
          countError(stats, 'transport');
          pushError(stats, lastErrorMessage(err));
          syncLive(stats);
          log.error(retryTag + ' FAILED too, ' + chunkBatch.segments.length + ' segment(s) stay untranslated: ' +
            lastErrorMessage(err) + hintFor(lastErrorMessage(err)) + ' :: ' + messaging.summarizeBatch(chunkBatch));
        });
      });
    });
    return chain.then(function () {
      if (droppedSegs > 0) {
        stats.failed += droppedSegs;
        countError(stats, 'transport');
      }
    });
  }

  var ECHO_RETRY_PROMPT =
    'You are translating into Japanese. The previous attempt returned some of these lines ' +
    'UNCHANGED: copying the English is a failure, not an answer. Rewrite EVERY line below ' +
    'in natural Japanese; every answer line must contain Japanese characters.';

  // The second chance for 'identical' answers: the model looked at the English
  // and wrote it straight back. Sometimes that is the text genuinely not being
  // worth translating (an .sr-only label - those are now filtered at extraction,
  // see content/extractor.js), but for real prose a batched prompt can be what
  // caused it: with 24 lines of mixed text a translation model loses the plot
  // and copies a line. This one round goes out as small requests carrying an
  // explicit instruction (the profiles send no instruction by default, which is
  // right for a translation model and wrong for a model that just echoed).
  // Still identical after this, it is recorded as a fact: no third round, and
  // nothing is cached either way (the cache only ever holds landed text).
  function retryEchoSegments(tag, apiSchedule, segmentsById, stats, latencies) {
    var echoes = stats.echoSegments;
    if (!echoes.length) return Promise.resolve();
    stats.retryRound = true; // set NOW: an answer arriving during this round must not re-enter the queue
    if (abortRequested) {
      log.warn(tag + ' ' + echoes.length + ' identical segment(s) are not retried: Stop is in effect');
      return Promise.resolve();
    }
    var per = (C.RECOVERY && C.RECOVERY.maxSegmentsPerRequest) || 6;
    var maxReq = (C.RECOVERY && C.RECOVERY.maxRequests) || 12;
    var chunks = batcher.split({ segments: echoes }, per);
    // One retry round per run, capped like transport recovery: a server that
    // echoes everything must not turn a run into an endless second run.
    if (chunks.length > maxReq) {
      log.warn(tag + ' echo retry limited to ' + maxReq + ' request(s); ' +
        (echoes.length - maxReq * per) + ' identical segment(s) are not retried');
      chunks = chunks.slice(0, maxReq);
    }
    var retried = 0;
    chunks.forEach(function (ch) { retried += ch.segments.length; });
    stats.echoRetried = retried;
    log.warn(tag + ' ' + echoes.length + ' segment(s) came back as a copy of the English; retrying ' +
      retried + ' of them as ' + chunks.length + ' small request(s) with an explicit do-not-copy instruction');
    var chain = Promise.resolve();
    chunks.forEach(function (chunkBatch, ci) {
      chain = chain.then(function () {
        if (abortRequested) return;
        var api = apiSchedule[ci % apiSchedule.length];
        var btag = tag + ' echo#' + (ci + 1);
        var payload = {
          id: messaging.makeRequestId('r' + runSeq + 'echo' + (ci + 1)),
          type: MSG_TRANSLATE,
          batch: messaging.toWireBatch(chunkBatch),
          profileName: api.name,
          concurrency: api.concurrency,
          strategy: (settings.request && settings.request.strategy) || undefined,
          // The one thing this round changes: the batched system prompt.
          request: Object.assign({}, settings.request || {}, { batchSystemPrompt: ECHO_RETRY_PROMPT }),
          cache: messaging.toWireCache(cache, chunkBatch.segments)
        };
        live.sent++;
        live.inFlight++;
        // sendMessage, not the run's port: these are small and the run is over,
        // and a retry should not depend on the channel that carried the big one.
        return sendRuntime(payload).then(function (res) {
          live.inFlight--;
          handleBatchResponse(btag, ci + 1, chunkBatch, res, segmentsById, stats, latencies);
        }, function (err) {
          live.inFlight--;
          stats.failed += chunkBatch.segments.length;
          countError(stats, 'transport');
          pushError(stats, lastErrorMessage(err));
          syncLive(stats);
          log.error(btag + ' echo retry FAILED for ' + chunkBatch.segments.length + ' segment(s): ' +
            lastErrorMessage(err) + hintFor(lastErrorMessage(err)));
        });
      });
    });
    return chain;
  }

  // root: the subtree to scan. opts.nodes: scan ONLY these Text nodes — the way
  // a revealed menu costs one small request instead of a fresh read of the page.
  function translatePage(root, opts) {
    abortRequested = false;
    setStatus('translating');
    var runId = ++runSeq;
    var tag = 'run#' + runId + (opts && opts.nodes ? ' reveal(' + opts.nodes.length + ' node(s))' : '');
    live = {
      runId: runId, phase: 'loading-settings', segments: 0, batches: 0, sent: 0, inFlight: 0,
      units: 0, requests: 0,
      translated: 0, failed: 0, cacheHits: 0, applied: 0, skipped: 0, errorCounts: {},
      skipCounts: {}, startedAt: Date.now()
    };
    log.info(tag + ' translatePage start (profile=' + (settings && settings.profileName) + ' cache=' + cache.map.size + ')');
    uiEvent('run-start');
    return loadSettings().then(function (s) {
      settings = s; // apply popup changes immediately
      // The saved caps have to reach the packer, which was built before settings
      // were loaded (see applyBatchSettings).
      applyBatchSettings();
      // Which APIs this run sends through. Every ticked server gets a share of
      // the batches weighted by its own concurrency (shared/settings.js
      // apiPlan); the send ORDER stays priority-first, only the destination of
      // each batch alternates. One API reproduces the old single-server run.
      var apiSchedule = apiPlan(settings);
      live.apis = activeApis(settings);
      live.apiSplit = {};
      // What this run sends, and what the scan held back because the user could
      // not see it. The held-back nodes are not wasted: the reveal watch below
      // translates them as soon as the page displays them.
      var built = collectSegments(root || document, opts);
      var segments = built.segments;
      live.segments = segments.length;
      live.deferred = built.stats.deferred;
      live.roles = built.roles || null;
      // What this scan held back goes on the waiting list; what it sent does not.
      var sentNodes = new Set();
      segments.forEach(function (seg) { if (seg && seg.source && seg.source.node) sentNodes.add(seg.source.node); });
      keepDeferred(built.deferred, sentNodes);
      log.info(tag + ' extracted segments=' + segments.length + ' viewport=' + JSON.stringify(countViewport(segments)) +
        ' roles=' + JSON.stringify(built.roles || {}) + ' deferred=' + built.stats.deferred +
        ' deferHidden=' + built.stats.deferHidden +
        ' profile=' + settings.profileName + ' maxConcurrent=' + settings.maxConcurrent +
        ' apis=' + live.apis.map(function (a) { return a.name + '\u00d7' + a.concurrency; }).join('+') +
        ' cache=' + cache.map.size + ' cacheHits=' + cache.hits);
      if (!segments.length) {
        setStatus('idle');
        live.phase = 'idle';
        lastRun = emptySummary();
        log.warn(tag + ' nothing to translate (0 segments' + (built.stats.deferred ?
          ', but ' + built.stats.deferred + ' hidden text node(s) are held back and will be translated when displayed' : '') +
          '). If this page is English and untouched, check __plamo.getPending().');
        uiEvent('run-end');
        return lastRun;
      }

      segments = sortSegments(segments);
      var segmentsById = {};
      segments.forEach(function (s) { segmentsById[s.id] = s; });

      // The cache that outlives the page (translation/persistent.js): ask
      // storage about every text this page's session cache does not hold, and
      // feed the exact matches into that session cache before packing, so the
      // background answers them as ordinary cache hits and they never cross the
      // wire. The first request goes out only after that one read answers: a
      // back-button page should cost milliseconds, not minutes.
      var persist = persistent();
      var persistentHits = 0;
      var prework = null;
      if (persist) {
        persist.configure(settings.cache);
        if (persist.enabled()) {
          var toAsk = [];
          var asked = {};
          segments.forEach(function (seg) {
            var t = seg.text;
            if (!t || asked[t] || cache.map.has(t)) return; // the session cache is the hot layer
            asked[t] = true;
            toAsk.push(t);
          });
          prework = persist.lookup(toAsk).then(function (r) {
            Object.keys(r.hits).forEach(function (text) { cache.set(text, r.hits[text]); });
            persistentHits = Object.keys(r.hits).length;
            if (live) live.persistentHits = persistentHits;
            if (persistentHits) {
              log.info(tag + ' persistent cache: ' + persistentHits + ' of ' + r.queried +
                ' unseen text(s) were translated on an earlier visit' +
                (r.reused ? ', ' + r.reused + ' reuse(s) counted' : '') +
                (r.skipped ? ' (' + r.skipped + ' text(s) too long to look up)' : ''));
            }
          });
        }
      }
      // Packing and sending wait for that read; everything below is the run as
      // it always was, with the persistent hits already inside `cache`.
      return (prework || Promise.resolve()).then(function () {
        // One batch = one API request: the units are the blocks the segments
        // came from, the batches are what one request will carry.
        var unitList = batcher.units(segments);
        var batches = batcher.batchUnits(segments);
        live.batches = batches.length;
        live.units = unitList.length;
        var t0 = performance.now();
        var stats = newStats();
        stats.batches = batches.length;
        var latencies = { t0: t0, firstTranslatedLatencyMs: 0, firstViewportLatencyMs: 0, viewportId: null };
        segments.forEach(function (s) { if (s.viewport === 1 && !latencies.viewportId) latencies.viewportId = s.id; });
        log.info(tag + ' packing segments=' + segments.length + ' blocks=' + unitList.length +
          ' requests=' + batches.length + ' caps=' + batcherCaps.maxSegmentsPerBatch + 'seg/' +
          batcherCaps.maxEstimatedTokensPerBatch + 'tok first=' + batcherCaps.firstBatchMaxSegments +
          ' short=' + batcherCaps.maxShortSegmentsPerBatch + '@' + batcherCaps.shortSegmentTokens + 'tok' +
          ' strategy=' + ((settings.request && settings.request.strategy) || 'multi') +
          ' (segments/request=' + (batches.length ? (segments.length / batches.length).toFixed(1) : '0') + ')');
        log.trace(tag + ' batches=' + batches.length + ' ' + batches.map(function (b, i) {
          return '#' + (i + 1) + ':' + b.segments.length + 'seg/' + b.units + 'blk/' + b.estimatedTokens + 'tok';
        }).join(' '));
        live.phase = 'translating';
        // One port for the whole run: it answers whenever a batch is ready instead
        // of on a channel that closes under a minutes-long request.
        openChannel(tag);
        live.channel = channel ? 'port' : 'sendMessage';

        var promises = batches.map(function (batch, batchIndex) {
          var btag = tag + ' batch#' + (batchIndex + 1);
          // This batch's destination: the weighted round-robin over every ticked
          // API. Its own concurrency rides along so the worker bounds THAT
          // server's queue, not a global one.
          var api = apiSchedule[batchIndex % apiSchedule.length];
          live.apiSplit[api.name] = (live.apiSplit[api.name] || 0) + 1;
          // Only wire-safe fields cross the boundary; the cache travels as a plain
          // object limited to this batch (a Map would arrive as "{}").
          var payload = {
            id: messaging.makeRequestId('r' + runId + 'b' + (batchIndex + 1)),
            type: MSG_TRANSLATE,
            batch: messaging.toWireBatch(batch),
            profileName: api.name,
            concurrency: api.concurrency,
            // No timeoutMs: a batched request answers many segments at once, so the
            // background scales the timeout with the size of the batch.
            strategy: (settings.request && settings.request.strategy) || undefined,
            request: settings.request || undefined,
            cache: messaging.toWireCache(cache, batch.segments)
          };
          live.sent++;
          live.inFlight++;
          return sendTranslate(payload).then(function (res) {
            live.inFlight--;
            handleBatchResponse(btag, batchIndex + 1, batch, res, segmentsById, stats, latencies);
          }, function (err) {
            live.inFlight--;
            var message = lastErrorMessage(err);
            countError(stats, 'transport');
            pushError(stats, message);
            log.error(btag + ' TRANSPORT FAILURE for ' + batch.segments.length + ' segment(s): ' + message +
              hintFor(message) + ' :: ' + messaging.summarizeBatch(batch));
            // Nothing was written, so nothing is lost yet: give the segments a
            // second chance in requests small enough to answer.
            return recoverBatch(btag, batchIndex + 1, batch, segmentsById, stats, latencies, api);
          });
        });

        return Promise.all(promises).then(function () {
          // Batches are all answered; identical answers get their one retry here,
          // still inside the run so the summary below reports the real outcome.
          return retryEchoSegments(tag, apiSchedule, segmentsById, stats, latencies);
        }).then(function () {
          closeChannel('run#' + runId + ' finished');
          // Everything this run landed goes to the cache that outlives the page
          // in ONE write (translation/persistent.js queued it as it landed).
          var flushed = (persist && persist.enabled()) ? persist.flush() : Promise.resolve({ written: 0 });
          return flushed.then(function (flushRes) {
            var summary = {
              total: segments.length,
              translated: stats.translated,
              failed: stats.failed,
              cacheHits: stats.cacheHits,
              applied: stats.applied,
              skipped: stats.skipped,
              requests: stats.requests,
              batches: batches.length,
              units: unitList.length,
              // What the cache that outlives the page served this run
              // (persistentHits) and stored for the next page view (persisted).
              persisted: flushRes.written,
              persistentHits: persistentHits,
              // How the run split its batches over the APIs it used.
              apiSplit: live ? Object.assign({}, live.apiSplit) : null,
              elapsedMs: Math.round(performance.now() - t0),
              firstTranslatedLatencyMs: latencies.firstTranslatedLatencyMs,
              firstViewportLatencyMs: latencies.firstViewportLatencyMs,
              errorCounts: stats.errorCounts,
              skipCounts: stats.skipCounts,
              echoRetried: stats.echoRetried,
              errors: stats.errors
            };
            setStatus('idle');
            live.phase = 'idle';
            lastRun = summary;
            var endLine = tag + ' done total=' + summary.total + ' translated=' + summary.translated +
              ' applied=' + summary.applied + ' failed=' + summary.failed + ' skipped=' + summary.skipped +
              ' cacheHits=' + summary.cacheHits + ' requests=' + summary.requests +
              ' (' + summary.batches + ' request(s) for ' + summary.total + ' segment(s))' +
              (summary.echoRetried ? ' echo-retried=' + summary.echoRetried : '') +
              ' persisted=' + summary.persisted + ' persistentHits=' + summary.persistentHits +
              ' in ' + summary.elapsedMs + 'ms' +
              ' firstTranslated=' + summary.firstTranslatedLatencyMs + 'ms cache=' + cache.map.size;
            if (summary.failed) log.warn(endLine); else log.info(endLine);
            if (Object.keys(stats.errorCounts).length) {
              log.warn(tag + ' failure breakdown ' + JSON.stringify(stats.errorCounts) +
                ' :: every failure is logged per segment; replay them with __plamo.getLogs({ level: "warn" })');
            }
            if (Object.keys(stats.skipCounts).length) {
              log.warn(tag + ' translated but not written ' + JSON.stringify(stats.skipCounts) +
                ' :: "changed-after-extract" means the page re-rendered that node ' +
                '(SPA); "identical" means the model copied the English, retried once ' +
                '(see the echo#N lines); see __plamo.getApplied() for what did land and ' +
                '__plamo.getUntranslated() for what is still in English');
            }
            uiEvent('run-end');
            return summary;
          });
        });
      });
    }).catch(function (err) {
      closeChannel('run#' + runId + ' aborted');
      if (live) live.phase = 'idle';
      setStatus('idle');
      uiEvent('run-abort');
      log.error(tag + ' ABORTED: ' + lastErrorMessage(err) +
        ' stack=' + String((err && err.stack) || '').split('\n').slice(0, 4).join(' | '));
      throw err;
    });
  }

  function countViewport(segments) {
    var visible = 0, near = 0, rest = 0;
    segments.forEach(function (s) {
      if (s.viewport === 1) visible++;
      else if (s.viewport === 2) near++;
      else rest++;
    });
    return { visible: visible, near: near, other: rest };
  }

  // Stop is one action whether it arrives as MSG_STOP (popup/widget) or from
  // the console (__plamo.stopTranslation()); the widget needs the same event.
  function stopRun() {
    abortRequested = true;
    setStatus('idle');
    // A reveal of its own starts a NEW run, so a Stop that only paused the
    // batches in flight would still end up sending requests minutes later.
    // The waiting list is kept: the next run holds those nodes back again and
    // resumes watching them (see keepDeferred).
    stopRevealWatch('stop requested');
    uiEvent('stop');
    log.warn('stop requested (run#' + (live ? live.runId : '-') + '); in-flight batches are not cancelled, their results are still applied' +
      (deferredNodes.length ? '; ' + deferredNodes.length + ' hidden text node(s) stay untranslated and unwatched until the next run' : ''));
    return Promise.resolve({ ok: true, aborted: true, waitingForDisplay: deferredNodes.length, state: getState() });
  }

  function handleMessage(request) {
    if (!request || !request.type) {
      log.warn('recv message with no type keys=' + Object.keys(request || {}).join('/'));
      return Promise.resolve({ error: 'message without a "type" field', errorType: 'config' });
    }
    log.trace('recv ' + messaging.summarizeMessage(request));
    if (request.type === MSG_TRANSLATE_PAGE) {
      return translatePage(request.root);
    }
    if (request.type === MSG_RESTORE) {
      var restoredNow = restoreAll(request.root);
      setStatus('idle');
      log.info('restore requested: ' + restoredNow + ' text node(s) back to the original, ' +
        renderer.appliedCount() + ' still translated');
      return Promise.resolve({ ok: true, restored: restoredNow, translated: renderer.appliedCount(), state: getState() });
    }
    if (request.type === MSG_STOP) {
      return stopRun();
    }
    if (request.type === MSG_STATUS) {
      return Promise.resolve(getState());
    }
    var handled = [MSG_TRANSLATE_PAGE, MSG_RESTORE, MSG_STOP, MSG_STATUS];
    log.warn('unknown message type "' + request.type + '" | handled: ' + handled.join(', '));
    return Promise.resolve({ error: 'unknown message type: ' + request.type, handledTypes: handled, errorType: 'config' });
  }

  // Same rule as in the background: answering asynchronously requires returning
  // true, otherwise the sender sees "The message port closed before a response
  // was received."
  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    var p;
    try {
      p = handleMessage(msg, sender);
    } catch (syncErr) {
      log.error('message handler THREW synchronously: ' + lastErrorMessage(syncErr) +
        ' stack=' + String((syncErr && syncErr.stack) || '').split('\n').slice(0, 4).join(' | '));
      try { sendResponse({ error: lastErrorMessage(syncErr), errorType: 'internal' }); } catch (e) { /* channel closed */ }
      return false;
    }
    if (p && p.then) {
      p.then(function (res) {
        try { sendResponse(res); }
        catch (e) { log.warn('sendResponse threw (popup closed mid-request?): ' + lastErrorMessage(e)); }
      }, function (err) {
        log.error('message handler REJECTED: ' + lastErrorMessage(err) +
          ' stack=' + String((err && err.stack) || '').split('\n').slice(0, 4).join(' | '));
        try { sendResponse({ error: lastErrorMessage(err), errorType: 'internal' }); } catch (e) { /* channel closed */ }
      });
      return true;
    }
    try { sendResponse(p); } catch (e) { log.warn('sendResponse threw: ' + lastErrorMessage(e)); }
    return false;
  });

  // --- live state + diagnostics (page console: __plamo.<name>()) ------------
  function getState() {
    var l = live || { phase: abortRequested ? 'aborted' : 'idle' };
    return {
      phase: l.phase || 'idle',
      runId: l.runId || null,
      segments: l.segments || 0,
      batches: l.batches || 0,
      units: l.units || 0,
      requests: l.requests || 0,
      sent: l.sent || 0,
      inFlight: l.inFlight || 0,
      translated: l.translated || 0,
      failed: l.failed || 0,
      cacheHits: l.cacheHits || 0,
      applied: l.applied || 0,
      skipped: l.skipped || 0,
      errorCounts: l.errorCounts || {},
      skipCounts: l.skipCounts || {},
      renderedNodes: renderer.appliedCount(),
      // Region counts of the current/last run and the hidden text it held back;
      // waitingForDisplay is what the reveal watch is still waiting for.
      roles: l.roles || null,
      deferred: l.deferred || 0,
      waitingForDisplay: deferredNodes.length,
      reveal: Object.assign({}, revealStats),
      // How the last/current run talks to the worker: 'port' is the durable
      // channel, 'sendMessage' means connect() was unavailable to this page.
      channel: l.channel || (channel ? 'port' : 'sendMessage'),
      // The APIs this run sends (or sent) through, and how the batches split
      // over them (see __plamo.getApiPlan()).
      apis: l.apis || null,
      apiSplit: l.apiSplit || null,
      abortRequested: abortRequested,
      cache: { entries: cache.map.size, hits: cache.hits, misses: cache.misses },
      profile: settings.profileName || null,
      lastRun: lastRun || null,
      logger: ns.logger.stats()
    };
  }

  // What *would* be translated right now, without sending a request: the fastest
  // way to separate "no English text found" from "the request failed".
  function getPending(opts) {
    var root = (opts && opts.root) || document;
    var built = collectSegments(root, null);
    var segments = built.segments;
    return {
      count: segments.length,
      viewport: countViewport(segments),
      // Which region each segment belongs to, and what this scan would hold
      // back because the user cannot see it (see __plamo.getDeferred()).
      roles: built.roles || null,
      deferredHidden: built.stats.deferred,
      deferHidden: built.stats.deferHidden,
      waitingForDisplay: deferredNodes.length,
      // Text nodes we have already rewritten (see __plamo.getApplied()).
      alreadyTranslated: renderer.appliedCount(),
      cacheEntries: cache.map.size,
      // Which subtree the extractor actually walked, and what it refused: a
      // "0 segments" answer on an English page is explained by these numbers.
      scan: ns.extractor.scanStats(),
      sample: segments.slice(0, 10).map(function (s) {
        return {
          id: s.id, viewport: s.viewport, role: s.role, priority: s.priority,
          hidden: s.hidden, chars: s.text.length,
          hasNode: !!(s.source && s.source.node), path: (s.source && s.source.path) || '',
          parentTag: (s.source && s.source.parentTag) || '',
          cached: cache.map.has(s.text),
          text: s.text.slice(0, 60)
        };
      })
    };
  }

  // How a run WOULD be packed, without sending a single request: the quick way
  // to check the grouping on a real page. A wall of menu items should come back
  // as a couple of big requests; if `requests` is close to `segments`, either the
  // caps are too small or the texts are too long for one request.
  function getBatchPlan(opts) {
    var root = (opts && opts.root) || document;
    applyBatchSettings();
    var built = collectSegments(root, null);
    var segments = sortSegments(built.segments);
    var unitList = batcher.units(segments);
    var batches = batcher.batchUnits(segments);
    return {
      segments: segments.length,
      blocks: unitList.length,
      requests: batches.length,
      segmentsPerRequest: batches.length ? Number((segments.length / batches.length).toFixed(1)) : 0,
      caps: batcherCaps, // what the packer in use was built with
      strategy: (settings && settings.request && settings.request.strategy) || C.REQUEST_SETTINGS.strategy,
      // Which APIs the next run would use, and with what per-API limits.
      servers: activeApis(settings),
      viewport: countViewport(segments),
      // The order the packer sees: article body first, then headings, then page
      // chrome. `deferredHidden` is text a run would not send at all, because
      // the user cannot see it (see __plamo.getDeferred()).
      roles: built.roles || null,
      deferredHidden: built.stats.deferred,
      deferHidden: built.stats.deferHidden,
      batches: batches.slice(0, (opts && opts.limit) || 8).map(function (b, i) {
        return {
          index: i + 1, segments: b.segments.length, blocks: b.units,
          estimatedTokens: b.estimatedTokens,
          roles: ns.priority ? ns.priority.histogram(b.segments) : null,
          sample: b.segments.slice(0, 3).map(function (s) { return (s.role || '?') + ':' + s.text.slice(0, 32); })
        };
      })
    };
  }

  // "Some paragraphs are still English" in one answer: scan the page NOW and
  // list the visible English text a fresh run would send and has never written.
  // Text we rewrote is not here; hidden text is reported apart (it waits on
  // purpose); text the extractor refused for size shows up in scan.tooLong, and
  // __plamo.getSegmentStats().skipped says what the segmenter dropped.
  function getUntranslated(opts) {
    var root = (opts && opts.root) || document;
    var built = collectSegments(root, null);
    var missing = built.segments.filter(function (s) {
      return s.source && s.source.node && !renderer.isApplied(s.source.node);
    });
    var scan = ns.extractor.scanStats();
    return {
      count: missing.length,
      alreadyApplied: built.segments.length - missing.length,
      // Not missing: held back until displayed, the reveal watch translates it.
      deferredHidden: built.stats.deferred,
      waitingForDisplay: deferredNodes.length,
      // scan.tooLong / segmentSkipped: text never became a segment at all.
      scan: scan,
      segmentSkipped: built.stats.skipped,
      sample: missing.slice(0, (opts && opts.limit) || 15).map(function (s) {
        return {
          id: s.id, role: s.role, viewport: s.viewport, chars: s.text.length,
          path: (s.source && s.source.path) || '',
          cached: cache.map.has(s.text),
          text: s.text.slice(0, 80)
        };
      })
    };
  }

  // Pulls the background worker's own log ring buffer into this console: the
  // service-worker console is awkward to open, and its logs vanish when the
  // worker gets recycled.
  function backgroundLogs(opts) {
    return sendRuntime({ type: MSG_DIAGNOSTICS, limit: (opts && opts.limit) || 200 }).then(function (res) {
      if (!res) { log.warn('backgroundLogs: background replied with no body'); return null; }
      if (res.error) { log.warn('backgroundLogs: background replied "' + res.error + '"'); return res; }
      log.info('background state ' + JSON.stringify(res.state));
      (res.logs || []).forEach(function (r) { console.log('[PLaMoTranslate/bg] #' + r.i + ' [' + r.level + '] ' + r.text); });
      return res;
    }, function (err) {
      var message = lastErrorMessage(err);
      return { error: message, hint: hintFor(message) };
    });
  }

  function pingBackground() {
    return sendRuntime({ type: C.MSG_PING }).then(function (res) {
      log.info('background pong ' + JSON.stringify(res));
      return res;
    }, function (err) {
      var message = lastErrorMessage(err);
      log.error('ping failed: ' + message + hintFor(message));
      return { error: message, hint: hintFor(message) };
    });
  }

  // Puts every text node we changed back to the value it had before we touched
  // it. The originals live in the renderer's registry, not in data-* attributes,
  // so the page ends up exactly as it was loaded (no leftover attributes).
  function restoreAll(root) {
    forgetDeferred('restoreAll: nothing is being waited for');
    var restored = restoreNodes(root);
    log.info('restored ' + restored + ' text node(s) to the original text');
    uiEvent('restore');
    return restored;
  }

  // --- hidden text, and the watch for the page showing it ---------------------
  // A scan hands over the Text nodes it did not send because the user could not
  // see them: a closed dropdown, a modal, the mobile copy of a menu. That text
  // is worth a request only once somebody can read it, so the nodes are kept
  // here and re-checked when the page touches their style. Whatever turns out
  // visible goes through the same pipeline as a normal run — as its own small
  // run (see translatePage's opts.nodes), never as a re-read of the whole page.
  var deferredNodes = []; // { node, parent } in document order
  var deferredSeen = new Set(); // the same Text node is never remembered twice
  var revealStats = { scans: 0, checks: 0, revealed: 0, detached: 0, alreadyTranslated: 0, lastScanMs: 0, at: null };
  var revealTimer = null;
  var revealPoll = null;
  var revealObserver = null;
  // The attributes a page toggles when it opens something: an inline style or a
  // class on the container, or [hidden]/aria-hidden. childList is deliberately
  // not observed: text the page inserts arrives with the next run anyway.
  var REVEAL_ATTRS = ['style', 'class', 'hidden', 'aria-hidden', 'inert', 'open'];

  // Remembers what a scan held back, and starts watching while any is left.
  // The waiting list across runs: add what this scan held back, and drop what
  // must not be waited for any more - a node this run just sent, and a node that
  // already carries a translation (a reveal may have handled it between two runs,
  // and a run that re-collects it as visible would otherwise leave it queued
  // forever, translating the same text on every run).
  function keepDeferred(deferred, sentNodes) {
    var dropped = 0;
    deferredNodes = deferredNodes.filter(function (entry) {
      var node = entry.node;
      if (node && (!sentNodes || !sentNodes.has(node)) && !renderer.isApplied(node)) return true;
      if (node) deferredSeen.delete(node);
      dropped++;
      return false;
    });
    if (dropped) {
      log.trace('reveal: ' + dropped + ' waiting node(s) dropped (sent by this run or already translated)');
    }
    var fresh = 0;
    (deferred || []).forEach(function (node) {
      if (!node || deferredSeen.has(node)) return;
      // A node this run is translating, or one that already carries a
      // translation, is not something to wait for - the extractor hands over
      // hidden nodes whether or not they have been written to already.
      if (sentNodes && sentNodes.has(node)) return;
      if (renderer.isApplied(node)) return;
      deferredSeen.add(node);
      deferredNodes.push({ node: node, parent: node.parentNode });
      fresh++;
    });
    if (!fresh) {
      // Nothing new, but something IS waiting: after a Stop the list is still
      // full, the next run holds the same nodes back again, and that run has to
      // resume watching them (stopRevealWatch left deferredSeen intact).
      if (deferredNodes.length) startRevealWatch();
      return 0;
    }
    var d = prioritySettings();
    log.info('deferring ' + fresh + ' hidden text node(s) until the page shows them; ' +
      deferredNodes.length + ' waiting (re-check ' + d.revealDebounceMs + 'ms after a style change, ' +
      'and every ' + d.revealIntervalMs + 'ms)');
    startRevealWatch();
    return fresh;
  }

  // Forget everything we were waiting for (restoreAll, or a caller that knows
  // the page state changed completely).
  function forgetDeferred(why) {
    var n = deferredNodes.length;
    deferredNodes = [];
    deferredSeen.clear();
    stopRevealWatch(why ? (why + ' (' + n + ' node(s) forgotten)') : null);
    return n;
  }

  // What is still waiting to be displayed, for the console: __plamo.getDeferred().
  function deferredSample(limit) {
    var max = (limit == null) ? 10 : limit;
    return {
      waiting: deferredNodes.length,
      watching: !!(revealObserver || revealPoll || revealTimer),
      attrs: REVEAL_ATTRS.slice(),
      stats: Object.assign({}, revealStats),
      sample: deferredNodes.slice(0, max).map(function (entry) {
        var parent = entry.parent;
        return {
          path: ns.segmenter.describePath(parent),
          tag: (parent && parent.tagName) || '',
          text: String((entry.node && entry.node.nodeValue) || '').replace(/\s+/g, ' ').trim().slice(0, 60)
        };
      })
    };
  }

  // One check per burst of style changes, not one per mutation: opening a menu
  // touches a class, a style and an aria attribute at once.
  function scheduleReveal(ms) {
    if (revealTimer || !deferredNodes.length) return;
    var d = prioritySettings();
    revealTimer = setTimeout(function () {
      revealTimer = null;
      checkRevealed('scan');
    }, ms || d.revealDebounceMs);
    if (revealTimer.unref) revealTimer.unref(); // never hold a page (or a test run) open
  }

  // The watcher exists only while hidden text is waiting: a page with nothing
  // deferred costs nothing to watch.
  function startRevealWatch() {
    if (!deferredNodes.length) return;
    if (!ns.priority || !ns.priority.createVisibility) {
      log.warn('reveal: content/priority.js is not loaded before content.js; ' +
        deferredNodes.length + ' hidden text node(s) are dropped instead of waited for');
      forgetDeferred('no priority module');
      return;
    }
    if (!revealPoll) {
      var d = prioritySettings();
      // The interval is the fallback for a page that shows text through a rule we
      // never see change (an ancestor class, a stylesheet swap). The observer is
      // the fast path; the interval only runs while something is still waiting.
      revealPoll = setInterval(function () { checkRevealed('poll'); }, d.revealIntervalMs);
      if (revealPoll.unref) revealPoll.unref();
    }
    if (!revealObserver && typeof MutationObserver === 'function') {
      var observed = document.documentElement || document.body;
      if (observed) {
        revealObserver = new MutationObserver(function (records) {
          var attrs = {};
          records.forEach(function (r) { attrs[r.attributeName] = (attrs[r.attributeName] || 0) + 1; });
          log.trace('reveal: ' + records.length + ' attribute change(s) ' + JSON.stringify(attrs));
          scheduleReveal();
        });
        revealObserver.observe(observed, { attributes: true, subtree: true, attributeFilter: REVEAL_ATTRS });
        log.trace('reveal: watching ' + REVEAL_ATTRS.join('/') + ' under <' + String(observed.nodeName).toLowerCase() + '>');
      }
    }
    scheduleReveal();
  }

  function stopRevealWatch(why) {
    if (revealObserver) { try { revealObserver.disconnect(); } catch (e) { /* already gone */ } revealObserver = null; }
    if (revealPoll) { clearInterval(revealPoll); revealPoll = null; }
    if (revealTimer) { clearTimeout(revealTimer); revealTimer = null; }
    if (why) log.info('reveal watch stopped: ' + why);
  }

  // Is any held-back node visible now? A node the page took out of the document
  // is dropped — nobody will ever read it. A node we already rewrote is dropped
  // too, so re-opening the same menu does not pay for the same text twice.
  function checkRevealed(why) {
    if (!deferredNodes.length) { stopRevealWatch('nothing waiting'); return []; }
    if (!document.body) return [];
    var t0 = performance.now();
    var d = prioritySettings();
    var vis = ns.priority.createVisibility(document.body, { maxHiddenChecks: d.maxHiddenChecks });
    var ready = [];
    var kept = [];
    deferredNodes.forEach(function (entry) {
      revealStats.checks++;
      if (!vis.attached(entry.parent)) {
        revealStats.detached++;
        deferredSeen.delete(entry.node);
        return;
      }
      if (renderer.isApplied(entry.node)) {
        revealStats.alreadyTranslated++;
        deferredSeen.delete(entry.node);
        return;
      }
      if (vis.hidden(entry.parent)) { kept.push(entry); return; }
      deferredSeen.delete(entry.node);
      ready.push(entry.node);
    });
    deferredNodes = kept;
    revealStats.scans++;
    revealStats.revealed += ready.length;
    revealStats.lastScanMs = Math.round(performance.now() - t0);
    revealStats.at = new Date().toISOString();
    log.info('reveal scan (' + why + '): ' + ready.length + ' of ' + (ready.length + kept.length) +
      ' hidden node(s) displayed now, ' + kept.length + ' still hidden, ' + revealStats.detached +
      ' detached, ' + revealStats.alreadyTranslated + ' already translated (' +
      revealStats.lastScanMs + 'ms, visibility ' + JSON.stringify(vis.stats()) + ')');
    if (!deferredNodes.length) stopRevealWatch('nothing waiting');
    if (ready.length) translateRevealed(ready);
    return ready;
  }

  // Put nodes back on the waiting list: the reveal scan already took them out,
  // and nothing was sent for them yet.
  function holdRevealed(nodes) {
    (nodes || []).forEach(function (node) {
      if (!node || deferredSeen.has(node)) return;
      deferredSeen.add(node);
      deferredNodes.push({ node: node, parent: node.parentNode });
    });
    return deferredNodes.length;
  }

  // A run owns the pipeline, so a reveal that lands while one is in flight is
  // handed back to the next scan instead of fighting the packer for the same
  // text nodes. Stop is honoured the same way: it means "no more requests", and
  // the nodes stay on the waiting list for the run the user asks for next.
  function translateRevealed(nodes) {
    if (abortRequested) {
      holdRevealed(nodes);
      log.info('reveal: ' + nodes.length + ' displayed node(s) are not translated: Stop is in effect ' +
        '(' + deferredNodes.length + ' waiting, __plamo.translatePage() starts a run that picks them up)');
      stopRevealWatch('stop is in effect');
      return null;
    }
    if (live && live.phase && live.phase !== 'idle') {
      log.info('reveal: ' + nodes.length + ' node(s) wait for run#' + live.runId + ' to finish');
      holdRevealed(nodes);
      scheduleReveal(prioritySettings().revealIntervalMs);
      return null;
    }
    log.info('reveal: translating ' + nodes.length + ' node(s) the page just displayed');
    return translatePage(document.body || document, { nodes: nodes }).catch(function (err) {
      log.warn('reveal run failed: ' + lastErrorMessage(err)); // translatePage logged the details
    });
  }

  var manifestVersion = null;
  try { manifestVersion = chrome.runtime.getManifest().version; } catch (e) { /* unavailable */ }

  window.__plamo = {
    version: manifestVersion,
    // diagnostics
    getState: getState,
    getPending: getPending,
    // "what is still English and why": visible text a fresh run would send that
    // we never wrote, plus what the scan refused (see getSegmentStats).
    getUntranslated: getUntranslated,
    // How the next run would be packed into API requests (no request is sent).
    getBatchPlan: getBatchPlan,
    // The caps the packer in use was built with: proves a saved setting landed.
    getBatcherCaps: function () { return Object.assign({}, batcherCaps); },
    // Which page<->worker channel the current/last run used. 'port' is the
    // durable one a batched request needs; 'sendMessage' means connect() was not
    // available and a minutes-long request may be lost in transport.
    getChannel: function () {
      return channel
        ? { kind: 'port', name: C.PORT_TRANSLATE, requests: channel.requests, pending: Object.keys(channel.pending) }
        : { kind: 'none', name: C.PORT_TRANSLATE, requests: 0, pending: [] };
    },
    getRecoveryCaps: function () { return Object.assign({}, C.RECOVERY); },
    // The APIs a run would send through right now (settings.apis), and the
    // weighted round-robin schedule that decides which batch gets which server.
    getApiPlan: function () { return { active: activeApis(settings), schedule: apiPlan(settings) }; },
    // One row per text node whose nodeValue we replaced: { path, before, after }.
    getApplied: function (limit) { return renderer.appliedSample(limit); },
    scanStats: function () { return ns.extractor.scanStats(); },
    // What the last scan saw per region, and what it refused to send (skipped).
    getSegmentStats: function () { return ns.segmenter.lastStats(); },
    // The hidden text a scan held back and what the reveal watch has done with
    // it. revealNow() forces the "is it displayed yet?" check; forgetDeferred()
    // drops the list (a page that was re-rendered from scratch).
    getDeferred: function (limit) { return deferredSample(limit); },
    revealNow: function () { return checkRevealed('console'); },
    forgetDeferred: function () { return forgetDeferred('console'); },
    getLogs: function (opts) { return ns.logger.getLogs(opts); },
    dumpLogs: function (opts) { return ns.logger.dumpLogs(opts); },
    clearLogs: function () { return ns.logger.clearLogs(); },
    setVerbose: function (on) { return ns.logger.setVerbose(on); },
    setDebug: function (on) { return ns.logger.setDebug(on); },
    backgroundLogs: backgroundLogs,
    pingBackground: pingBackground,
    // actions
    translatePage: function (root, opts) { return translatePage(root, opts); },
    // The same Stop the widget's button offers mid-run: in-flight batches are
    // not cancelled, but no new request (not even a reveal) goes out.
    stopTranslation: function () { return stopRun(); },
    restoreAll: function (root) { return restoreAll(root); },
    // Undo one text node (pass the Text node itself) — console debugging.
    restoreText: function (node) { return restoreNode(node); },
    getCache: function () {
      return {
        entries: cache.map.size, hits: cache.hits, misses: cache.misses,
        keys: Array.from(cache.map.keys()).slice(0, 20).map(function (k) { return String(k).slice(0, 40); })
      };
    },
    clearCache: function () { cache.clear(); log.info('session cache cleared'); return cache.map.size; },
    // The cache that outlives the page (translation/persistent.js). snapshot()
    // deliberately never enumerates storage - that is what maintain() costs -
    // so the stored-side counts come from clear() or the DevTools storage pane.
    getPersistentCache: function () {
      var p = persistent();
      if (!p) return { error: 'translation/persistent.js is not loaded' };
      var snap = p.snapshot();
      snap.entryPrefix = 'plamo-t-';
      return snap;
    },
    clearPersistentCache: function () {
      var p = persistent();
      if (!p) return Promise.resolve({ removed: 0, error: 'translation/persistent.js is not loaded' });
      return p.clear().then(function (r) {
        log.info('persistent cache cleared: ' + r.removed + ' stored entry(s) removed, ' +
          r.pendingDropped + ' not yet written');
        return r;
      });
    },
    getSettings: function () { return settings; },
    translateSegment: function (segment, opts) { return translateSegment(getProfile(settings.profileName), segment, opts); }
  };

  var prio0 = prioritySettings();
  log.info('content script ready v' + manifestVersion +
    ' (send order ' + ((C.PRIORITY_ROLES || []).join(' > ') || 'viewport only') +
    ', deferHidden=' + prio0.deferHidden + ', re-check hidden text ' + prio0.revealDebounceMs +
    'ms after a style change and every ' + prio0.revealIntervalMs + 'ms)');
  log.info('diagnostics: __plamo.getState(), __plamo.getPending(), __plamo.getUntranslated(), ' +
    '__plamo.getDeferred(), __plamo.getBatchPlan(), __plamo.dumpLogs(), __plamo.pingBackground()');
  setStatus('idle');
})();
