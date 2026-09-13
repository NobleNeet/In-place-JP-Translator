// shared/logger.js
// Centralized, toggleable logging for the extension.
//
// Set debug off via `log.setDebug(false)` (e.g. from popup or devtools)
// to silence the verbose console output in production.

const PREFIX = '[PLaMoTranslate]';

let debugEnabled = true;

export function setDebug(enabled) {
  debugEnabled = !!enabled;
}

export function isDebug() {
  return debugEnabled;
}

export const log = {
  debug: (...args) => {
    if (debugEnabled) console.log(PREFIX, ...args);
  },
  info: (...args) => console.info(PREFIX, ...args),
  warn: (...args) => console.warn(PREFIX, ...args),
  error: (...args) => console.error(PREFIX, ...args),

  // Single-line structured batch metric (devtools friendly).
  batch: (obj) => {
    if (debugEnabled) console.log(PREFIX, JSON.stringify(obj));
  },

  // Wrap a synchronous block with timing.
  time: (label, fn) => {
    const t0 = performance.now();
    try {
      return fn();
    } finally {
      log.debug(`${label} ${Math.round(performance.now() - t0)}ms`);
    }
  },
};
