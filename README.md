# PLaMo 2 In-Page Translator

A Manifest V3 browser extension for **Vivaldi / Chromium** that extracts English
text from the page you are reading and translates it into Japanese using a
**locally running PLaMo 2 Translate** OpenAI-compatible API.

The focus of this project is **efficient use of the local LLM and fast page
translation**, not translation quality per se.

- English text is extracted as readable blocks (not one text node at a time),
  packed into batches and sent to the API **in parallel**. By default one batch
  is **one API request** carrying many text nodes, one node per line, so a page
  costs a handful of requests instead of hundreds.
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
│   ├── extractor.js         # collects translatable *text nodes* (never elements)
│   ├── segmenter.js         # one segment per text node, language heuristic, block keys, tokens, priority
│   └── renderer.js          # writes nodeValue only, registry for restore
├── api/
│   ├── profiles.js          # API profiles (endpoints, model, apiKey)
│   └── openai-client.js     # OpenAI-compatible client (swap-able later)
├── translation/
│   ├── queue.js             # ordered queue
│   ├── batcher.js           # packs DOM blocks into API requests (count + token caps)
│   ├── scheduler.js         # concurrency semaphore
│   └── cache.js             # session in-memory cache
├── shared/
│   ├── logger.js            # toggleable console logging
│   ├── constants.js         # message types + tunable defaults
│   ├── messaging.js         # log-friendly message summaries (no DOM nodes)
│   └── settings.js          # chrome.storage.local read/write
├── popup/
│   ├── popup.html
│   ├── popup.js
│   └── popup.css
├── test/
│   ├── logic.test.cjs       # queue/batcher/scheduler/cache/background (no DOM)
│   └── dom.test.cjs         # extractor/segmenter/renderer against a mini DOM
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

API profiles live in [`api/profiles.js`](api/profiles.js). `url` is the
**base URL** of the server (it ends with `/v1`), not the full endpoint URL:

```javascript
{
  name: 'evo-x2-plamo2',
  url: 'http://192.168.50.28:8080/v1',   // base URL (trailing slash optional)
  model: 'plamo-2-translate',
  apiKey: '',
  systemPrompt: '',
  endpoint: 'chat/completions'           // appended to url -> POST .../v1/chat/completions
}
```

- `profiles.resolveEndpointUrl(profile)` builds the URL that is POSTed:
  `"<url>/<endpoint>"` → `http://192.168.50.28:8080/v1/chat/completions`. A
  `url` that already ends with an endpoint path is used as-is, and a profile
  without `endpoint` defaults to `chat/completions`.
- Set `endpoint: 'completions'` to use the plain `/v1/completions` endpoint
  instead: the request body switches from `messages` to `prompt` and the
  response is read from `choices[0].text` instead of
  `choices[0].message.content`.
- `max_tokens` / `stop` are only sent when a profile (or the caller) sets
  `maxTokens` / `stop`; `temperature` defaults to `0` (greedy decoding).
- `apiKey` is currently empty. When it is `""`, **no `Authorization` header is
  sent at all** (see `api/openai-client.js`).
- `systemPrompt` is empty on purpose: PLaMo 2 Translate is a translation model,
  so the raw English text is sent as the only message. Setting a system prompt
  adds a `system` message before it for models that need one.

Every request is logged as
`request <profile> POST <resolved url> model=... kind=... chars=...`, so a wrong
URL is visible immediately in the console.

Settings you change in the popup (profile, mode, concurrency, segments per
request, request packing) are persisted in `chrome.storage.local`.

---

## Prerequisites: PLaMo 2 Translate server

- A running PLaMo 2 Translate server exposing an **OpenAI-compatible API under a
  `/v1` base URL** (`/v1/chat/completions` or `/v1/completions`).
- The server host must be listed in `host_permissions` in `manifest.json`
  (already done for `192.168.50.28:8080` and `127.0.0.1:8080`). If you point a
  profile at another host/port, add it there too and reload the extension,
  otherwise the request is blocked.
- Because the server runs on your LAN / localhost, make sure the firewall
  allows the connection from the browser.
