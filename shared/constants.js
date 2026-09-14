// shared/constants.js
// Classic-script module. Exports: ns.constants
// Single source of truth for message types and tunable defaults.
(function () {
  var ns = (globalThis.__PLAMO__ = globalThis.__PLAMO__ || {});
  ns.constants = {
    MSG_TRANSLATE_PAGE: 'plamo.translate-page',
    MSG_RESTORE: 'plamo.restore',
    MSG_STOP: 'plamo.stop',
    MSG_STATUS: 'plamo.status',
    MSG_TRANSLATE: 'plamo.translate',
    // Diagnostics helpers: let the page ask the background worker for its own
    // log ring buffer (the service-worker console is hard to reach on Vivaldi).
    MSG_PING: 'plamo.ping',
    MSG_DIAGNOSTICS: 'plamo.diagnostics',

    DEFAULT_PROFILE: 'evo-x2-plamo2',
    DEFAULT_MODE: 'single',
    DEFAULT_MAX_CONCURRENT: 2,
    DEFAULT_TIMEOUT_MS: 120000,

    MODES: ['single', 'fallback', 'balanced'],
    CONCUR_OPTIONS: [1, 2, 4, 8],

    BATCH_SETTINGS: { maxSegmentsPerBatch: 16, maxEstimatedTokensPerBatch: 3000, charPerToken: 4 },

    // Extraction unit is a Text node (never an element): see content/extractor.js.
    // minTextLength drops "a", "»", "2" fragments the model would only mangle;
    // maxTextLength keeps one huge <p> from starving a batch of its token budget.
    EXTRACT: { minTextLength: 3, maxTextLength: 5000 }
  };
})();
