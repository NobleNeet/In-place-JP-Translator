// translation/batcher.js
// Groups segments into batches bounded by count and estimated token size.
// Settings are injected so the limits are fully tunable (see constants.js).

import { BATCH_SETTINGS } from '../shared/constants.js';

export function createBatcher(settings = {}) {
  const cfg = { ...BATCH_SETTINGS, ...settings };

  return function batch(segments) {
    const batches = [];
    let current = [];
    let tokens = 0;

    for (const seg of segments) {
      const t = seg.tokenEstimate || 0;
      const overCount = current.length + 1 > cfg.maxSegmentsPerBatch;
      const overTokens = tokens + t > cfg.maxEstimatedTokensPerBatch;
      if (current.length > 0 && (overCount || overTokens)) {
        batches.push(current);
        current = [];
        tokens = 0;
      }
      current.push(seg);
      tokens += t;
    }
    if (current.length > 0) batches.push(current);
    return batches;
  };
}
