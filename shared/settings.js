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
      batch: {
        maxSegmentsPerBatch: C.BATCH_SETTINGS.maxSegmentsPerBatch,
        maxEstimatedTokensPerBatch: C.BATCH_SETTINGS.maxEstimatedTokensPerBatch,
        charPerToken: C.BATCH_SETTINGS.charPerToken
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
      batch: Object.assign({}, base.batch, (patch.batch || {}))
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

  function isModeSupported(mode) { return C.MODES.indexOf(mode) !== -1; }

  ns.settings = {
    loadSettings: loadSettings,
    saveSettings: saveSettings,
    clampConcurrent: clampConcurrent,
    isModeSupported: isModeSupported,
    defaultSettings: defaultSettings
  };
})();
