// api/profiles.js
// Classic-script module. Exports: ns.profiles
// Two API profiles (Vivaldi EVO default + local PLaMo 2 Translate).
(function () {
  var ns = globalThis.__PLAMO__;
  var API_PROFILES = [
    {
      name: 'evo-x2-plamo2',
      url: 'https://evo-api.vivaldi.net/v2/plamo2/translate',
      model: 'plamo2-13b',
      apiKey: '',
      systemPrompt: ''
    },
    {
      name: 'local-plamo2',
      url: 'http://127.0.0.1:8080/v1/chat/completions',
      model: 'plamo2-translate',
      apiKey: '',
      systemPrompt: ''
    }
  ];

  function getProfile(name) {
    return API_PROFILES.find(function (p) { return p.name === name; }) || API_PROFILES[0];
  }
  function profileNames() { return API_PROFILES.map(function (p) { return p.name; }); }

  ns.profiles = {
    API_PROFILES: API_PROFILES,
    getProfile: getProfile,
    profileNames: profileNames
  };
})();
