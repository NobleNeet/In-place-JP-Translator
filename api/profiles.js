// api/profiles.js
// OpenAI-compatible API profiles.
//
// apiKey === "" -> no Authorization header is sent at all
// (see api/openai-client.js). Edit the endpoints below to match your setup.

export const API_PROFILES = [
  {
    name: 'evo-x2-plamo2',
    endpoint: 'http://192.168.50.28:8080/v1',
    apiKey: '',
    model: 'plamo-2-translate',
    // Left empty so the raw English text is sent as-is (per the design goal).
    // Non-empty values are sent as the optional system message.
    systemPrompt: '',
  },
  {
    name: 'loopback-plamo2',
    endpoint: 'http://127.0.0.1:8080/v1',
    apiKey: '',
    model: 'plamo-2-translate',
    systemPrompt: '',
  },
];

export function getProfile(name) {
  return API_PROFILES.find((p) => p.name === name) ?? API_PROFILES[0];
}

export function profileNames() {
  return API_PROFILES.map((p) => p.name);
}
