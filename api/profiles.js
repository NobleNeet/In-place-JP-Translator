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
    describeProfile: describeProfile
  };
})();
