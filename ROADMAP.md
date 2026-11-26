# Roadmap

Where actionguard-browser goes after 0.1.0. Order within a section is the intended order of work. Nothing here is a promise.

## Before a first store release (0.2)

1. **Run and fix the Firefox build.** Walk `docs/MANUAL_TEST.md` in Firefox 128+ and ESR; check `adoptedStyleSheets` in content scripts, the popover top layer, `clipboardWrite` from the content script and the event-page lifecycle. Add Firefox to the smoke test (WebDriver BiDi or `web-ext run`).
2. **False-positive crawl harness.** A script that drives the built extension over a list of popular sites (documentation sites, package registries, code hosts, banks' real sign-in pages, webmail, AI chats) and their copy buttons, and records every warning. Target: **warnings on fewer than 1 % of popular sites**, zero full-page warnings on real brand sign-in pages. Results feed the engine's false-positive corpus. Run it before every release.
3. **Native review of translations**, starting with Spanish, Urdu, Hindi and Arabic. Remove the machine-translation flag per language as it is reviewed.
4. **Accessibility pass** with NVDA, JAWS, VoiceOver and Orca; high-contrast and forced-colours modes; 400 % zoom.
5. **Store submissions**: Chrome Web Store, Microsoft Edge Add-ons, Firefox Add-ons. Screenshots from the test pages, public privacy-policy URL, real Firefox add-on id, trademark check on the name.
6. **Independent security review** of `main-hooks.ts`, the channel and the warning UI.

## Closing known gaps

- **Fresh-frame hook bypass.** Cover `window[index]`, `window.frames` and `window.open('about:blank')`: hook frame insertion points, or move the last line of defence out of the page world entirely with the browser's `clipboardchange` event where it is available, which tells the content script that the clipboard changed while the page had focus without relying on any hook. An unexplained change on a page with paste-and-run instructions would then be neutralised.
- **Sub-frame coverage in the smoke test.** The relay of a warning from a cross-site iframe to the top frame is unit-tested only; add a cross-origin iframe test page.
- **Sign-in pages without a password box**: email-first flows, passkey prompts, one-time-code pages, forms inside closed shadow roots.
- **Password managers and autofill** on look-alike pages: detect a filled password field and warn before submit.
- **Rich paste.** When the AI-chat guard holds a paste back and then lets it through, re-insert the original rich content instead of plain text; check pasted and dropped files by name and type.
- **Typed secrets.** Optional check of the whole prompt on submit, not only on paste.
- **Download origin.** Use the tab that started the download rather than the active tab; add **ad-click provenance** (was the page reached through a search ad?) to the download verdict using the navigation chain.
- **Download-and-run instructions** in languages other than English; ideally as engine rules rather than an extension-side heuristic.
- **Per-protection trust.** "Trust this site for copy buttons only" instead of all-or-nothing.
- **Settings sync** (optional, `storage.sync`), with the allowlist excluded by default.

## New protections

- **QR codes inside web pages and webmail.** Find QR images in pages and email bodies, decode them on the device, run the payload through the engine's `analyzeQrPayload`, and badge codes that link a device, start a payment or lead to a sign-in page ("quishing").
- **"EtherHiding" signal.** Ordinary pages that fetch payloads from public blockchain RPC endpoints (`eth_call` to a smart contract, then script injection). Needs a careful, privacy-preserving way to observe requests (`declarativeNetRequest` match counts or a `PerformanceObserver` for resource entries), not `webRequest`.
- **Optional local reputation lists** through `declarativeNetRequest`: license-checked feeds only (no non-commercial data), downloaded only if the person opts in, listed under "Network use", and always as an extra layer under the action-based checks.
- **Call-back / family code-word prompt** on payment and one-time-code requests: when a page asks for a bank transfer, gift-card code or one-time code right after arriving from a message, suggest calling the person or organisation back on a known number, or asking for the family code word.
- **Fake support and remote-access lures**: pages that tell the person to install a remote-desktop tool or call a number shown in a full-screen "your computer is infected" page; detect forced fullscreen, keyboard lock and pointer lock abuse.
- **Browser-in-the-browser sign-in pop-ups**: a fake window drawn inside the page with a fake address bar. Detect a password box inside an element styled as a window with URL-like text that does not match the page's real address.
- **ConsentFix / "copy the address bar" lures**: warn when a page asks the person to copy a `localhost` or authorisation-code address out of the address bar and paste it back.
- **Clipboard address swapping** (crypto wallet addresses replaced on copy): compare what was selected with what was written when both look like wallet addresses.
- **File-upload and "drag this file here" lures** (FileFix variants that use the file picker's address bar): warn when a page opens a file dialog right after copying text.

## Explanations

- **Small on-device model explanations.** Where the browser offers a built-in on-device language model, use it to explain in the person's own language what a blocked command would have done ("downloads a program from ... and runs it hidden"). Strictly local, optional, and never used to decide whether to block.
- **"Why did I see this?"** A page linked from each warning that shows the rules that fired, with the engine's references, and a one-click "report a false alarm" that prepares (but does not send) an issue with rule names only.
- **Learning mode.** A harmless built-in demo of each attack, based on the test pages, so people can see a warning before they meet a real one.

## Engineering

- Reproducible-build check in CI (build twice, compare zip hashes) and signed release artefacts.
- Property-based tests for `decidePaste`, the channel codec and the navigation chain.
- Size and performance budgets in CI from `npm run smoke -- --perf`.
- A leaner script for sub-frames (clipboard watcher only) with the warning UI and the top-frame checks loaded only where they are needed, to cut the per-frame start-up cost.
- Work with the engine on its cold start: the page-text analyzer takes a second or more on first use after the worker wakes.
- Safari (WebExtensions on macOS and iOS) feasibility study; mobile Firefox for Android.
- Enterprise policy support (`storage.managed`): force protections on, pre-set trusted sites, hide the "trust this site" control.

## Ideas noted while building 0.1

- The engine could expose two small things that the extension currently works around: the official domain of the brand named in a `url.brand-impersonation` finding, and a redaction mode limited to medium-and-worse findings.
- The same hooks and warning UI could serve a **desktop clipboard guard** hand-off: when the companion desktop tool is installed, tell it which site wrote the clipboard so that it can warn at paste time in the terminal.
- A **"panic clear"** toolbar action that empties the clipboard and closes the tab in one step.
