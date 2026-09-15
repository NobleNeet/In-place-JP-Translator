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
        firstBatchMaxSegments: C.BATCH_SETTINGS.firstBatchMaxSegments
      },
      // How segments are packed into API requests (see api/openai-client.js).
      request: {
        strategy: C.REQUEST_SETTINGS.strategy,
        format: C.REQUEST_SETTINGS.format,
        retryWithNumbers: C.REQUEST_SETTINGS.retryWithNumbers,
        perSegmentFallback: C.REQUEST_SETTINGS.perSegmentFallback,
        batchSystemPrompt: C.REQUEST_SETTINGS.batchSystemPrompt
      },
      // Which text a run sends first, and what it holds back (content/priority.js).
      priority: {
        deferHidden: C.PRIORITY_SETTINGS.deferHidden,
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
      priority: Object.assign({}, base.priority, (patch.priority || {}), {
        // The numbers are clamped, not trusted: a stored typo must not turn the
        // "did it appear yet?" watcher into a busy loop or switch it off with a
        // negative interval (see the reveal watch in content/content.js).
        deferHidden: booleanWith((patch.priority || {}).deferHidden, base.priority.deferHidden),
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
  // are: `enabled` becomes a real boolean, and `concurrency` is either a legal
  // option or null, which means "inherit settings.maxConcurrent".
  function normalizeApis(raw) {
    var out = {};
    Object.keys(raw || {}).forEach(function (name) {
      var e = raw[name] || {};
      var n = parseInt(e.concurrency, 10);
      out[name] = {
        enabled: !!e.enabled,
        concurrency: (Number.isFinite(n) && n >= 1) ? clampConcurrent(n) : null
      };
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
      if (e && e.enabled) out.push({ name: name, concurrency: e.concurrency || maxConcurrent });
    });
    if (!out.length) {
      out.push({ name: (settings && settings.profileName) || C.DEFAULT_PROFILE, concurrency: maxConcurrent });
    }
    return out;
  }

  // Which API one batch goes to: round-robin over a schedule where each API
  // appears once per concurrency slot it can fill, so its share of the
  // requests matches its share of the in-flight load (evo at 2 + local at 4
  // hands two thirds of the batches to local). One API alone reproduces the
  // old behaviour exactly; the send ORDER of batches never changes, only
  // their destination does.
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
