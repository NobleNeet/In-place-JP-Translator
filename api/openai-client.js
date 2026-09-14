// api/openai-client.js
// Classic-script module. Exports: ns.openaiClient
// OpenAI-compatible client. Runs in the background service worker; never in the
// page's context, so page secrets never leak to the request body.
//
// A profile stores only the OpenAI-compatible **base URL** (e.g.
// 'http://127.0.0.1:8080/v1'); the endpoint path is appended at request time
// (see profiles.resolveEndpointUrl), so this one client serves both
// '/v1/chat/completions' (messages) and '/v1/completions' (prompt) depending on
// profile.endpoint — swapping endpoints never touches page code.
(function () {
  var ns = globalThis.__PLAMO__;
  var log = ns.logger.log;
  var DEFAULT_TIMEOUT_MS = ns.constants.DEFAULT_TIMEOUT_MS;

  var CHAT_ENDPOINT = 'chat/completions';
  var COMPLETIONS_ENDPOINT = 'completions';

  function nowMs() {
    return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  }

  function firstDefined() {
    for (var i = 0; i < arguments.length; i++) {
      if (arguments[i] !== undefined && arguments[i] !== null) return arguments[i];
    }
    return undefined;
  }

  // 'completions' when the profile targets the plain completion endpoint,
  // otherwise 'chat/completions'.
  function endpointKind(profile) {
    var path = String((profile && profile.endpoint) || CHAT_ENDPOINT).toLowerCase();
    return (path.indexOf('chat') === -1 && path.indexOf(COMPLETIONS_ENDPOINT) !== -1)
      ? COMPLETIONS_ENDPOINT
      : CHAT_ENDPOINT;
  }

  // PLaMo 2 Translate is a translation model: while systemPrompt is empty the
  // raw English text is sent as the only message. A system message is added
  // only when the profile actually asks for one.
  function buildMessages(profile, text) {
    var messages = [];
    var systemPrompt = profile && profile.systemPrompt;
    if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
    messages.push({ role: 'user', content: text });
    return messages;
  }

  // Body for either endpoint. max_tokens is omitted unless requested: the old
  // hardcoded max_tokens: 0 makes most servers return nothing at all.
  function buildRequestBody(profile, text, kind, opts) {
    var body = {
      model: profile.model,
      temperature: firstDefined(opts.temperature, profile.temperature, 0)
    };
    var maxTokens = firstDefined(opts.maxTokens, profile.maxTokens);
    if (maxTokens) body.max_tokens = maxTokens;
    var stop = firstDefined(opts.stop, profile.stop);
    if (stop) body.stop = stop;
    if (kind === COMPLETIONS_ENDPOINT) body.prompt = text;
    else body.messages = buildMessages(profile, text);
    return body;
  }

  // Pulls the translated string out of a chat or a plain completion response.
  function extractOutputText(parsed, kind) {
    var choices = parsed && parsed.choices;
    var choice = (choices && choices.length) ? choices[0] : null;
    if (!choice) {
      if (parsed && typeof parsed.text === 'string') return parsed.text;
      if (parsed && typeof parsed.content === 'string') return parsed.content;
      return null;
    }
    if (kind === CHAT_ENDPOINT && choice.message && typeof choice.message.content === 'string') {
      return choice.message.content;
    }
    if (typeof choice.text === 'string') return choice.text;
    if (choice.message && typeof choice.message.content === 'string') return choice.message.content;
    return null;
  }

  // POSTs one text to the profile endpoint. Never throws: every failure comes
  // back as { error, errorType } so one bad segment cannot kill a batch.
  async function requestCompletion(profile, text, opts) {
    opts = opts || {};
    var timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
    var signal = opts.signal;

    if (!profile || !(profile.url || profile.baseUrl)) {
      return { error: 'Profile has no base url', errorType: 'config', translatedText: undefined };
    }
    var resolve = ns.profiles && ns.profiles.resolveEndpointUrl;
    var url = resolve ? resolve(profile) : String(profile.url || profile.baseUrl || '');
    var kind = endpointKind(profile);
    if (!url) {
      return { error: 'Cannot resolve request url from profile ' + profile.name, errorType: 'config', translatedText: undefined };
    }

    var fetchOpts = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildRequestBody(profile, text, kind, opts))
    };
    if (profile.apiKey) fetchOpts.headers['Authorization'] = 'Bearer ' + profile.apiKey;

    // One controller drives both the timeout and the caller's abort signal, so
    // stopping a page translation also cancels the in-flight fetch.
    var controller = new AbortController();
    var timedOut = false;
    var onExternalAbort = function () { controller.abort(); };
    if (signal && signal.aborted) controller.abort();
    else if (signal) signal.addEventListener('abort', onExternalAbort);
    fetchOpts.signal = controller.signal;
    var timer = setTimeout(function () { timedOut = true; controller.abort(); }, timeoutMs);

    var t0 = nowMs();
    log.debug('request ' + profile.name + ' POST ' + url + ' model=' + profile.model +
      ' kind=' + kind + ' chars=' + String(text == null ? '' : text).length);

    try {
      var res = await fetch(url, fetchOpts);
      var elapsedMs = Math.round(nowMs() - t0);
      if (!res.ok) {
        var resText = await res.text().catch(function () { return ''; });
        var msg = res.status + ' ' + res.statusText + (resText ? (' | ' + resText.slice(0, 200)) : '');
        log.warn('http_error ' + profile.name + ' ' + url + ' ' + elapsedMs + 'ms ' + msg);
        return { error: msg, errorType: 'http_error', translatedText: undefined };
      }

      var parsed;
      try { parsed = await res.json(); }
      catch (e) {
        log.warn('json_error ' + profile.name + ' ' + url + ' ' + elapsedMs + 'ms');
        return { error: 'Invalid JSON from API', errorType: 'json_error', translatedText: undefined };
      }

      var out = extractOutputText(parsed, kind);
      if (out == null || out === '') {
        var finishReason = parsed && parsed.choices && parsed.choices[0] && parsed.choices[0].finish_reason;
        log.warn('empty_response ' + profile.name + ' ' + url + ' ' + elapsedMs + 'ms' +
          (finishReason ? (' finish_reason=' + finishReason) : ''));
        return { error: 'Empty response from API', errorType: 'empty_response', translatedText: undefined };
      }

      log.debug('response ' + profile.name + ' ' + elapsedMs + 'ms chars=' + String(out).length);
      return { error: undefined, translatedText: out };
    }
    catch (e) {
      var errMsg = e && e.message ? e.message : String(e);
      if (timedOut) {
        log.warn('timeout ' + profile.name + ' ' + url + ' after ' + timeoutMs + 'ms');
        return { error: 'Request timed out after ' + timeoutMs + 'ms', errorType: 'timeout', translatedText: undefined };
      }
      if (signal && signal.aborted) {
        log.debug('aborted ' + profile.name + ' ' + url);
        return { error: 'Request aborted', errorType: 'aborted', translatedText: undefined };
      }
      log.error('connection_error ' + profile.name + ' ' + url + ': ' + errMsg);
      return { error: errMsg, errorType: 'connection', translatedText: undefined };
    }
    finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onExternalAbort);
    }
  }

  // Segment-level wrapper used by background.js: keeps the segment id on the
  // result and never rejects, so a batch keeps going when one segment fails.
  function translateSegment(profile, segment, opts) {
    return requestCompletion(profile, segment.text, opts).then(function (res) {
      if (res.translatedText) {
        return { id: segment.id, translatedText: res.translatedText };
      }
      return { id: segment.id, error: res.error, errorType: res.errorType };
    });
  }

  ns.openaiClient = {
    requestCompletion: requestCompletion,
    requestChatCompletions: requestCompletion, // previous name, kept as an alias
    translateSegment: translateSegment,
    endpointKind: endpointKind,
    buildMessages: buildMessages,
    buildRequestBody: buildRequestBody,
    extractOutputText: extractOutputText
  };
})();
