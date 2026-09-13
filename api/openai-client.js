// api/openai-client.js
// OpenAI-compatible Chat Completions client.
//
// Kept isolated from all DOM logic so it can later be swapped for
// /v1/completions or a llama.cpp-specific endpoint without touching the
// page/translation code.
//
// Returns a normalized result object:
//   { id, translatedText }              -> success
//   { id, error, errorType }            -> failure
//
// errorType is one of:
//   'aborted' | 'connection' | 'timeout' | 'http_error' | 'server_error'
//   | 'json_error' | 'malformed_response' | 'empty_response'

import { log } from '../shared/logger.js';
import { DEFAULT_TIMEOUT_MS } from '../shared/constants.js';

function isAborted(signal) {
  return !!signal && signal.aborted;
}

export async function requestChatCompletions(profile, text, opts = {}) {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, signal } = opts;

  // Local AbortController combines the hard timeout with any external abort.
  const controller = new AbortController();
  let timer;
  const abortExternal = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', abortExternal, { once: true });
  }
  timer = setTimeout(() => controller.abort(), timeoutMs);

  const headers = { 'Content-Type': 'application/json' };
  // Only send Authorization when an API key is actually configured.
  if (profile.apiKey && profile.apiKey !== '') {
    headers['Authorization'] = `Bearer ${profile.apiKey}`;
  }

  // PLaMo 2 Translate is a translation-specialized model: send the raw text.
  // The optional system prompt is included only when configured.
  const messages = [{ role: 'user', content: text }];
  if (profile.systemPrompt) messages.unshift({ role: 'system', content: profile.systemPrompt });

  const payload = {
    model: profile.model,
    temperature: 0,
    messages,
  };

  let response;
  try {
    response = await fetch(`${profile.endpoint}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (isAborted(controller.signal)) {
      return { errorType: 'aborted', error: 'request aborted' };
    }
    if (isAborted(signal)) {
      return { errorType: 'aborted', error: 'request aborted' };
    }
    return { errorType: 'connection', error: err?.message ?? String(err) };
  }
  clearTimeout(timer);

  let data;
  try {
    data = await response.json();
  } catch (err) {
    return { errorType: 'json_error', error: `invalid JSON: ${err?.message}` };
  }

  if (!response.ok) {
    const msg = data?.error?.message ?? data?.error ?? response.statusText ?? '';
    return {
      errorType: response.status >= 500 ? 'server_error' : 'http_error',
      error: `HTTP ${response.status} ${msg}`.trim(),
      status: response.status,
    };
  }

  const content = data?.choices?.[0]?.message?.content;
  if (content === undefined || content === null) {
    return { errorType: 'malformed_response', error: 'missing choices[0].message.content' };
  }
  if (typeof content !== 'string' || content.trim() === '') {
    return { errorType: 'empty_response', error: 'empty content' };
  }
  return { translatedText: content.trim() };
}

export function translateSegment(profile, segment, opts = {}) {
  return requestChatCompletions(profile, segment.text, opts).then((res) => {
    if (res.translatedText) return { id: segment.id, translatedText: res.translatedText };
    return { id: segment.id, error: res.error, errorType: res.errorType };
  });
}
