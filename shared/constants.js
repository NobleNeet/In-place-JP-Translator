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
      firstBatchMaxSegments: 8,
      // Short segments — menu items, nav labels, headings, buttons — are
      // numerous and tiny: 24 of them are ~100 estimated tokens, so the token
      // cap is nowhere near binding and the count cap decides everything.
      // A segment of at most `shortSegmentTokens` estimated tokens therefore
      // costs a fraction of one slot of the segment cap, so a batch of nothing
      // but short segments carries up to `maxShortSegmentsPerBatch` of them.
      // 72 x ~12 tokens still fits under the 900-token cap, so the per-request
      // timeout math does not change: short items were always cheap in tokens,
      // they were only ever expensive in request count. Mixed batches pay the
      // fractional slots, so short items fill the gaps between paragraphs.
      // Set it <= maxSegmentsPerBatch to turn the discount off.
      shortSegmentTokens: 12,
      maxShortSegmentsPerBatch: 72
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

    // --- translation priority (see content/priority.js) ----------------------
    // The order a page is translated in, best first. The reader came for the
    // article body, so that goes out first; headings give it structure and
    // follow; navigation/menus/headers/footers/sidebars are page chrome and can
    // wait; 'other' is whatever the classifier could not place (a page with no
    // semantic tags, mostly). The viewport band (visible -> near -> rest) still
    // orders *inside* a class, so the first answer lands on text on screen.
    PRIORITY_ROLES: ['content', 'heading', 'navigation', 'other'],

    // Inside one region and one viewport band the position on the page decides:
    // text nearer the TOP goes out first (left before right on one line). Reading
    // order is top-down, but markup order often is not — flex `order`, a
    // `column-reverse` card, a sidebar the source lists before the article — so
    // the position is measured (one getBoundingClientRect() per element, the same
    // read that decides the viewport band) rather than assumed from the tree
    // walk. `topDown: false` ignores it and goes back to markup order.
    //
    // Text the user cannot see — display:none, visibility:hidden, [hidden] — is
    // held back instead of being translated up front: the same words often exist
    // twice on a page (desktop menu + mobile menu + a closed modal), and the
    // hidden copy is not text anyone is reading. It is translated the moment it
    // is displayed, which is when it first becomes worth the model's time.
    PRIORITY_SETTINGS: {
      deferHidden: true,       // false = translate hidden text at once (old behaviour)
      topDown: true,           // false = markup order instead of top-of-page-first
      revealDebounceMs: 250,   // how long a style/class change settles before a re-check
      revealIntervalMs: 4000,  // fallback re-check while hidden text is still pending
      maxHiddenChecks: 6000    // getComputedStyle() calls per scan, then assume visible
    },

    // --- the exact-match cache that outlives the page -------------------------
    // translation/persistent.js keeps finished translations in
    // chrome.storage.local, keyed by a hash of the source text; every entry
    // also stores its source, so a hit is a byte-for-byte identical text.
    // This is what makes the back button, or a page opened in another tab
    // before, cost only the text nobody has ever translated. The session
    // cache (translation/cache.js) stays the hot layer in front of it.
    CACHE_SETTINGS: {
      enabled: true,
      // chrome.storage.local holds 10 MB without the "unlimitedStorage"
      // permission, so the store is trimmed to these caps once a run has
      // stored `maintainAfterChars` of new text. The trim drops the entries
      // that have aged the most since they were last used, divided by how
      // often they have been used, so frequently reused translations are the
      // last things removed (see translation/persistent.js).
      maxEntries: 40000,
      maxChars: 3000000,      // counted over source + translation
      maintainAfterChars: 200000,
      // A lookup hit records a reuse, and a reuse is a storage write. This is
      // how often one entry's counters may be rewritten: an hour is far finer
      // than the day-scale the trim works on, and it stops a page re-rendered
      // every second from rewriting its few hundred known texts every second.
      // 0 = record every hit.
      useLogIntervalMs: 3600000
    },

    // Extraction unit is a Text node (never an element): see content/extractor.js.
    // minTextLength drops "a", "»", "2" fragments the model would only mangle.
    // maxTextLength used to be 5000, which silently threw away long article
    // paragraphs - a left-behind block of English nobody could explain. The
    // packer already gives an oversized node a request of its own (see
    // translation/batcher.js), so the cap only needs to keep pathological nodes
    // (a whole page inside one text node) out of one prompt; anything it does
    // refuse is counted in scanStats().tooLong, never dropped in silence.
    // Raise it if the server decodes fast enough for one node to answer inside
    // MAX_REQUEST_TIMEOUT_MS. Screen-reader-only text (.sr-only and friends) is
    // skipped outright: invisible text the user cannot read.
    EXTRACT: { minTextLength: 3, maxTextLength: 12000 }
  };
})();
