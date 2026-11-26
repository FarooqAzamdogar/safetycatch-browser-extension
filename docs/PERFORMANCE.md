# Performance

What the extension costs on every page, in every frame, and every time its service worker wakes. Measured on 2026-11-27 on the development laptop (Intel Core i5-8365U, 16 GB, Windows 11, Node 24.14.0), headless Chrome 157, safetycatch-engine 0.1.2. Other jobs ran on the same PC, so single figures move by a few milliseconds.

## What runs in every frame

| Script | Before | After |
|---|---|---|
| `content-main.js` (page world: clipboard hooks), every frame | 5.1 KB | 5.1 KB |
| `content.js` (isolated world) | 37.6 KB in **every** frame | 39.7 KB in the **top frame only** |
| `content-frame.js` (isolated world), every frame | – | 20.6 KB; in the top frame it only checks that it is the top frame and stops |
| **Per sub-frame** (ad, widget and embed frames) | **42.7 KB** | **25.7 KB (-40 %)** |
| Top frame | 42.7 KB | 65.4 KB of script read, of which 20.6 KB only checks where it is |

The sub-frame script leaves out the warning UI (11 KB), the sign-in, device-code and platform checks, and the platform and sign-in tables. A warning raised in a sub-frame is shown by the top frame through the service worker, which already worked this way for copied commands; now AI-paste prompts in a frame do the same and the top frame returns the button pressed. No permission was added (no `scripting`, no web-accessible resources).

`content.js` grew by about 2 KB because its platform list is now generated from the engine's own table, which is more complete than the old hand-made copy.

## Page-load cost (`pnpm run smoke -- --perf`)

A local page with 1,500 paragraphs and 3 iframes (four frames), median of 15 loads with and without the extension, same session for both:

| | Before | After (two runs) |
|---|---|---|
| Added at `DOMContentLoaded` | +4.9 ms (25.6 → 30.5) | +3.8 ms, +3.4 ms |
| Added at `load` | +17.7 ms (101.5 → 119.2) | +6.8 ms, +6.7 ms |

Earlier runs of the same test on a busier machine (README of 0.1.0) spread from -3 to +47 ms at `load`, so treat single numbers with care; the direction was the same in every after-run. The public yardstick (DebugBear's study of 5,000 extensions) is "under 50 ms of CPU"; the extension stays well inside it.

## What runs at every service-worker wake

Chrome stops the worker after 30 seconds without events and runs `background.js` from the top on the next wake. Evaluating its top level (the bundled engine, the rule tables and the listener wiring) once in a fresh V8 context with a stub `chrome` object, eight times each: **about 26 to 32 ms before and after** (528 KB before, 529 KB after: the sub-frame relay added about 1 KB). The engine's own lazy rule compilation (engine 0.1.1) keeps this low; nothing in this clean-up changed it. The real-browser test reports a warm worker answering in about 4 ms.

## Reproduce

```sh
pnpm run build               # prints the size of every script
pnpm run smoke -- --perf     # functional checks plus the page-load comparison
```
