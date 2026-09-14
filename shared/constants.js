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
    // Long-lived port used for translation requests (chrome.runtime.connect).
    // sendMessage()'s one-shot response channel only survives while the worker
    // lives and answers on the same channel; a batched request can run for
    // minutes, and when the channel dies the whole batch is lost. A port the
    // page holds open answers whenever it is ready and keeps the worker alive.
    PORT_TRANSLATE: 'plamo.translate-channel',

    // One API request must never be allowed to run for minutes: past a couple
    // of minutes the extension's own messaging/worker lifetime, not the server,
    // decides the outcome, and the failure arrives as an unusable
    // "message channel closed" instead of a timeout we can retry. Every
    // per-request timeout below is clamped to this ceiling.
    MAX_REQUEST_TIMEOUT_MS: 90000,

    // When a batch dies in transport (channel closed, worker recycled) its
    // segments are not written off: they are re-sent as a few small requests.
    RECOVERY: { maxSegmentsPerRequest: 6, maxRequests: 12 },

    DEFAULT_PROFILE: 'evo-x2-plamo2',
    DEFAULT_MODE: 'single',
    DEFAULT_MAX_CONCURRENT: 2,
    DEFAULT_TIMEOUT_MS: 120000,

    MODES: ['single', 'fallback', 'balanced'],
    CONCUR_OPTIONS: [1, 2, 4, 8],

    // A batch is now ONE API request (see api/openai-client.js translateSegments):
    // every segment of a batch travels as one line of a single prompt, so the
    // caps below are caps on a request, not on a message. Batching saves the
    // prompt/prefill round trips, NOT the decoding: a model still writes the
    // answers one after another, so a request costs roughly the sum of its
    // segments. That is what keeps these caps modest - a 48-segment request on a
    // small local model was measured at over 6 minutes, which is longer than the
    // extension's own messaging lifetime (see MAX_REQUEST_TIMEOUT_MS).
    BATCH_SETTINGS: {
      maxSegmentsPerBatch: 24,
      maxEstimatedTokensPerBatch: 900,
      charPerToken: 4,
      // The first batch is the visible part of the page: keeping it small is
      // what keeps the perceived speed while later batches go out big.
      firstBatchMaxSegments: 8
    },

    // 'multi'  = one request per batch (fast, this is the default now)
    // 'single' = one request per text node (the old behaviour, and the fallback
    //            path used when a batched answer cannot be split back up)
    REQUEST_STRATEGIES: ['multi', 'single'],
    REQUEST_SETTINGS: {
      strategy: 'multi',
      format: 'line',          // 'line' or 'numbered' (also the retry format)
      retryWithNumbers: true,  // a mismatched answer is retried once with 1. 2. 3.
      perSegmentFallback: true, // segments still unresolved go one by one
      // Extra system message for batched requests only. Empty keeps the current
      // behaviour of sending the raw text with no instruction at all, which is
      // how a translation-specialised model is meant to be driven; set it to
      // something like "Translate each line into Japanese, keep the line count"
      // if a server answers batched prompts in the wrong shape.
      batchSystemPrompt: '',
      // The timeout of one request is base + perToken x estimatedTokens, and is
      // then clamped to constants MAX_REQUEST_TIMEOUT_MS: past that ceiling the
      // extension's own messaging lifetime decides the outcome, not the server.
      timeoutBaseMs: 45000,      // request timeout for a batched request ...
      timeoutPerTokenMs: 50,     // ... plus this per estimated token of the batch
      maxTokensPerRequest: 0    // 0 = omit max_tokens and trust the server default
    },

    // Nearest block-level ancestor = the "paragraph" a text node belongs to.
    // The fragments of one <p> (split apart by inline <a>/<strong>) share a
    // block id and therefore always travel in the same request; sibling <li> or
    // <a> items of a menu keep their own block id but share a container id, so
    // the packer fills them into one request together.
    BLOCK_TAGS: ['ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DD', 'DETAILS', 'DIALOG',
      'DIV', 'DL', 'DT', 'FIELDSET', 'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM',
      'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HR', 'LI', 'MAIN', 'NAV', 'OL',
      'P', 'PRE', 'SECTION', 'SUMMARY', 'TABLE', 'TBODY', 'TD', 'TFOOT', 'TH',
      'THEAD', 'TR', 'UL'],

    // Extraction unit is a Text node (never an element): see content/extractor.js.
    // minTextLength drops "a", "»", "2" fragments the model would only mangle;
    // maxTextLength keeps one huge <p> from starving a batch of its token budget.
    EXTRACT: { minTextLength: 3, maxTextLength: 5000 }
  };
})();
