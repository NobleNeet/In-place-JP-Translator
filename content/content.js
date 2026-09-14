// content/content.js
// Classic-script orchestrator. Runs in the page's content-script scope.
// Loads in order: logger, constants, settings, profiles, openai-client,
// extractor, segmenter, renderer, batcher, cache, queue.
//
// Flow: collect TEXT NODES -> one segment per text node -> order by viewport
// priority -> pack the segments into batches, where one batch is ONE API
// request (paragraph fragments stay together, menu/list items are piled into
// the same request) -> send each batch to the background (in parallel,
// concurrency bound = requests in flight) -> write each finished translation
// into its own text node (node.nodeValue only) as soon as its batch arrives.
// Because an element's children are never replaced, links/forms/images survive
// and the layout holds. MSG_RESTORE (or __plamo.restoreAll()) puts the original
// values back.
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

  // buildSegments() walks the tree for translatable Text nodes (document
  // order) and attaches each one to its segment through segment.source.node.
  var buildSegments = ns.segmenter.buildSegments;
  var sortSegmentsByViewport = ns.segmenter.sortSegmentsByViewport;
  // applySegment writes into a Text node (node.nodeValue only); the renderer
  // keeps the registry that makes restoreAll possible.
  var renderer = ns.renderer;
  var applySegment = ns.renderer.applySegment;
  var restoreNode = ns.renderer.restore;
  var restoreNodes = ns.renderer.restoreAll;
  var createBatcher = ns.createBatcher;
  var SessionCache = ns.SessionCache;
  var loadSettings = ns.settings.loadSettings;
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
      requests: 0, batches: 0, units: 0,
      elapsedMs: 0, firstTranslatedLatencyMs: 0, firstViewportLatencyMs: 0,
      errorCounts: {}, skipCounts: {}, errors: []
    };
  }

  function newStats() {
    return { translated: 0, failed: 0, cacheHits: 0, applied: 0, skipped: 0, requests: 0, errorCounts: {}, skipCounts: {}, errors: [] };
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
  // so the page structure survives. Successful translations are fed back into
  // the session cache so a second run hits it.
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
      if (typeof textKey === 'string' && typeof r.translatedText === 'string') cache.set(textKey, r.translatedText);
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
      if (out.ok) applied++;
      else {
        stats.skipped++;
        countSkip(stats, out.reason || 'refused');
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
  function recoverBatch(btag, batchNumber, batch, segmentsById, stats, latencies) {
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
          profileName: settings.profileName,
          concurrency: settings.maxConcurrent,
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

  function translatePage(root) {
    abortRequested = false;
    setStatus('translating');
    var runId = ++runSeq;
    var tag = 'run#' + runId;
    live = {
      runId: runId, phase: 'loading-settings', segments: 0, batches: 0, sent: 0, inFlight: 0,
      units: 0, requests: 0,
      translated: 0, failed: 0, cacheHits: 0, applied: 0, skipped: 0, errorCounts: {},
      skipCounts: {}, startedAt: Date.now()
    };
    log.info(tag + ' translatePage start (profile=' + (settings && settings.profileName) + ' cache=' + cache.map.size + ')');
    return loadSettings().then(function (s) {
      settings = s; // apply popup changes immediately
      // The saved caps have to reach the packer, which was built before settings
      // were loaded (see applyBatchSettings).
      applyBatchSettings();
      var segments = buildSegments(root || document);
      live.segments = segments.length;
      log.info(tag + ' extracted segments=' + segments.length + ' viewport=' + JSON.stringify(countViewport(segments)) +
        ' profile=' + settings.profileName + ' maxConcurrent=' + settings.maxConcurrent +
        ' cache=' + cache.map.size + ' cacheHits=' + cache.hits);
      if (!segments.length) {
        setStatus('idle');
        live.phase = 'idle';
        lastRun = emptySummary();
        log.warn(tag + ' nothing to translate (0 segments). If this page is English and untouched, check __plamo.getPending().');
        return lastRun;
      }

      segments = sortSegmentsByViewport(segments);
      var segmentsById = {};
      segments.forEach(function (s) { segmentsById[s.id] = s; });
      // One batch = one API request: the units are the blocks the segments came
      // from, the batches are what one request will carry.
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
        // Only wire-safe fields cross the boundary; the cache travels as a plain
        // object limited to this batch (a Map would arrive as "{}").
        var payload = {
          id: messaging.makeRequestId('r' + runId + 'b' + (batchIndex + 1)),
          type: MSG_TRANSLATE,
          batch: messaging.toWireBatch(batch),
          profileName: settings.profileName,
          concurrency: settings.maxConcurrent,
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
          return recoverBatch(btag, batchIndex + 1, batch, segmentsById, stats, latencies);
        });
      });

      return Promise.all(promises).then(function () {
        closeChannel('run#' + runId + ' finished');
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
          elapsedMs: Math.round(performance.now() - t0),
          firstTranslatedLatencyMs: latencies.firstTranslatedLatencyMs,
          firstViewportLatencyMs: latencies.firstViewportLatencyMs,
          errorCounts: stats.errorCounts,
          skipCounts: stats.skipCounts,
          errors: stats.errors
        };
        setStatus('idle');
        live.phase = 'idle';
        lastRun = summary;
        var endLine = tag + ' done total=' + summary.total + ' translated=' + summary.translated +
          ' applied=' + summary.applied + ' failed=' + summary.failed + ' skipped=' + summary.skipped +
          ' cacheHits=' + summary.cacheHits + ' requests=' + summary.requests +
          ' (' + summary.batches + ' request(s) for ' + summary.total + ' segment(s))' +
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
            '(SPA); see __plamo.getApplied() for what did land');
        }
        return summary;
      });
    }).catch(function (err) {
      closeChannel('run#' + runId + ' aborted');
      if (live) live.phase = 'idle';
      setStatus('idle');
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
      abortRequested = true;
      setStatus('idle');
      log.warn('stop requested (run#' + (live ? live.runId : '-') + '); in-flight batches are not cancelled, their results are still applied');
      return Promise.resolve({ ok: true, aborted: true, state: getState() });
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
      // How the last/current run talks to the worker: 'port' is the durable
      // channel, 'sendMessage' means connect() was unavailable to this page.
      channel: l.channel || (channel ? 'port' : 'sendMessage'),
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
    var segments = buildSegments(root);
    return {
      count: segments.length,
      viewport: countViewport(segments),
      // Text nodes we have already rewritten (see __plamo.getApplied()).
      alreadyTranslated: renderer.appliedCount(),
      cacheEntries: cache.map.size,
      // Which subtree the extractor actually walked, and what it refused: a
      // "0 segments" answer on an English page is explained by these numbers.
      scan: ns.extractor.scanStats(),
      sample: segments.slice(0, 10).map(function (s) {
        return {
          id: s.id, viewport: s.viewport, chars: s.text.length,
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
    var segments = sortSegmentsByViewport(buildSegments(root));
    var unitList = batcher.units(segments);
    var batches = batcher.batchUnits(segments);
    return {
      segments: segments.length,
      blocks: unitList.length,
      requests: batches.length,
      segmentsPerRequest: batches.length ? Number((segments.length / batches.length).toFixed(1)) : 0,
      caps: batcherCaps, // what the packer in use was built with
      strategy: (settings && settings.request && settings.request.strategy) || C.REQUEST_SETTINGS.strategy,
      viewport: countViewport(segments),
      batches: batches.slice(0, (opts && opts.limit) || 8).map(function (b, i) {
        return {
          index: i + 1, segments: b.segments.length, blocks: b.units,
          estimatedTokens: b.estimatedTokens,
          sample: b.segments.slice(0, 3).map(function (s) { return s.text.slice(0, 40); })
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
    var restored = restoreNodes(root);
    log.info('restored ' + restored + ' text node(s) to the original text');
    return restored;
  }

  var manifestVersion = null;
  try { manifestVersion = chrome.runtime.getManifest().version; } catch (e) { /* unavailable */ }

  window.__plamo = {
    version: manifestVersion,
    // diagnostics
    getState: getState,
    getPending: getPending,
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
    // One row per text node whose nodeValue we replaced: { path, before, after }.
    getApplied: function (limit) { return renderer.appliedSample(limit); },
    scanStats: function () { return ns.extractor.scanStats(); },
    getLogs: function (opts) { return ns.logger.getLogs(opts); },
    dumpLogs: function (opts) { return ns.logger.dumpLogs(opts); },
    clearLogs: function () { return ns.logger.clearLogs(); },
    setVerbose: function (on) { return ns.logger.setVerbose(on); },
    setDebug: function (on) { return ns.logger.setDebug(on); },
    backgroundLogs: backgroundLogs,
    pingBackground: pingBackground,
    // actions
    translatePage: function (root) { return translatePage(root); },
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
    getSettings: function () { return settings; },
    translateSegment: function (segment, opts) { return translateSegment(getProfile(settings.profileName), segment, opts); }
  };

  log.info('content script ready v' + manifestVersion +
    ' (diagnostics: __plamo.getState(), __plamo.getPending(), __plamo.dumpLogs(), __plamo.pingBackground())');
  setStatus('idle');
})();
