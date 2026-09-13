// shared/constants.js
// Classic-script module. Exports: ns.constants
// Single source of truth for message types and tunable defaults.
(function () {
  var ns = (globalThis.__PLAMO__ = globalThis.__PLAMO__ || {});
  ns.constants = {
    MSG_TRANSLATE_PAGE: 'plamo.translate-page',
    MSG_STOP: 'plamo.stop',
    MSG_STATUS: 'plamo.status',
    MSG_TRANSLATE: 'plamo.translate',

    DEFAULT_PROFILE: 'evo-x2-plamo2',
    DEFAULT_MODE: 'single',
    DEFAULT_MAX_CONCURRENT: 2,
    DEFAULT_TIMEOUT_MS: 120000,

    MODES: ['single', 'fallback', 'balanced'],
    CONCUR_OPTIONS: [1, 2, 4, 8],

    BATCH_SETTINGS: { maxSegmentsPerBatch: 16, maxEstimatedTokensPerBatch: 3000, charPerToken: 4 }
  };
})();
