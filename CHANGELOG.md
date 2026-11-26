# Changelog

All notable changes to this project are documented in this file. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Switched from npm to pnpm 11 (`packageManager: pnpm@11.29.0`, `pnpm-lock.yaml`). pnpm keeps one shared copy of each package on disk and hard-links it into every project, which cut the suite's dependency footprint on a development PC. pnpm 11 is used because it is plain JavaScript; pnpm 12 ships an unsigned native executable. Dependency install scripts are not allowed to run (`pnpm-workspace.yaml`). Package scripts chain with `node --run`. The engine is now linked live (`link:../safetycatch-engine`) instead of copied.
- CI uses `pnpm/action-setup` and current pinned versions of `actions/checkout` and `actions/setup-node`.

## [0.1.0] - 2026-11-26

First version. Not yet published to any store.

### Added

- **Paste guard (ClickFix / FileFix).** Page-world hooks on `navigator.clipboard.writeText` and `write`, `document.execCommand('copy' | 'cut')` and `DataTransfer.setData`, in every frame from `document_start`. Copied text is checked with the engine's `analyzeCommand` plus `analyzePageText` for the page's visible instructions. High and critical results replace the clipboard with a harmless note and show a full-page warning with the command shown as text; putting it back needs a press-and-hold or a typed word.
- **Device-code and app-approval (OAuth consent) warnings** from `analyzeAuthFlow`, with the tab's navigation chain (`webNavigation`) used to find where the person came from. Banner at medium, full-page warning at high and above or when the page was reached from outside the browser. Requested permissions are listed in plain language.
- **Look-alike sign-in warning** from `analyzeUrl` when a page shows a password box (including boxes added later). Banner at once; typing into the password box is stopped and a full-page warning names the brand and its real address.
- **Trusted-platform notice** on publish-anything platforms that show paste or download instructions.
- **AI-chat paste guard** on a configurable list of 11 AI chat sites: pasted text is scanned with `scanSecrets`; medium and worse findings hold the paste and offer "paste with secrets hidden" (default), "paste everything" (hold) or cancel. Works with text areas, plain contenteditable and rich editors.
- **Risky-download warning** from `analyzeDownload`: high and critical downloads are paused and a small window asks (cancel by default, hold to continue; delete or keep when the file had already finished).
- **Popup**: status for the current site, per-protection switches, "Trust this site" with press-and-hold and an end date, recent warnings.
- **Options page**: switches with explanations, AI chat site list, trusted sites, language, export and import, "What is stored".
- **Languages**: English plus machine translations (flagged, awaiting native review) in Spanish, French, Portuguese, Arabic, Hindi, Urdu and Indonesian; right-to-left layout for Arabic and Urdu; engine findings localised with the engine's `localize`.
- **Builds** for Chrome/Edge (service worker) and Firefox 128+ (event page), zip files written by a small built-in ZIP writer, source maps kept out of the packages.
- **Tests**: 232 unit tests; a real-browser smoke test (39 checks, passing in Chrome 157 and Edge 158) that loads the extension into a headless browser with `Extensions.loadUnpacked` (or `--load-extension` where that still works); harmless test pages in `test/pages/`.
- Documentation: README, threat model, architecture, permissions, privacy policy, store listing draft, manual test guide.

### Security

- Warning UI in a closed shadow root, input through a single early listener that ignores synthetic events, guardian against removal and restyling, top-layer display for full-page warnings.
- Fail-safe behaviour: a check that cannot be completed gives "could not check", never "safe"; a write whose check channel is cut is refused.
- Recent warnings store only site name, protection, level, rule ids, action and time.

### Known limitations

- The Firefox build has not been run in a real Firefox yet.
- Clipboard hooks can be bypassed through fresh frames reached without the hooked getters (see THREAT_MODEL.md).
- Translations are unreviewed.