- Quick check that a base URL is reachable and shaped as expected:

  ```sh
  curl -s http://192.168.50.28:8080/v1/chat/completions \
    -H 'Content-Type: application/json' \
    -d '{"model":"plamo-2-translate","messages":[{"role":"user","content":"Hello world"}]}'
  ```

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
[PLaMoTranslate] {"request":"r1b12","server":"evo-x2-plamo2","strategy":"multi","requests":1,"segments":16,"units":9,"estimatedTokens":2840,"align":{"requests":1,"aligned":1,"retried":0,"mismatch":0,"fallback":0},"cacheHits":0,"elapsedMs":1843,"status":"success"}
```

`requests` is how many HTTP POSTs that batch cost (1 when the line-structured
answer came back aligned), `units` how many DOM blocks were packed into it, and
`align` what the answer did: `aligned` first try, `retried` (numbered format),
`mismatch` (gave up on batching for that batch) and `fallback` segments that
were re-requested one by one.

Start / completion summary from the content script:

```
[PLaMoTranslate] packing segments=412 blocks=268 requests=24 caps=24seg/900tok first=8 strategy=multi (segments/request=17.2)
[PLaMoTranslate] done total=412 translated=410 applied=410 failed=2 skipped=0 cacheHits=3 requests=26 (24 request(s) for 412 segment(s)) in 9821ms firstTranslated=612ms cache=409
```

You can also inspect live state from the console:

```js
window.__plamo.getState()      // { phase, segments, translated, failed, applied, skipped, skipCounts, ... }
window.__plamo.getPending()    // what the extractor/segmenter found, before anything is sent
window.__plamo.getApplied(20)  // one row per text node we rewrote: { path, before, after }
window.__plamo.scanStats()     // elements walked, skipped subtrees, refused text nodes
window.__plamo.restoreText(n)  // put one text node back (n from getApplied/getPending)
window.__plamo.getCache()      // SessionCache { map, hits, misses }
window.__plamo.getSettings()   // current settings
window.__plamo.getBatchPlan()  // how the next run would be packed: { segments, blocks, requests, segmentsPerRequest, caps, strategy, batches }
window.__plamo.getBatcherCaps()// the caps the packer in use was built with (proves a saved setting landed)
window.__plamo.getChannel()    // { kind: 'port'|'none', name, requests, pending } — is the run on the durable channel?
window.__plamo.getRecoveryCaps()// { maxSegmentsPerRequest, maxRequests } used when a request dies in transport
```

---

## Tests

No test framework and no dependencies; both suites run on plain Node:

```
node test/logic.test.cjs   # queue, batcher/packer, scheduler, cache, batch request + line alignment, background, messaging
node test/dom.test.cjs     # extractor + segmenter + renderer + packer on a small fake DOM
```

`test/dom.test.cjs` builds a page containing the structures that used to break
(nested containers, text around inline links, `<pre>`/`<code>`, form controls,
`script`/`style`, `aria-hidden`, `translate="no"`, `.notranslate`, hidden
subtrees, `contenteditable`, SVG) and then checks that translating it

* produces exactly one segment per eligible text node, in document order;
* leaves every skipped subtree untouched;
* does not change the DOM **shape** (tags, attributes, number and position of
  text nodes) — only `Text.nodeValue` changes;
* can put every value back with `restore()` / `restoreAll()`, without leaving
  any bookkeeping attribute behind;
* keeps the fragments of one paragraph (text around an inline link) and the
  items of one list in a single API request — the block/container keys the
  segmenter assigns survive all the way into the packer.

Each suite prints one line per assertion and a final `RESULT: n passed, m failed`;
it exits non-zero when `m` is not 0.

---

## Concurrency and batching settings

All of these are in the popup and apply to the **next** "Translate Page" press.

- **Concurrent requests** (1 / 2 / 4 / 8, default 2): how many requests may be
  in flight at once, enforced by a semaphore (`translation/scheduler.js`). With
  multi-segment packing a slot is a whole *request*, so this limits requests,
  not text nodes.
- **Segments per request** (default 24): how many text nodes one request
  carries. A batch is also capped by estimated tokens (900), so long prose
  produces smaller batches on its own. The **first** batch is deliberately
  smaller (`firstBatchMaxSegments`, default 8) so the visible area is not held
  up behind one big request. Batching saves the prompt/prefill round trips, not
  the decoding — a model still writes the answers one after another, so a request
  costs roughly the sum of its segments and a big cap buys nothing but a big
  blast radius when one request dies.
- **Request packing**: `multi` (default — one request per batch, one text node
  per line) or `single` (one request per text node, i.e. the previous
  behaviour, kept for A/B comparison).

Packing never cuts a block in half: the fragments of one `<p>` (text around an
inline `<a>` or `<strong>`) and the items of one menu or list always stay in the
same request, because a partial block would come back as a partial translation.

A batched answer is mapped back to text nodes by **line count**. If the model
answers with a different number of lines than we sent segments, nothing is
placed — a translation in the wrong text node is worse than none — the batch is
retried once with numbered lines, and whatever still cannot be placed is
requested again one segment per request. Watch `align=` in the per-batch log to
see how often that happens; `__plamo.getBatchPlan()` tells you what a run would
cost before you start it.

### One request has to stay short (channel, timeout ceiling, recovery)

A batch is one API request, and one request now answers many text nodes, so it
can run for a long time. Two limits come from the extension itself rather than
from the server, and both used to lose whole paragraphs silently:

- **The page <-> worker channel.** `chrome.runtime.sendMessage()` answers on a
  one-shot channel that closes when the worker is recycled, which produced
  `A listener indicated an asynchronous response by returning true, but the
  message channel closed before a response was received` and dropped every
  segment of that batch. Translation requests therefore go over a **port**
  (`plamo.translate-channel`) that the page keeps open for the length of a run:
  it answers whenever a batch is ready, a connected port also keeps the worker
  alive, and a worker that dies mid-request is logged as
  `port#1 closed ... WITH 1 REQUEST(S) STILL IN FLIGHT`. `sendMessage` is still
  accepted (a page whose `connect()` failed), and `__plamo.getChannel()` reports
  which channel a run used.
