// shared/settings.js
// Reads/writes the extension settings from chrome.storage.local.

import {
  DEFAULT_PROFILE,
  DEFAULT_MODE,
  DEFAULT_MAX_CONCURRENT,
  MODES,
  CONCUR_OPTIONS,
  BATCH_SETTINGS,
} from './constants.js';

export function defaultSettings() {
  return {
    profileName: DEFAULT_PROFILE,
    mode: DEFAULT_MODE,
    maxConcurrent: DEFAULT_MAX_CONCURRENT,
    batch: { ...BATCH_SETTINGS },
  };
}

export async function loadSettings() {
  const stored = await chrome.storage.local.get(['plamo']);
  const base = defaultSettings();
  const patch = stored.plamo || {};
  return {
    ...base,
    ...patch,
    batch: { ...base.batch, ...(patch.batch || {}) },
  };
}

export async function saveSettings(patch) {
  const current = await loadSettings();
  await chrome.storage.local.set({ plamo: { ...current, ...patch } });
  return { ...current, ...patch };
}

// Clamp a raw concurrency value onto the supported option set.
export function clampConcurrent(value) {
  const n = parseInt(value, 10);
  if (Number.isNaN(n)) return DEFAULT_MAX_CONCURRENT;
  if (CONCUR_OPTIONS.includes(n)) return n;
  return CONCUR_OPTIONS.find((c) => c >= n) || CONCUR_OPTIONS[CONCUR_OPTIONS.length - 1];
}

export function isModeSupported(mode) {
  return MODES.includes(mode);
}
