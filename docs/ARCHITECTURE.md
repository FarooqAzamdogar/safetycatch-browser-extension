# Architecture

## Pieces

| File in the build | Runs in | Size (minified) | Job |
|---|---|---|---|
| `content-main.js` | every frame, the page's own JavaScript world, `document_start` | 5 KB | Hooks the ways a page can write to the clipboard and forwards the text. No analysis, no UI |
| `content.js` | every frame, isolated world, `document_start` | 37 KB | Pre-filters, copy / paste / password-box watchers, the warning UI |
| `background.js` | service worker (Chrome, Edge) or event page (Firefox) | 475 KB | The detection engine, decisions, warning wording, settings, navigation chain, downloads |
| `popup.js`, `options.js`, `download.js` | extension pages | 4 to 15 KB | Popup, options, download prompt |

Source layout:

```
src/shared/       pure logic, no browser APIs: decisions, pre-filters, protocol, allowlist, history,
                  navigation chain, copy tracking, scopes, i18n, channel wire format
src/content/      main-hooks.ts (page world), isolated.ts (content script), ui.ts, insert.ts, channel-iso.ts
src/background/   core.ts (logic, testable in Node), models.ts (warning wording), service-worker.ts (wiring)
src/pages/        popup, options, download prompt
src/locales/      one flat JSON catalog per language (English is the source)
scripts/          build, zip writer, icon generator, manifest, page server, real-browser smoke test
test/             unit tests, the fake window for hook tests, harmless test pages
```

## Where the engine runs, and why

The engine with its Public Suffix List data is about 450 KB of JavaScript. Three options were considered:

1. **Engine in every page.** Simple, synchronous verdicts. But every frame of every page would parse and hold the engine. Rejected: the per-page cost is paid thousands of times a day for a check that is needed a few times a week.
2. **Engine in the service worker; content scripts ask after a cheap local pre-filter.** Chosen. Pages get 42 KB. The engine is loaded once, when first needed.
3. **Engine in an offscreen document.** Needs the extra `offscreen` permission and buys nothing over option 2.

Consequences of the choice:

- **Verdicts are asynchronous.** For the asynchronous clipboard API the page-world hook simply waits for the answer before calling the real `writeText` (the caller gets a promise either way). For the synchronous paths (`execCommand`, copy-event handlers, an ordinary Ctrl+C) the copy cannot be held back, so the content script records what was copied, checks it and then *neutralises* the clipboard: "detect, then neutralise". The gap is a few tens of milliseconds, far shorter than the time it takes to open a Run box and paste. For pastes into AI chats the paste event is cancelled first and replayed after the verdict.
- **Service-worker sleep.** Chrome stops an idle service worker after about 30 seconds. A message wakes it; a cold start answered in about 0.8 s in our measurements. Nothing is kept only in memory: settings and recent warnings are in `storage.local`; the navigation chain, "I chose to continue" marks and pending downloads are in `storage.session` (memory-backed, survives worker restarts, erased when the browser closes). Read-modify-write steps are queued so parallel events cannot overwrite each other.
- **Engine cold start.** The engine compiles its rules on first use. For most analyzers that is a few tens of milliseconds, but the page-text analyzer needed 1.5 to 2.5 s for its first call on our (heavily loaded) test machine and under 10 ms afterwards. So the worker (a) runs page-text analysis for a copy only when the page's level could change the decision (it cannot for ordinary text, or for a command that is blocked on its own), (b) starts that one-off compilation ahead of time when a tab opens a page on a publish-anything platform, where the question is about to be asked, and (c) never waits for bookkeeping (the recent-warnings write) before answering.
- **Failure.** Every request from a content script has a time limit (4.5 s for a copy that is waiting, 4 s for a held paste, 8 s for passive checks, which are repeated a couple of times if they get no answer). No answer, an exception in the engine, or a verdict marked `incomplete` all become the level `unknown`. `shared/decisions.ts` turns `unknown` into a neutral "could not check" notice, or, for copied text that a small local heuristic (`looksRunnable`) says is a fetch-or-hide command, into a block with "Not checked" wording. It never becomes "allow, all good".

## The pre-filters

`shared/prefilter.ts` runs in the content script. A "yes" only means "ask the engine".

