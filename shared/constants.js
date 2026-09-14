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

    // A batch is now ONE API request (see api/openai-client.js translateSegments):
    // every segment of a batch travels as one line of a single prompt, so the
    // caps below are caps on a request, not on a message. The token budget is
    // what actually matters (input + output of one request); the segment cap is
    // only there to stop a page of 2-letter menu items from making one giant
    // request that the model answers with the wrong number of lines.
    BATCH_SETTINGS: {
      maxSegmentsPerBatch: 48,
      maxEstimatedTokensPerBatch: 3000,
      charPerToken: 4,
      // The first batch is the visible part of the page: keeping it small is
      // what keeps the perceived speed while later batches go out big.
      firstBatchMaxSegments: 10
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
      timeoutBaseMs: 120000,    // request timeout for a batched request ...
      timeoutPerTokenMs: 30,    // ... plus this per estimated token of the batch
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