- **The per-request timeout ceiling.** The timeout of a batched request is
  `timeoutBaseMs + timeoutPerTokenMs x estimatedTokens`, then clamped to
  `MAX_REQUEST_TIMEOUT_MS` (90 s). A request that is allowed to run for six
  minutes is not a patient client — it is a batch that will come back as a
  transport error. When the clamp fires the log says so:
  `timeout=90000ms batchTimeout=90000ms (capped at 90000ms from 245000ms: ...)`.
  If you see that line often, pack smaller (lower *Segments per request* or the
  token cap) instead of raising the ceiling.

Nothing is written off when a request dies anyway. A batch whose request never
came back is re-sent as small requests:

```
[PLaMoTranslate] run#1 batch#28 TRANSPORT FAILURE for 16 segment(s): ...
[PLaMoTranslate] run#1 batch#28 RECOVERY: re-sending 16 of 16 segment(s) as 3 smaller request(s) (6 segment(s) each, sequential)
```

Inside the worker the same idea applies per failure kind: a batch that timed
out, answered nothing, or could not be split back by line count gets one more
attempt per segment, while a 404/connection error is *not* retried 16 times
(that log line names the reason: `not retried one by one: the request itself
failed (http_error)`). The retry sizes are `RECOVERY.maxSegmentsPerRequest` (6)
and `RECOVERY.maxRequests` (12) in `shared/constants.js`.

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
- [x] Bounded batching (count + estimated tokens) with block-aware packing
- [x] Multi-segment-per-request batching: one request carries a whole batch
      (one text node per line), mapped back by line count
- [x] Alignment safety: numbered retry, then per-segment fallback, never a
      guessed line placement
- [x] Bounded concurrency (1/2/4/8) with semaphore
- [x] Timeout + AbortController, with a hard per-request ceiling
      (`MAX_REQUEST_TIMEOUT_MS`) so a request never outlives extension messaging
- [x] Durable page<->worker channel (`chrome.runtime.connect` port) for translate
      requests, with `sendMessage` kept as a fallback
- [x] Transport-failure recovery: a batch whose request died is re-sent as
      several small requests instead of losing its segments
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
- [ ] Server-side batching (`/v1/completions` with a `prompt` array, llama.cpp
      batch endpoint, or a native batch endpoint) instead of one line-separated
      prompt
- [ ] Per-profile batch prompt / system prompt, so a model that insists on a
      different answer format can be pinned to it per server

---

## Notes on API abstraction

`api/openai-client.js` is the only place that talks to the network. Swapping to
`/v1/completions`, `llama.cpp` multi-prompt, or a native batch endpoint only
requires replacing that file; the page/translation code stays untouched.