| Pre-filter | Says "no need to ask" for | Tested against |
|---|---|---|
| `needsCommandCheck` | text under 8 characters, a single web link, plain prose | every attack sample the engine rates medium or worse must pass |
| `mightHoldSecret` | text without key shapes, credential assignments, long digit runs or a seed-phrase shape | same, with `scanSecrets` |
| `isAuthUrlCandidate` | addresses not on a known identity-provider host and path | every device-code and consent endpoint in the engine's tables |
| `isPlatformHint` | hosts not on the list of publish-anything platforms | every platform host and path in the engine's tables |

The last two tests read the engine's rule tables directly (tests only) so the lists cannot silently drift apart.

On an ordinary page the content script: creates the channel (two events), registers about fifteen listeners, starts one observer on the document node and, in the top frame, one debounced observer that looks for a password box. No storage read happens until the first key press or click; no message is sent unless a pre-filter fires.

## The private channel between the two page scripts

The page-world script cannot use extension APIs, and the content script cannot see the page's JavaScript objects. They talk through synchronous `CustomEvent`s on `window` whose names contain a 128-bit random token.

Handshake (order-independent, completes before any page script can run in a normal document):

1. Whichever script starts second triggers it. The content script dispatches `hello-iso` carrying the token; the page-world script answers by cancelling that event.
2. From then on messages go on `ag-u-<token>` (to the content script) and `ag-d-<token>` (back). Each side confirms receipt by cancelling the event, so the sender knows synchronously whether it arrived.
3. Once connected, neither side answers hellos any more, so a page cannot ask for the token later.

Because delivery is synchronous, an ordinary copy is approved *during* the page's own `writeText` call and the real write happens without any delay.

`document.open()` erases every event listener on the window, including ours. Both sides re-attach (adding the same listener twice is harmless): the content script when its observer sees the document being replaced, the hook each time it sends. A write that cannot be delivered is retried for about 6 seconds and then **refused**, not waved through.

Residual risk is described in THREAT_MODEL.md.

## What happens on a copy

```
page calls navigator.clipboard.writeText(text)
  hook converts text to a string once, sends "w id text"
    content script: needsCommandCheck(text)?
      no  -> answers "allow" at once -> hook calls the real writeText (no delay)
      yes -> asks the service worker (text + up to 20,000 characters of page text)
               engine: analyzeCommand(text), analyzePageText(pageText, { url })
               decidePaste(command level, page level, source, ...) -> allow | notice | block | unchecked
             block: content script writes a harmless note to the clipboard, answers "block"
                    (the page's promise resolves as if the copy worked), shows the full-page warning
```

For `execCommand('copy')`, copy-event handlers and ordinary Ctrl+C, `shared/copytrack.ts` works out which text ended up on the clipboard from what could be observed (text passed to `setData`, the selection at several moments, `clipboardData` at the end of the event) and each candidate goes through the same check.

The decision also depends on *who chose the text*: a page that picks the text itself (`programmatic`) or swaps it during your copy (`hijack`) is judged strictly; text you selected yourself is blocked only when it is critical or when the page also shows paste-and-run instructions, otherwise you get a banner.

## Warning wording

All wording is produced in the service worker (`background/models.ts`) from engine verdicts (passed through the engine's `localize`) and the extension's catalog, as a plain data object (`WarningModel`). Content scripts and the download prompt only render it with `textContent`. This keeps catalogs out of every page and makes the language setting apply everywhere. The few warnings that must work without the service worker use the browser's own `i18n.getMessage`.

## Building

`scripts/build.ts` bundles with esbuild (minified, IIFE, no remote code), writes one manifest per browser (`scripts/manifest.ts`), converts catalogs to `_locales/` (`scripts/locales.ts`, English fills gaps), draws the icons in code (`scripts/icons.ts`) and writes the zip files with a small ZIP writer (`scripts/zip.ts`, fixed timestamps, sorted entries, so builds are reproducible). Size budgets fail the build if a page script grows unexpectedly, for example because the engine was pulled into it. Source maps go to `dist/sourcemaps/` and are never packaged.

## Differences between browsers

| | Chrome / Edge | Firefox |
|---|---|---|
| Background | `service_worker` | `background.scripts` (event page) |
| Minimum version | 120 (`match_origin_as_fallback` for content scripts) | 128 (`world: "MAIN"` content scripts) |
| Site access | granted at install | optional: the person grants it in about:addons |
| Download file name | `downloads.onDeterminingFilename` and `onChanged` | `onCreated` / `onChanged` |
| "Is something covering this button" check | uses the visibility mode of IntersectionObserver | not available; the check is skipped |
| Status | 39 real-browser checks pass in Chrome 157 and Edge 158 | built and reviewed, not yet run |
