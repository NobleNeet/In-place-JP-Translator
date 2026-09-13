// api/openai-client.js
// Classic-script module. Exports: ns.openaiClient
// OpenAI-compatible client. Runs in the background service worker; never in the
// page's context, so page secrets never leak to the API. Swappable for
// /v1/completions or llama.cpp later without touching page code.
(function () {
  var ns = globalThis.__PLAMO__;
  var log = ns.logger.log;
  var DEFAULT_TIMEOUT_MS = ns.constants.DEFAULT_TIMEOUT_MS;

  function isAborted(signal) { return !!(signal && signal.aborted); }

  async function requestChatCompletions(profile, text, opts) {
    opts = opts || {};
    var timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
    var signal = opts.signal;
    var systemMessages = [{
      role: 'system',
      content: profile.systemPrompt || 'You are a helpful translator.'
    }];
    var body = {
      model: profile.model,
      messages: systemMessages,
      max_tokens: 0,
      temperature: 0.7,
      text: text
    };

    var fetchOpts = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    };
    if (profile.apiKey) fetchOpts.headers['Authorization'] = 'Bearer ' + profile.apiKey;
    if (signal) fetchOpts.signal = signal;

    var controller;
    var timer = setTimeout(function () {
      controller = new AbortController();
      controller.abort();
    }, timeoutMs);
    if (signal) {
      signal.addEventListener('abort', function () { controller.abort(); });
    }

    try {
      var res = await fetch(profile.url, fetchOpts);
      if (!res.ok) {
        var resText = await res.text().catch(function () { return ''; });
        var msg = res.status + ' ' + res.statusText + (resText ? (' | ' + resText.slice(0, 200)) : '');
        return { error: msg, errorType: 'http_error', translatedText: undefined };
      }

      var parsed;
      try { parsed = await res.json(); }
      catch (e) { return { error: 'Invalid JSON from API', errorType: 'json_error', translatedText: undefined }; }

      var out = parsed.choices && parsed.choices[0] && parsed.choices[0].message && parsed.choices[0].message.content;
      if (out == null || out === '') {
        return { error: 'Empty response from API', errorType: 'empty_response', translatedText: undefined };
      }

      return { error: undefined, translatedText: out };
    }
    catch (e) {
      var errMsg = e && e.message ? e.message : String(e);
      if (errMsg === 'aborted' || (signal && signal.aborted) || (controller && controller.signal && controller.signal.aborted)) {
        return { error: 'Request timed out or aborted', errorType: 'timeout', translatedText: undefined };
      }
      return { error: errMsg, errorType: 'connection', translatedText: undefined };
    }
    finally {
      clearTimeout(timer);
    }
  }

  function translateSegment(profile, segment, opts) {
    return requestChatCompletions(profile, segment.text, opts).then(function (res) {
      if (res.translatedText) {
        return { id: segment.id, translatedText: res.translatedText };
      }
      return { id: segment.id, error: res.error, errorType: res.errorType };
    });
  }

  ns.openaiClient = {
    requestChatCompletions: requestChatCompletions,
    translateSegment: translateSegment
  };
})();
