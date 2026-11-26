# safetycatch-browser-extension

A browser extension (Chrome and Edge first, Firefox build included) that guards **the risky action an attack needs you to take**: pasting a command, entering a device code, approving an app, typing a password on a look-alike page, pasting secrets into an AI chat, or opening a disguised download.

Blocklists miss new scam sites because attackers change addresses every few hours. The step they need from you does not change. SafetyCatch watches for that step, on your device, and explains in plain language what happened, why it is risky and what to do next.

- **Who it is for:** anyone who uses a browser, including people who are not technical.
- **Status:** 0.1.0, not yet published to any store. Tested in real Chrome 157 and Edge 158 (39 automated checks each); the Firefox build is produced and reviewed but has not yet been run in a real Firefox (see [Limitations](#limitations)).
- Part of the SafetyCatch suite; detection comes from the shared [safetycatch-engine](../safetycatch-engine/).

> "SafetyCatch" is a working name.

## What it protects

| Protection | The attack | What you see | What the extension does |
|---|---|---|---|
| **Paste guard** (ClickFix / FileFix) | A fake "verify you are human" or fake error page secretly copies a command and tells you to paste it into the Run box, PowerShell or Terminal | A full-page warning that shows the command safely as text | Replaces the clipboard with a harmless note **before** you can paste. Putting the command back needs a press-and-hold |
| **Device-code warning** | Someone sends you a code and a link to a real Microsoft, Google, GitHub, AWS, Okta or Auth0 "enter code" page; entering it signs *them* in | A banner on the page; a full-page warning if you arrived from an email, a chat or another site | Explains that codes are only for a sign-in you started yourself. Continuing needs a press-and-hold |
| **App-approval (OAuth consent) warning** | A real sign-in page asks you to give an unknown app access to your mail or files | A warning that lists what the app asks for in plain words ("Send email as you") | Explains that the access survives a password change. Continuing needs a press-and-hold |
| **Look-alike sign-in warning** | A page that imitates a known brand asks for your password on the wrong address | A banner at once, and a full-page warning the moment you click into the password box | Stops typing into the password box until you decide. Names the brand and its real address |
| **Trusted-platform notice** | Paste or download instructions on a shared AI chat, site builder or other service where anyone can publish | A calm notice that the page was written by an unknown person, not by the platform | Nothing is blocked |
| **AI-chat paste guard** | You paste text that contains a password, API key, card or ID number into an AI chat | A dialog listing what was found (masked) | Holds the paste. Default: paste with the secrets replaced by `[REDACTED:type]`. Pasting everything needs a press-and-hold |
| **Risky-download warning** | `Invoice.pdf.js`, `photo.jpg.scr`, a well-known program from the wrong site, an ad-click installer | A small window asking what to do | Pauses the download. Default: cancel. Continuing needs a press-and-hold |

Every warning has a safe default, and every "go ahead anyway" needs deliberate friction: press and hold for a second and a half, or type a word. One reflexive click never dismisses a serious warning.

## Install (unpacked, for testing)

You need [Node.js](https://nodejs.org/) 22.18 or newer to build. The engine sits next to this folder.

```bash
cd safetycatch-engine && pnpm install --frozen-lockfile && pnpm run build
cd ../safetycatch-browser-extension && pnpm install --frozen-lockfile && pnpm run build
```

This creates `dist/chrome/`, `dist/firefox/` and two zip files.

**Chrome**

1. Open `chrome://extensions`.
2. Switch on **Developer mode** (top right).
3. Click **Load unpacked** and choose the folder `safetycatch-browser-extension/dist/chrome`.
4. Pin "SafetyCatch" from the puzzle-piece menu so the shield icon is visible.

**Edge**

1. Open `edge://extensions`.
2. Switch on **Developer mode** (left side).
3. Click **Load unpacked** and choose `safetycatch-browser-extension/dist/chrome` (the same build).

**Firefox** (128 or newer; temporary install, removed when Firefox closes)

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on...** and choose `safetycatch-browser-extension/dist/firefox/manifest.json`.
3. Open `about:addons`, select SafetyCatch, open the **Permissions** tab and allow "Access your data for all websites". Firefox treats site access as optional; without it the extension can do nothing.

To try it safely, run `pnpm run serve` and open <http://localhost:8377/>. These are harmless local pages that imitate each attack; [docs/MANUAL_TEST.md](docs/MANUAL_TEST.md) walks through them.

## Using it

- **The shield icon** opens the popup: whether protection is on for the current site, a switch for each protection, "Trust this site" and your recent warnings.
- **Trust this site** switches every warning off for one site. It needs a press-and-hold and has an end date (1 hour, 1 day, 30 days, or until you remove it). Use it for sites you know well, such as documentation you copy commands from every day.
- **Settings** (options page): the protection switches with explanations, the list of AI chat sites, trusted sites, language, export and import of settings, and a plain list of what is stored.

Languages: English, Spanish, French, Portuguese, Arabic, Hindi, Urdu and Indonesian. All except English are **machine translations that still need review by native speakers**; the options page says so. Arabic and Urdu warnings are laid out right to left.

## Privacy

- **No data leaves your browser.** No telemetry, no analytics, no accounts, no remote code, no update checks of our own. Detection rules ship inside the extension.
- **Stored on your device:** your settings, and a list of the last 50 warnings holding only the site name, which protection fired, rule names, the risk level, what happened and the time.
- **Never stored:** page content, copied or pasted text, passwords, file names or contents, full addresses, browsing history.
- **In memory only** (erased when the tab or browser closes): the last few addresses of each tab, used to tell how you reached a sign-in page; and details of a download while it waits for your decision.

The store-ready policy is in [docs/PRIVACY.md](docs/PRIVACY.md).

## Network use

**None.** The extension makes no network requests. The only `fetch` calls in the code read the extension's own packaged language files. A strict content security policy (`default-src 'none'; script-src 'self'; connect-src 'self'; ...`) forbids anything else on the extension's pages.

## Permissions

| Permission | Why it is needed |
|---|---|
| `storage` | Save your settings and the short list of recent warnings on your device |
| `webNavigation` | See how a tab reached a sign-in page (typed, link from another site, link from outside the browser) so device-code and app-approval warnings can be stronger when the arrival is suspicious |
| `downloads` | See new downloads, pause a risky one and carry out your choice (continue, cancel, delete) |
| `clipboardWrite` | Replace a dangerous copied command with a harmless note. The extension cannot **read** your clipboard |
| Site access to `http://*/*` and `https://*/*` | The protections work inside pages: the clipboard hooks, the password-box check and the warnings must run on whatever site an attack uses, which cannot be known in advance |

Not requested: `tabs`, `scripting`, `notifications`, `clipboardRead`, `history`, `cookies`, `webRequest`, `activeTab`, native messaging. Details and browser warning texts: [docs/PERMISSIONS.md](docs/PERMISSIONS.md).

## How it works

```
 every page, every frame                        once per browser
┌──────────────────────────────┐  messages   ┌─────────────────────────────┐
│ content-main.js  (5 KB)      │             │ background.js (service      │
│   page world: clipboard hooks│             │ worker, 475 KB)             │
│        │ private channel     │   only when │   safetycatch-engine        │
│ content.js       (37 KB)     │──a cheap───▶│   decisions, wording,       │
│   pre-filters, copy/paste/   │  pre-filter │   settings, navigation      │
│   password watchers, warning │   says so   │   chain, downloads          │
│   UI in a closed shadow root │◀────────────│                             │
└──────────────────────────────┘  verdict +  └─────────────────────────────┘
                                  warning text
```

- **The engine runs in the service worker, not in pages.** Pages get two small scripts. They watch for the few risky actions and run cheap local pre-filters; only a hit is sent to the service worker. On an ordinary page no message is sent at all. Inside the worker the slowest engine step (reading a page's instructions, which costs a second or more the first time after the worker wakes) is skipped whenever it could not change the outcome.
- **Measured cost.** On a local page with 1,500 paragraphs and 3 iframes (four frames in all), headless Chrome 157, median of 15 loads with and without the extension. Three runs on a busy 16 GB laptop gave **+7, +15 and +18 ms at `DOMContentLoaded`** (for example 26.1 ms without and 32.8 ms with) and **-3, +17 and +47 ms at `load`**. That is the two scripts starting in four frames, a few milliseconds per frame; the spread shows how much the figures move with other load on the machine. A cold service worker answered its first request in about 0.8 s. Reproduce with `pnpm run smoke -- --perf`.
- **Fail safe.** If the service worker is asleep it is woken by the message. If it cannot answer in time (still starting, crashed, extension being updated, machine out of memory), the content script shows a neutral "could not check" state, never "safe"; a copied text that looks like a download-and-run command is still neutralised using a small local check. (This path was seen working in the real-browser test when the test machine ran out of memory: the copy was cleared and the warning read "Not checked".)
- **Hostile pages.** Hooks are installed before any page script and use only private references taken at start-up; warnings live in a closed shadow root; synthetic clicks are ignored; the clipboard is neutralised before the warning is drawn, so a page that manages to hide the warning gains nothing. See [THREAT_MODEL.md](THREAT_MODEL.md).

More detail: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Development

```bash
pnpm run check      # typecheck + 232 unit tests + build of both browser targets
pnpm run smoke      # real-browser test: loads dist/chrome into headless Chrome or Edge
pnpm run serve      # serves the harmless test pages on http://localhost:8377/
```

- `pnpm run check` must pass before any change is merged.
- Unit tests run on TypeScript directly with Node's test runner. They cover the decision logic, pre-filters, message protocol, allowlist and expiry, storage caps, navigation chain, download decisions, scope explanations, catalogs, the zip writer, the manifest, and the service-worker logic with the real engine. The page-world clipboard hooks are tested on a hundred-line fake window (`test/fake-window.ts`); no DOM library is used.
- `pnpm run smoke` drives real, trusted mouse and keyboard events over the DevTools protocol and reads the warning UI through the protocol (page scripts cannot see it). It currently makes 39 checks (all passing in Chrome 157 and Edge 158 on Windows 11): paste guard through four copy techniques and on a plain-http page, benign copies, look-alike sign-in, AI-chat redaction in three kinds of editor, risky download, device-code arrival, platform notice, popup, options and stored data.

Build output: `dist/chrome/`, `dist/firefox/`, `dist/safetycatch-browser-extension-<version>-<browser>.zip` (no source maps inside) and `dist/sourcemaps/` (readable source maps, kept out of the store packages).

## Limitations

Be clear about what this does **not** do.

- **It only sees the browser.** It cannot see clipboard changes made by other apps, commands you type by hand, QR codes you scan with a phone, or anything said on a phone call.
- **A determined page can still talk you into it.** If a page shows a command as a picture, or dictates it for you to type, there is no clipboard write to catch. Social engineering that does not use the clipboard, a password box or a known sign-in address is not detected.
- **Clipboard hooks can be evaded by a page that tries hard.** The hooks close the common routes (clipboard API, `execCommand`, copy-event handlers, fresh iframes reached through `contentWindow`). Other routes to an untouched browser function exist (for example `window[0]` on a brand-new frame). The content script still sees the copy event, and page instructions are still analysed, but a miss is possible. See THREAT_MODEL.md.
- **Device-code and app-approval pages are recognised by address.** Only the providers the engine lists are covered (Microsoft, Google, GitHub, AWS, Okta, Auth0; consent also for Slack, Dropbox, Discord). A new provider or a changed address is not recognised until the engine is updated.
- **"Came from outside the browser" is an inference.** A sign-in page that is the first page of a new tab, reached by a link, with nothing that opened it, is treated as coming from another app. Command-line tools that open a device-code page (`gh auth login`, `az login`) therefore get the full-page question once; hold to continue.
- **Look-alike detection depends on the engine's brand list** (about 70 brands) and on the page showing a password box. Pages that ask only for an email address first, password managers that fill a box without key presses, and sign-in forms inside closed shadow roots or cross-site iframes are not intercepted.
- **AI-chat paste guard:** pattern-based (known key formats, card and ID numbers); it checks pasted **text**, not attached files or typed text; when a paste is held back it is re-inserted as plain text, so rich formatting of that paste is lost; redaction hides everything the engine found, including low-risk items such as email addresses.
- **Downloads:** a small file can finish before it can be paused; the prompt then offers to delete it. The page a download came from is taken to be the active tab. Chrome and Edge only show the prompt as a separate small window.
- **Extension pages and browser pages:** extensions cannot run on `chrome://` pages, the Chrome Web Store, `edge://` pages or `addons.mozilla.org`.
- **Firefox:** the build targets Firefox 128+ and follows the documented APIs, but it has not been run in Firefox yet. Firefox also asks the user to grant site access separately.
- **Warnings can be wrong.** Heuristics produce false alarms, especially for developers copying commands. Use "Trust this site" for sites you rely on, and please report false alarms.
- **Translations** other than English are machine-made and unreviewed.

## Dependencies

| Package | Version | License | Why |
|---|---|---|---|
| [safetycatch-engine](../safetycatch-engine/) | 0.1.0 (`file:../safetycatch-engine`) | Apache-2.0, rules CC-BY-4.0 | All detection. Bundled into `background.js` only. Brings `tldts` 7.6.0 (MIT) with Public Suffix List data (MPL-2.0) |

No other runtime dependency. Development only: `typescript` 7.0.2, `esbuild` 0.28.2, `@types/node` 24.19.4. The zip writer, icon generator, DevTools-protocol client, WebExtension type declarations and test shim are written in this repository to avoid further packages. `pnpm audit --prod`: 0 vulnerabilities (2026-11-26).

## License

Apache-2.0 (see [LICENSE](LICENSE)); third-party notices in [NOTICE](NOTICE). Copyright 2026 The SafetyCatch Authors.

See also: [THREAT_MODEL.md](THREAT_MODEL.md), [ROADMAP.md](ROADMAP.md), [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), [CHANGELOG.md](CHANGELOG.md), [docs/](docs/).
