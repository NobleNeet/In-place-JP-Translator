// shared/constants.js
// Single source of truth for message types and tunable defaults.

// Message types shared between popup <-> content <-> background.
export const MSG_TRANSLATE_PAGE = 'plamo.translate-page';
export const MSG_STOP = 'plamo.stop';
export const MSG_STATUS = 'plamo.status';
export const MSG_TRANSLATE = 'plamo.translate';

// Defaults (see README for how to tune).
export const DEFAULT_PROFILE = 'evo-x2-plamo2';
export const DEFAULT_MODE = 'single';
export const DEFAULT_MAX_CONCURRENT = 2;
export const DEFAULT_TIMEOUT_MS = 120000; // local LLM -> keep the timeout generous

// Future connection modes. Only "single" is implemented in Phase 1.
export const MODES = ['single', 'fallback', 'balanced'];
export const CONCUR_OPTIONS = [1, 2, 4, 8];

// Batching heuristics. Intentionally loose (no bundled tokenizer).
export const BATCH_SETTINGS = {
  maxSegmentsPerBatch: 16,
  maxEstimatedTokensPerBatch: 3000,
  charPerToken: 4, // 1 token ~= 4 characters for English
};
