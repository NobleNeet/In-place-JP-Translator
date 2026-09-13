# PLaMo 2 In-Page Translator

A Manifest V3 browser extension for **Vivaldi / Chromium** that extracts English
text from the page you are reading and translates it into Japanese using a
**locally running PLaMo 2 Translate** OpenAI-compatible API.

The focus of this project is **efficient use of the local LLM and fast page
translation**, not translation quality per se.

- English text is extracted as readable blocks (not one text node at a time),
  grouped into batches, and sent to the API **in parallel**.
- Currently visible content is translated first (viewport priority), and
  completed batches are applied to the DOM as they finish.
- All network access is centralized in the background service worker; content
  scripts never call the API directly.

---

## Directory structure

```
plamo-page-translator/
├── manifest.json
├── background/
│   └── background.js        # centralizes all API access (chat/completions)
├── content/
│   ├── content.js           # orchestrator: extract -> segment -> batch -> apply
│   ├── extractor.js         # DOM extraction (readable blocks only)
│   ├── segmenter.js         # segmentation, language heuristic, token estimate, priority
│   └── renderer.js          # applies translation, preserves original text
├── api/
│   ├── profiles.js          # API profiles (endpoints, model, apiKey)
│   └── openai-client.js     # OpenAI-compatible client (swap-able later)
├── translation/
│   ├── queue.js             # ordered queue
│   ├── batcher.js           # bounded batch creation
│   ├── scheduler.js         # concurrency semaphore
│   └── cache.js             # session in-memory cache
├── shared/
│   ├── logger.js            # toggleable console logging
│   ├── constants.js         # message types + tunable defaults
│   └── settings.js          # chrome.storage.local read/write
├── popup/
│   ├── popup.html
│   ├── popup.js
│   └── popup.css
└── README.md
```

The extension is **plain JavaScript + HTML + CSS**. No build step is required:
you can load the directory directly in Developer mode.

---

## Loading into Vivaldi

1. Open `vivaldi://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked** and select this project directory.
4. Pin the PLaMo 2 Translator icon.

> Loads as classic scripts (no build step), so it works on any Chromium-based
> Vivaldi without the `"type": "module"` content-script requirement.

---

## API settings

API profiles live in [`api/profiles.js`](api/profiles.js):

```javascript
{
  name: "evo-x2-plamo2",
  endpoint: "http://192.168.50.28:8080/v1",
  apiKey: "",
  model: "plamo-2-translate",
}
```

- `apiKey` is currently empty. When it is `""`, **no `Authorization` header is
  sent at all** (see `api/openai-client.js`).
- `systemPrompt` is empty on purpose: PLaMo 2 Translate is a translation model,
  so the raw English text is sent as the only message. The mechanism to set a
  system prompt exists for future models.

Settings you change in the popup (profile, mode, concurrency) are persisted in
`chrome.storage.local`.

---

## Prerequisites: PLaMo 2 Translate server

- A running PLaMo 2 Translate server exposing an **OpenAI-compatible
  `/v1/chat/completions`** endpoint.
- The endpoint URL must be added to `host_permissions` in `manifest.json`
  (already done for `192.168.50.28:8080` and `127.0.0.1:8080`).
- Because the server runs on your LAN / localhost, make sure the firewall
  allows the connection from the browser.

---

## How to start a translation

Phase 1 does **not** translate automatically. Start it manually:

1. Open an English web page.
2. Click the PLaMo 2 Translator icon.
3. Click **Translate Page**.
4. (Optionally change the API profile / concurrency in the popup first.)
5. To stop, click **Stop Translation**.

---

## Viewing console logs

Open **DevTools → Console** on the page. All diagnostics are prefixed with
`[PLaMoTranslate]`.

Per-batch metric (printed as one line):

```
[PLaMoTranslate] {"batch":12,"server":"evo-x2-plamo2","segments":16,"estimatedTokens":2840,"elapsedMs":1843,"status":"success"}
```

Start / completion summary:

```
[PLaMoTranslate] start: 412 segments in 27 batch(es)
[PLaMoTranslate] done { total: 412, translated: 410, failed: 2, cacheHits: 3, elapsedMs: 9821, firstTranslatedLatencyMs: 612, firstViewportLatencyMs: 612 }
```

You can also inspect live state from the console:

```js
window.__plamo.getState()   // { phase, segments, translated, failed, ... }
window.__plamo.getCache()   // SessionCache { map, hits, misses }
window.__plamo.getSettings()// current settings
```

---

## Concurrency setting

Change it in the popup: **1 / 2 / 4 / 8** concurrent requests to the API.
Default is **2**. This is enforced by a semaphore
(`translation/scheduler.js`) so in-flight requests never exceed the limit.
Phase 5 compares these values against each other.

---

## Implemented features (Phase 1)

- [x] Manifest V3 (Vivaldi/Chromium, classic scripts, no build step)
- [x] Manual "Translate Page" start from the popup
- [x] Single API profile (`single` mode)
- [x] OpenAI-compatible `/v1/chat/completions` client (separated layer)
- [x] Readable-block DOM extraction with proper exclusions
- [x] Segment with unique id + stable DOM reference
- [x] Language heuristic (skips obvious non-English)
- [x] Loose token estimation (separated function)
- [x] Viewport priority (visible → near → rest)
- [x] Bounded batching (count + estimated tokens)
- [x] Bounded concurrency (1/2/4/8) with semaphore
- [x] 120s timeout + AbortController
- [x] Per-segment error isolation (one batch failing doesn't stop the rest)
- [x] Session cache for duplicate text
- [x] Original text preserved in `data-*` attributes
- [x] Metrics + per-batch console logging (toggleable)

## Not yet implemented (later phases)

- [ ] `fallback` / `balanced` connection modes (structure only)
- [ ] Full priority queue + `IntersectionObserver` viewport streaming
- [ ] SPA support via `MutationObserver` + debounce
- [ ] Persistent cache
- [ ] Auto-translate on load / per-domain allowlist
- [ ] Rendering modes (translation only / original only / both)
- [ ] Multi-segment-per-request batching (continuous batching)

---

## Notes on API abstraction

`api/openai-client.js` is the only place that talks to the network. Swapping to
`/v1/completions`, `llama.cpp` multi-prompt, or a native batch endpoint only
requires replacing that file; the page/translation code stays untouched.
