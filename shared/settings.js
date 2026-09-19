// shared/settings.js
// Classic-script module. Exports: ns.settings
// Reads/writes extension settings from chrome.storage.local.
(function () {
  var ns = globalThis.__PLAMO__;
  var C = ns.constants;

  function defaultSettings() {
    return {
      profileName: C.DEFAULT_PROFILE,
      mode: C.DEFAULT_MODE,
      maxConcurrent: C.DEFAULT_MAX_CONCURRENT,
      // Per-API tuning, keyed by profile name (api/profiles.js): one entry per
      // server you want in the run, each with its own `enabled` switch and
      // `concurrency` (null = inherit the shared maxConcurrent). Several
      // enabled entries mean the run sends its batches through all of those
      // servers at once. Empty (every install saved before this existed) keeps
      // the old behaviour: profileName alone, at maxConcurrent.
      apis: {},
      batch: {
        maxSegmentsPerBatch: C.BATCH_SETTINGS.maxSegmentsPerBatch,
        maxEstimatedTokensPerBatch: C.BATCH_SETTINGS.maxEstimatedTokensPerBatch,
        charPerToken: C.BATCH_SETTINGS.charPerToken,
        firstBatchMaxSegments: C.BATCH_SETTINGS.firstBatchMaxSegments,
        shortSegmentTokens: C.BATCH_SETTINGS.shortSegmentTokens,
        maxShortSegmentsPerBatch: C.BATCH_SETTINGS.maxShortSegmentsPerBatch
      },
      // How segments are packed into API requests (see api/openai-client.js).
      request: {
        strategy: C.REQUEST_SETTINGS.strategy,
        format: C.REQUEST_SETTINGS.format,
        retryWithNumbers: C.REQUEST_SETTINGS.retryWithNumbers,
        perSegmentFallback: C.REQUEST_SETTINGS.perSegmentFallback,
        batchSystemPrompt: C.REQUEST_SETTINGS.batchSystemPrompt
      },
      // The exact-match translation cache that outlives the page
      // (translation/persistent.js): caps of chrome.storage.local, and how
      // often one entry's reuse counters may be rewritten, which is what
      // decides the order the caps trim in. The session cache stays the hot
      // layer in front.
      cache: {
        enabled: C.CACHE_SETTINGS.enabled,
        maxEntries: C.CACHE_SETTINGS.maxEntries,
        maxChars: C.CACHE_SETTINGS.maxChars,
        maintainAfterChars: C.CACHE_SETTINGS.maintainAfterChars,
        useLogIntervalMs: C.CACHE_SETTINGS.useLogIntervalMs
      },
      // Which text a run sends first, and what it holds back (content/priority.js).
      priority: {
        deferHidden: C.PRIORITY_SETTINGS.deferHidden,
        topDown: C.PRIORITY_SETTINGS.topDown,
        revealDebounceMs: C.PRIORITY_SETTINGS.revealDebounceMs,
        revealIntervalMs: C.PRIORITY_SETTINGS.revealIntervalMs,
        maxHiddenChecks: C.PRIORITY_SETTINGS.maxHiddenChecks
      }
    };
  }

  async function loadSettings() {
    var stored = await chrome.storage.local.get(['plamo']);
    var base = defaultSettings();
    var patch = (stored && stored.plamo) || {};
    var maxConcurrent = clampConcurrent(patch.maxConcurrent);
    return Object.assign({}, base, patch, {
      maxConcurrent: maxConcurrent,
      apis: normalizeApis(patch.apis),
      batch: Object.assign({}, base.batch, (patch.batch || {})),
      cache: Object.assign({}, base.cache, (patch.cache || {}), {
        // Clamped like every other stored number: a typo in maxEntries must not
        // silently shrink the persistent cache to nothing (translation/persistent.js).
        enabled: booleanWith((patch.cache || {}).enabled, base.cache.enabled),
        maxEntries: clampMs((patch.cache || {}).maxEntries, base.cache.maxEntries, 1, 200000),
        maxChars: clampMs((patch.cache || {}).maxChars, base.cache.maxChars, 1000, 100000000),
        maintainAfterChars: clampMs((patch.cache || {}).maintainAfterChars, base.cache.maintainAfterChars, 1000, 100000000),
        useLogIntervalMs: clampMs((patch.cache || {}).useLogIntervalMs, base.cache.useLogIntervalMs, 0, 86400000)
      }),
      priority: Object.assign({}, base.priority, (patch.priority || {}), {
        // The numbers are clamped, not trusted: a stored typo must not turn the
        // "did it appear yet?" watcher into a busy loop or switch it off with a
        // negative interval (see the reveal watch in content/content.js).
        deferHidden: booleanWith((patch.priority || {}).deferHidden, base.priority.deferHidden),
        topDown: booleanWith((patch.priority || {}).topDown, base.priority.topDown),
        revealDebounceMs: clampMs((patch.priority || {}).revealDebounceMs, base.priority.revealDebounceMs, 50, 60000),
        revealIntervalMs: clampMs((patch.priority || {}).revealIntervalMs, base.priority.revealIntervalMs, 500, 600000),
        maxHiddenChecks: clampMs((patch.priority || {}).maxHiddenChecks, base.priority.maxHiddenChecks, 50, 100000)
      }),
      request: Object.assign({}, base.request, (patch.request || {}), { strategy: clampStrategy((patch.request || {}).strategy) })
    });
  }

  async function saveSettings(patch) {
    var current = await loadSettings();
    await chrome.storage.local.set({ plamo: Object.assign({}, current, patch) });
    return Object.assign({}, current, patch);
  }

  function clampConcurrent(value) {
    var n = parseInt(value, 10);
    if (Number.isNaN(n)) return C.DEFAULT_MAX_CONCURRENT;
    if (C.CONCUR_OPTIONS.indexOf(n) !== -1) return n;
    return C.CONCUR_OPTIONS.filter(function (c) { return c >= n; })[0] || C.CONCUR_OPTIONS[C.CONCUR_OPTIONS.length - 1];
  }

  // Stored per-API entries are trusted no further than the numbers already
  // are: `enabled` becomes a real boolean, `concurrency` is either a legal
  // option or null (which means "inherit settings.maxConcurrent"), and the
  // per-API model / system prompt ride along as strings.
  //   model: '' means "use the profile's own model" (api/profiles.js).
  //   systemPrompt: undefined means "never set - use the profile's own";
  //   '' means "explicitly no system message at all", which is how a
  //   translation-specialised model (plamo2translate) is meant to be driven.
  //   Keeping the undefined-vs-empty distinction end to end is what lets a
  //   custom profile keep its own prompt while a cleared box still sends none.
  function normalizeApis(raw) {
    var out = {};
    Object.keys(raw || {}).forEach(function (name) {
      var e = raw[name] || {};
      var n = parseInt(e.concurrency, 10);
      var entry = {
        enabled: !!e.enabled,
        concurrency: (Number.isFinite(n) && n >= 1) ? clampConcurrent(n) : null,
        model: String(e.model == null ? '' : e.model).trim()
      };
      if (e.systemPrompt != null) entry.systemPrompt = String(e.systemPrompt);
      out[name] = entry;
    });
    return out;
  }

  // The APIs one run sends to: every enabled entry, in saved order, each with
  // its own concurrency. Nothing enabled (a fresh install, settings saved
  // before per-API tuning existed, or a popup that ticked everything off)
  // keeps the old single-profile behaviour: profileName alone, at
  // maxConcurrent.
  function activeApis(settings) {
    var maxConcurrent = clampConcurrent(settings && settings.maxConcurrent);
    var apis = (settings && settings.apis) || {};
    var out = [];
    Object.keys(apis).forEach(function (name) {
      var e = apis[name];
      if (e && e.enabled) {
        var server = { name: name, concurrency: e.concurrency || maxConcurrent, model: e.model || '' };
        if (e.systemPrompt != null) server.systemPrompt = e.systemPrompt;
        out.push(server);
      }
    });
    if (!out.length) {
      // Legacy single-profile fallback: the profile's own model and prompt,
      // at maxConcurrent (no per-API overrides).
      out.push({ name: (settings && settings.profileName) || C.DEFAULT_PROFILE, concurrency: maxConcurrent, model: '' });
    }
    return out;
  }

  // What a run is likely to look like, NOT what a run does: one entry per
  // concurrency slot each ticked API can fill, so a roomier server shows up
  // more often (evo at 2 + local at 4 tends to hand two thirds of the batches
  // to local). Nothing is assigned from this list — destinations are picked as
  // slots free up, in translation/dispatch.js — and the numbers are only what
  // `__plamo.getApiPlan().schedule` reports for tuning. Kept off the send path
  // on purpose: dealing the batches out in advance is what made two servers
  // behave as one queue.
  function apiPlan(settings) {
    var plan = [];
    activeApis(settings).forEach(function (api) {
      for (var i = 0; i < api.concurrency; i++) plan.push({ name: api.name, concurrency: api.concurrency });
    });
    return plan;
  }

  // Only the two strategies that exist: an unknown/absent stored value falls
  // back to the default instead of switching a user off to no batching at all.
  function clampStrategy(value) {
    if (C.REQUEST_STRATEGIES.indexOf(value) !== -1) return value;
    return C.REQUEST_SETTINGS.strategy;
  }

  // Millisecond settings: a bad stored value falls back to the default, and a
  // value below `min` is raised to it (a reveal watcher with a 1ms interval
  // would only burn the tab's CPU). A `max` is raised as well, because a timer
  // measured in hours is not a watcher — it would silently stop checking.
  function clampMs(value, fallback, min, max) {
    var n = Math.round(Number(value));
    if (!Number.isFinite(n)) return fallback;
    if (n < min) return min;
    if (max != null && n > max) return max;
    return n;
  }

  // A stored switch is a switch only if it is present; an absent one keeps the
  // default (so a settings object saved before the switch existed changes
  // nothing).
  function booleanWith(value, fallback) {
    if (value == null) return !!fallback;
    return !!value;
  }

  function isModeSupported(mode) { return C.MODES.indexOf(mode) !== -1; }

  ns.settings = {
    loadSettings: loadSettings,
    saveSettings: saveSettings,
    clampConcurrent: clampConcurrent,
    normalizeApis: normalizeApis,
    activeApis: activeApis,
    apiPlan: apiPlan,
    clampStrategy: clampStrategy,
    clampMs: clampMs,
    booleanWith: booleanWith,
    isModeSupported: isModeSupported,
    defaultSettings: defaultSettings
  };
})();
