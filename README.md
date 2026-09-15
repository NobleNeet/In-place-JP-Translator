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
│   ├── priority.js          # which region a text node sits in, and whether the user can see it
│   └── renderer.js          # writes nodeValue only, registry for restore
├── api/
│   ├── profiles.js          # API profiles (endpoints, model, apiKey)
│   └── openai-client.js     # OpenAI-compatible client (swap-able later)
├── translation/
│   ├── queue.js             # ordered queue
│   ├── batcher.js           # packs DOM blocks into API requests (count + token caps)
│   ├── scheduler.js         # concurrency semaphore (one per API profile)
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

### Using several APIs at the same time

The popup lists every profile as a row with a tick box and its own concurrency
select. Tick several and one "Translate Page" run sends its batches through
**all of the ticked servers in parallel**:

- Each API has **its own request limiter** in the worker (`background/background.js`
  keeps one semaphore per profile), so its concurrency is set independently —
  a strong box at 4 next to a small one at 1 works as expected.
- Batches are distributed by a **weighted round-robin** (`apiPlan()` in
  `shared/settings.js`): an API appears in the schedule once per concurrency
  slot it can fill, so its share of the requests matches its share of the
  in-flight load (evo at 2 + local at 4 → two thirds of the batches go to
  local). The send **order** never changes (article body first), only the
  server a batch lands on.
- Saved under `apis` in `chrome.storage.local`, keyed by profile name:
  `{ "evo-x2-plamo2": { "enabled": true, "concurrency": 2 }, ... }`. No
  entries (every install saved before this existed) keeps the old
  single-profile behaviour: `profileName` alone, at `maxConcurrent`.
- What a run would use: `__plamo.getApiPlan()` on the page; per-server limiter
  numbers: `__PLAMO__.background.snapshot().apis` in the worker.

There is **no failover between servers yet**: if one ticked API is down, only
its share of the batches fails — the others keep translating.

