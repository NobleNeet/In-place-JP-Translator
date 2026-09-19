// api/profiles.js
// Classic-script module. Exports: ns.profiles
// Two API profiles (Vivaldi EVO default + local PLaMo 2 Translate).
//
// `url` is the OpenAI-compatible **base URL** (it ends with "/v1"), NOT a full
// endpoint URL. api/openai-client.js appends the `endpoint` path (default
// 'chat/completions') to it at request time via resolveEndpointUrl(), so moving
// a profile to the plain /v1/completions endpoint is a one-line change here.
(function () {
  var ns = globalThis.__PLAMO__;

  // Endpoint path appended to the base URL when a profile sets none.
  var DEFAULT_ENDPOINT = 'chat/completions';

  var API_PROFILES = [
    {
      name: 'evo-x2-plamo2',
      url: 'http://192.168.50.28:8080/v1',
      model: 'plamo-2-translate-q4-k-m',
      apiKey: '',
      systemPrompt: '',
      endpoint: 'chat/completions'
    },
    {
      name: 'local-plamo2',
      url: 'http://127.0.0.1:8080/v1',
      model: 'plamo-2-translate-iq4-xs',
      apiKey: '',
      systemPrompt: '',
      endpoint: 'chat/completions'
    }
  ];

  function getProfile(name) {
    return API_PROFILES.find(function (p) { return p.name === name; }) || API_PROFILES[0];
  }
  function profileNames() { return API_PROFILES.map(function (p) { return p.name; }); }

  // 'http://host:8080/v1/' -> 'http://host:8080/v1' (trim spaces + trailing slashes)
  function normalizeBaseUrl(raw) {
    return String(raw == null ? '' : raw).trim().replace(/\/+$/, '');
  }

  // 'chat/completions' (no leading/trailing slash); DEFAULT_ENDPOINT when unset.
  function endpointPath(profile) {
    var path = String((profile && profile.endpoint) || DEFAULT_ENDPOINT).trim();
    path = path.replace(/^\/+/, '').replace(/\/+$/, '');
    return path || DEFAULT_ENDPOINT;
  }

  // Builds the URL to POST to: "<base>/<endpoint>" ->
  //   'http://127.0.0.1:8080/v1' + 'chat/completions'
  //   -> 'http://127.0.0.1:8080/v1/chat/completions'
  // A profile whose url already ends with an endpoint path is used as-is, so
  // both the base-URL form and the old full-URL form keep working.
  function resolveEndpointUrl(profile) {
    var base = normalizeBaseUrl(profile && (profile.url || profile.baseUrl));
    if (!base) return '';
    var path = endpointPath(profile);
    if (base === path || base.endsWith('/' + path)) return base;
    if (/\/(chat\/completions|completions|messages|embeddings)$/.test(base)) return base;
    return base + '/' + path;
  }

  // 'http://host:8080/v1' -> 'http://host:8080/v1/models'. The model-list
  // endpoint every OpenAI-compatible server exposes next to its chat endpoint;
  // the popup fetches it to fill each API's model dropdown. A base that already
  // ends in /models is returned as-is so a hand-written full URL still works.
  function modelsUrl(profile) {
    var base = normalizeBaseUrl(profile && (profile.url || profile.baseUrl));
    if (!base) return '';
    if (/\/models$/.test(base)) return base;
    return base + '/models';
  }

  // The system prompt a profile sends when the user has saved no per-API
  // value: the profile's own systemPrompt if it defines one (the bundled
  // PLaMo 2 Translate profiles set '' = no system message at all, which is
  // how a translation-specialised model must be driven), otherwise the
  // general default from constants. The popup shows exactly this value in the
  // textarea, so what you see is what gets sent.
  function effectiveSystemPrompt(profile) {
    if (profile && profile.systemPrompt != null) return String(profile.systemPrompt);
    return (ns.constants && ns.constants.DEFAULT_SYSTEM_PROMPT) || '';
  }

  // One log line: "local-plamo2 -> http://127.0.0.1:8080/v1/chat/completions (plamo-2-translate)"
  function describeProfile(profile) {
    if (!profile) return 'none';
    return profile.name + ' -> ' + resolveEndpointUrl(profile) + ' (' + (profile.model || '?') + ')';
  }

  ns.profiles = {
    API_PROFILES: API_PROFILES,
    DEFAULT_ENDPOINT: DEFAULT_ENDPOINT,
    getProfile: getProfile,
    profileNames: profileNames,
    normalizeBaseUrl: normalizeBaseUrl,
    endpointPath: endpointPath,
    resolveEndpointUrl: resolveEndpointUrl,
    modelsUrl: modelsUrl,
    effectiveSystemPrompt: effectiveSystemPrompt,
    describeProfile: describeProfile
  };
})();
