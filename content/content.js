// content/content.js
// Classic-script orchestrator. Runs in the page's content-script scope.
// Loads in order: logger, constants, settings, profiles, openai-client,
// extractor, segmenter, renderer, batcher, cache, queue.
//
// Flow: extract readable elements -> build segments -> order by viewport
// priority -> batch -> send each batch to background (in parallel, concurrency
// bound) -> apply each finished batch to the DOM as it completes.
(function () {
  var ns = globalThis.__PLAMO__;

  var log = ns.logger.log;
  var MSG_TRANSLATE_PAGE = ns.constants.MSG_TRANSLATE_PAGE;
  var MSG_STOP = ns.constants.MSG_STOP;
  var MSG_STATUS = ns.constants.MSG_STATUS;
  var MSG_TRANSLATE = ns.constants.MSG_TRANSLATE;

  var extractReadableElements = ns.extractor.extractReadableElements;
  var buildSegments = ns.segmenter.buildSegments;
  var sortSegmentsByViewport = ns.segmenter.sortSegmentsByViewport;
  var applyTranslation = ns.renderer.applyTranslation;
  var restore = ns.renderer.restore;
  var createBatcher = ns.createBatcher;
  var SessionCache = ns.SessionCache;
  var loadSettings = ns.settings.loadSettings;
  var getProfile = ns.profiles.getProfile;
  var translateSegment = ns.openaiClient.translateSegment;

  var settings = {};
  var batcher = createBatcher(settings.batch || {});
  var cache = new SessionCache();
  var inFlight = {};
  var abortRequested = false;

  function setStatus(status) {
    try { chrome.runtime.sendMessage({ type: MSG_STATUS, status: status }); }
    catch (e) { /* background may not be listening yet */ }
  }

  function sendToTab(msg) {
    return new Promise(function (resolve, reject) {
      try {
        chrome.runtime.sendMessage(msg, function (response) {
          if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
          resolve(response);
        });
      } catch (e) { reject(e); }
    });
  }

  function translatePage(root) {
    abortRequested = false;
    setStatus('translating');
    return loadSettings().then(function (s) {
      settings = s; // apply popup changes immediately
      var segments = buildSegments(root || document);
      log.info('start: ' + segments.length + ' segments', { byPriority: countViewport(segments) });
      if (!segments.length) { setStatus('idle'); return { total: 0, translated: 0, failed: 0, cacheHits: 0, elapsedMs: 0, firstTranslatedLatencyMs: 0, firstViewportLatencyMs: 0 }; }

      segments = sortSegmentsByViewport(segments);
      var batches = batcher.batch(segments);
      var t0 = performance.now();
      var translated = 0, failed = 0, cacheHits = 0;
      var inFlightIds = {};
      var firstTranslatedLatencyMs = 0, firstViewportLatencyMs = 0;
      var viewportId = null;
      segments.forEach(function (s) { if (s.viewport === 1 && !viewportId) viewportId = s.id; });

      var results = {};
      var promises = batches.map(function (batch, batchIndex) {
        inFlightIds[batchIndex] = true;
        return sendToTab({ type: MSG_TRANSLATE, batch: batch, profile: settings.profileName, concurrency: settings.maxConcurrent, timeoutMs: ns.constants.DEFAULT_TIMEOUT_MS, cache: cache.map }).then(function (res) {
          delete inFlightIds[batchIndex];
          var server = (res && res.profile) ? res.profile : 'unknown';
          if (res && res.status === 'success') {
            translated += res.segments;
            cacheHits += res.cacheHits || 0;
            var first = (res.results && res.results[0]) || null;
            if (first && first.translatedText) {
              if (!firstTranslatedLatencyMs) firstTranslatedLatencyMs = Math.round(performance.now() - t0);
              if (first.id === viewportId && !firstViewportLatencyMs) firstViewportLatencyMs = Math.round(performance.now() - t0);
            }
            Object.keys(res.results).forEach(function (id) { results[id] = res.results[id]; });
            log.batch({ batch: batchIndex + 1, server: server, segments: res.segments, estimatedTokens: batch.estimatedTokens, elapsedMs: res.elapsedMs, status: 'success' });
          } else if (res && res.status === 'partial') {
            var done = 0;
            Object.keys(res.results).forEach(function (id) { results[id] = res.results[id]; if (res.results[id].translatedText) done++; });
            translated += done; failed += res.segments - done;
            log.batch({ batch: batchIndex + 1, server: server, segments: res.segments, estimatedTokens: batch.estimatedTokens, elapsedMs: res.elapsedMs, status: 'partial' });
          } else {
            failed += res.segments;
            log.batch({ batch: batchIndex + 1, server: server, segments: res.segments, estimatedTokens: batch.estimatedTokens, elapsedMs: res.elapsedMs, status: 'failure', error: res.error });
          }
        }).catch(function (err) {
          delete inFlightIds[batchIndex];
          failed += batch.segments.length;
          log.error('translate response err', err);
        });
      });

      return Promise.all(promises).then(function () {
        Object.keys(results).forEach(function (id) {
          var r = results[id];
          if (r && r.translatedText && r.source && r.source.element) {
            applyTranslation(r.source.element, r.translatedText, r.source.text);
          }
        });
        var elapsedMs = Math.round(performance.now() - t0);
        setStatus('idle');
        log.info('done', { total: segments.length, translated: translated, failed: failed, cacheHits: cacheHits, elapsedMs: elapsedMs, firstTranslatedLatencyMs: firstTranslatedLatencyMs, firstViewportLatencyMs: firstViewportLatencyMs });
        return { total: segments.length, translated: translated, failed: failed, cacheHits: cacheHits, elapsedMs: elapsedMs, firstTranslatedLatencyMs: firstTranslatedLatencyMs, firstViewportLatencyMs: firstViewportLatencyMs };
      });
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
    if (!request || !request.type) return Promise.resolve({ error: 'unknown message type' });
    if (request.type === MSG_TRANSLATE_PAGE) {
      var root = request.root;
      return translatePage(root);
    }
    if (request.type === MSG_STOP) {
      abortRequested = true;
      setStatus('idle');
      return Promise.resolve({ ok: true, aborted: true });
    }
    if (request.type === MSG_STATUS) {
      return Promise.resolve({ phase: abortRequested ? 'idle' : 'translating', segments: 0, translated: 0, failed: 0, cacheHits: 0 });
    }
    return Promise.resolve({ error: 'unknown message type' });
  }

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    var p = handleMessage(msg);
    if (p && p.then) {
      p.then(function (res) { sendResponse(res); }, function (err) { log.error('message handler error', err); sendResponse({ error: String(err && err.message || err) }); return true; });
      return true;
    }
    sendResponse(p);
    return true;
  });

  window.__plamo = {
    getState: function () {
      return { phase: abortRequested ? 'idle' : 'translating', segments: 0, translated: 0, failed: 0, cacheHits: 0, abortRequested: abortRequested };
    },
    getCache: function () { return { mapSize: cache.map.size, hits: cache.hits, misses: cache.misses }; },
    getSettings: function () { return settings; },
    translatePage: function (root) { return translatePage(root); },
    translateSegment: function (segment, opts) { return translateSegment(getProfile(settings.profileName), segment, opts); }
  };

  setStatus('idle');
})();