Settings you change in the popup (API servers and their concurrency, mode,
segments per request, request packing) are persisted in `chrome.storage.local`.

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
4. (Optionally tick the API servers to use — several at once are supported —
   and set each one's concurrency in the popup first.)
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
window.__plamo.getUntranslated()// what is STILL English: { count, sample { path, text, cached }, scan, segmentSkipped, deferredHidden }
window.__plamo.getApplied(20)  // one row per text node we rewrote: { path, before, after }
window.__plamo.scanStats()     // elements walked, skipped subtrees, refused text nodes
window.__plamo.restoreText(n)  // put one text node back (n from getApplied/getPending)
window.__plamo.getCache()      // SessionCache { map, hits, misses }
window.__plamo.getSettings()   // current settings
window.__plamo.getBatchPlan()  // how the next run would be packed: { segments, blocks, requests, segmentsPerRequest, caps, strategy, batches }
window.__plamo.getBatcherCaps()// the caps the packer in use was built with (proves a saved setting landed)
window.__plamo.getChannel()    // { kind: 'port'|'none', name, requests, pending } — is the run on the durable channel?
window.__plamo.getRecoveryCaps()// { maxSegmentsPerRequest, maxRequests } used when a request dies in transport
window.__plamo.getSegmentStats()// last scan: { nodes, visibleNodes, hiddenNodes, deferred, deferHidden, segments, blocks, roles, skipped }
window.__plamo.getDeferred(20) // text a run held back: { waiting, watching, attrs, stats, sample }
window.__plamo.revealNow()     // force the "is that hidden text displayed yet?" check
window.__plamo.forgetDeferred()// drop the waiting list (a page that re-rendered from scratch)
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

- **API servers** — one row per profile (`api/profiles.js`): tick it to use
  that server, and set **its own** max concurrent requests (1 / 2 / 4 / 8).
  Each ticked server gets a separate semaphore (`translation/scheduler.js`) in
  the worker, and its share of the batches is proportional to its concurrency
  (see *Using several APIs at the same time* above). With one server ticked
  this behaves exactly like the old single "Max concurrent requests" setting.
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
- **Hidden text**: `wait until it is shown` (default — the text of a closed menu
  or a tab panel is held back and translated when it is displayed, so it costs no
  request the reader never waits for) or `translate at once` (send hidden text
  with the rest of the page). See *Text the reader cannot see* below.

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

### Text the reader cannot see (held back, then translated when it is shown)

A closed dropdown, a tab panel behind `display:none` and a mobile menu repeat the
page several times over, and the hidden copy is not text anybody is reading. By
default such text is **not sent at all**: the run holds it back and the start line
says so (`deferred=4 deferHidden=true`). `content/priority.js` answers the
question — attributes first (`hidden`, or an inline `style` containing
`display:none` / `visibility:hidden|collapse`), then `getComputedStyle` per
element, walking up the ancestor chain and stopping at the first hidden ancestor,
so a closed menu subtree costs one CSS lookup instead of one per item. A scan
asks the CSS at most `maxHiddenChecks` (6000) questions and logs a warning when it
runs out; past that it assumes visible, which is what every build before this
assumed all the time.

Every text node also gets a **region**, and the region is what decides the order
the rest of the page is sent in: hidden first out of the way, then the class
(`content`, then `heading`, then `navigation`, then whatever is left), then the
viewport band inside a class, then the order the tree was walked. The markers are
`MAIN`/`ARTICLE`, `role=main|article|feed` and class words like `article`/`post`/
`content` for the body; `H1`–`H6` for headings; `NAV`/`HEADER`/`FOOTER`/`ASIDE`/
`MENU`, `role=navigation|menu|menubar|tablist|toolbar|search|banner|contentinfo|
complementary` and class/id words like `nav`/`menu`/`sidebar`/`footer`/`toc` for
page chrome — chrome wins, because being inside a menu is secondary whatever tag
you are. A run of 120+ characters with no marker at all counts as body text
instead of being made to wait behind the menu. `__plamo.getState().roles` and the
`roles={...}` in the run log show what a page is made of, which is how "it
translated the menu before the article" gets answered with numbers.

Once a run holds text back, a **reveal watch** covers it: a `MutationObserver` on
`style`, `class`, `hidden`, `aria-hidden`, `inert` and `open` (subtree) triggers a
re-check of the queued nodes `revealDebounceMs` (250 ms) after the last change —
opening a menu touches a class, a style and an aria attribute at once, and one
check per burst is enough — plus a fallback poll every `revealIntervalMs` (4 s)
for sites that animate without touching any of those attributes. A node that
turns out to be displayed is translated by a run of its own; a node the run sent,
or that a reveal already rewrote, leaves the queue, so a menu opened between two
runs costs one small request instead of a re-read of the whole page. `Stop` ends
the watch but keeps the queue, so the next run picks the same nodes up (while Stop
is in effect a displayed node is *not* translated — it goes back on the queue
instead of being lost). `Restore` empties the queue, because nothing is being
waited for any more. `__plamo.getDeferred()` shows what is still waiting.

To send hidden text with the rest of the page instead, choose *Hidden text →
translate at once* in the popup (it applies to the next "Translate Page" press).
The knobs live under `priority` in `chrome.storage.local` — `deferHidden`,
`revealDebounceMs`, `revealIntervalMs`, `maxHiddenChecks` — with defaults in
`PRIORITY_SETTINGS` in `shared/constants.js`.

### When a paragraph stays in English

`__plamo.getUntranslated()` answers "why is this paragraph still English?" in
one look: it lists the visible text a fresh run would send and has never
written, and the `scan` / `segmentSkipped` numbers say what never became a
segment at all. The three things that can leave text behind:

- **The model copied the English** (log: `not written [identical]`). A copy is
  not a translation: it is never cached, and each copied segment gets exactly
  one more request at the end of the run — a small batch carrying an explicit
  do-not-copy system instruction (log: `echo#N`). Still copied after that, it
  stays English and says so; no endless retry loop.
- **A paragraph longer than `EXTRACT.maxTextLength`** (default 12 000 chars) is
  refused — but never silently: `extract: N text node(s) exceed...` names them
  in the console and `scanStats().tooLong` counts them. Raise the cap if your
  server answers a single huge node inside the request timeout; the packer
  already gives an oversized node a request of its own.
- **Screen-reader text** (`.sr-only`, `.visually-hidden`, ...) is invisible by
  design, so it is never extracted, never deferred, never a request — that is
  also where most of the `[identical]` noise on real pages came from.

---

## Implemented features (Phase 1)

- [x] Manifest V3 (Vivaldi/Chromium, classic scripts, no build step)
- [x] Manual "Translate Page" start from the popup
- [x] Multiple API profiles at once: batches split over every ticked server by
      weighted round-robin, each with its own concurrency limiter (single
      profile still works, and is the default)
- [x] OpenAI-compatible `/v1/chat/completions` client (separated layer)
- [x] Readable-block DOM extraction with proper exclusions
- [x] Segment with unique id + stable DOM reference
- [x] Language heuristic (skips obvious non-English)
- [x] Loose token estimation (separated function)
- [x] Viewport priority (visible → near → rest)
- [x] Region priority (article body → headings → page chrome) and hidden text
      held back until it is displayed, with a reveal watch on `style`/`class`/
      `hidden`/`aria-hidden`/`inert`/`open` (debounced re-check + fallback poll)
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
- [ ] Failover between API profiles: a server that is down should have its
      batches re-sent through the other ticked server, instead of only failing
      its own share
- [ ] `IntersectionObserver` viewport streaming — the bands are measured with
      `getBoundingClientRect()` at scan time (on screen / within 400 px / rest), so
      a node that scrolls into view while a run is going keeps the band it had
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
