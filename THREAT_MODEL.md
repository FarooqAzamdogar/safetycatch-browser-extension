# Threat model

This document describes what safetycatch-browser-extension protects, who attacks it, where the trust boundaries are, and which risks remain. It covers the extension itself; the detection rules are covered by the engine's own threat model.

## What we protect

| Asset | Why it matters |
|---|---|
| The person's computer | A pasted ClickFix command or an opened disguised download hands it to an attacker |
| The person's accounts | A device code entered for someone else, an approved rogue app, or a password typed on a look-alike page gives the account away |
| Secrets in the person's hands | Keys, passwords, card and ID numbers pasted into an AI chat leave their control |
| The person's trust in warnings | A warning that can be faked, hidden or made to cry wolf stops being useful |
| The person's privacy | The extension sees page text, copied text and addresses in order to check them. None of it may leave the device or be stored |

## Who attacks

1. **The page author** (main adversary). Controls every script, style and pixel of a page the person visits, including pages inside iframes. Wants the person to paste a command, enter a code, type a password or open a file, and wants our warning not to appear, to be dismissed, or to be ignored.
2. **A page that knows about the extension.** Same as above, but it detects SafetyCatch and adapts.
3. **A hostile file or data input.** Imported settings files, values in storage, messages between parts of the extension.
4. **Another extension or local malware.** Out of scope (see below).

## Trust boundaries

```
 web page (hostile)
   | page's own JavaScript world: content-main.js lives here, among hostile code
   |-------------------------------------------------- boundary 1: private event channel
   | isolated world: content.js (trusted code, hostile DOM around it)
   |-------------------------------------------------- boundary 2: extension messages
   | service worker: engine, settings, storage (trusted)
   |-------------------------------------------------- boundary 3: extension pages only
   | popup / options / download prompt (trusted, change settings)
```

- **Boundary 1.** The page-world script trusts nothing it reads after start-up. It keeps private references to every browser function it uses, builds helper objects without prototypes, converts page-supplied values exactly once, and does no analysis. The content script treats messages on the channel as claims about clipboard text, which can only add suspicion, never remove it.
- **Boundary 2.** The service worker validates and caps every message (`shared/protocol.ts`). The site a message is about is taken from the browser-supplied sender, never from the message. Content scripts can only request checks and report outcomes.
- **Boundary 3.** Changing settings, trusting a site, clearing history and deciding about a download are accepted only when the browser says the sender is one of the extension's own pages. No extension page is web-accessible, so a web page cannot frame or open them with parameters of its choosing.

## How the page author is handled

### Getting around the clipboard hooks ("hook bypass")

The hooks wrap `Clipboard.prototype.writeText` and `write`, `Document.prototype.execCommand` (copy and cut) and `DataTransfer.prototype.setData`, in every frame, at `document_start`, including `about:blank`, `srcdoc`, `blob:` and `data:` frames (`match_about_blank`, `match_origin_as_fallback`).

| Attempt | What happens |
|---|---|
| Replace our hook with the page's own function | Harmless: the page never had the real browser function, so its replacement cannot write to the clipboard except through us |
| Tamper with built-ins (`Promise.prototype.then`, `String.prototype.indexOf`, array iterators, getters on `Object.prototype`) to confuse the hook | The hook uses only references taken before any page script ran. Covered by a unit test |
| Pass an object whose `toString()` returns something else the second time, or a list of clipboard items that changes between reads | Values are converted once; the browser receives exactly what was checked. Covered by unit tests |
| Take an untouched function from a **fresh iframe** (`iframe.contentWindow.navigator.clipboard.writeText.call(...)`) | The hook wraps the `contentWindow` and `contentDocument` getters of iframe, frame, object and embed elements and hooks the new frame's world the moment the page asks for it. Covered by the real-browser test |
| Put a pristine function back onto the prototype | On each trusted click or key press the content script asks the hook to verify itself; a native function in place of the hook is replaced by the hook again and the page is marked as tampering, which triggers a check of the page's visible instructions and makes later decisions stricter |
| Reach a fresh frame without those getters: `window[0]`, `window.frames[0]`, `window.open('about:blank')`, or racing the browser's injection into a new same-origin frame | **Not fully closed.** Indexed access on a window cannot be intercepted. Mitigations: the browser injects our scripts into such frames too (usually before the page can use them); every `copy` and `cut` event is seen by the content script independently of the hooks, which catches `execCommand` and copy-handler routes even when a hook was bypassed; and page text with paste-and-run instructions is analysed whenever any copy is checked. A page that uses only the asynchronous clipboard API through such a frame, with no visible instructions that the engine recognises, would not be caught |
| Call `document.open()` to erase our event listeners, then copy | The hook notices that its message was not received, re-attaches and retries; the content script re-attaches when it sees the document being replaced. If the channel stays cut for about 6 seconds the write is refused. Covered by unit tests |
| Flood the service worker so checks time out | The content script rate-limits checks (30 a minute per frame). On a timeout, text that looks like a fetch-or-hide command is still blocked by a local check; other text gets a "could not check" notice |
| Split the attack so no clipboard write happens (show the command as an image, dictate it, ask the person to type it) | Not detected. See "Out of scope" |

### Forging or listening to the channel

The channel's event names contain a 128-bit random token passed in a handshake that completes synchronously at `document_start`, before any page script exists in a normal document. After that neither side answers handshake events.

Residual risk: in a frame the page creates and scripts *before* the browser has injected our scripts, the page can register for the handshake first and learn the token for that frame. It could then forge "approve" answers for writes in that frame, or forge reports. This gives it nothing it did not already have, because in such a frame it could take the untouched clipboard functions directly; forged reports can at worst cause a warning about text the page itself supplied. If our page-world script is missing altogether, a page can complete the handshake in its place and send false reports; again this can only cause extra warnings.

### Hiding, covering or dismissing the warning ("UI redress")

| Attempt | What happens |
|---|---|
| Read or change the warning's content | It is in a **closed shadow root** created in the isolated world. Page scripts cannot reach inside. It is built with `createElement` and `textContent` only; page text is never parsed as markup |
| Click our buttons from script | One listener on `window`, registered before any page listener, handles all input for the warning. Events that are not **trusted** (not produced by a real key press or pointer action) are ignored. Covered by the real-browser test |
| Stop our buttons from working by cancelling events first | The same listener runs before every page listener and takes events aimed at the warning away from the page (`stopImmediatePropagation`), then finds the control itself inside the shadow root |
| Remove the warning, hide it with CSS, move it inside a hidden element | Inline styles are marked `!important`, which page style sheets cannot beat. A guardian (observer plus a 0.4 s timer) re-attaches the host directly under the root element and rewrites its style attribute if anything changed. Covered by the real-browser test |
| Cover it with a higher `z-index` | Full-page warnings are shown in the browser's top layer (popover), above all `z-index` values |
| Cover it with *another* top-layer element (a page popover, dialog or fullscreen element opened later) | The guardian puts the warning back on top within 0.4 s, but a page can keep fighting. A page that controls its own pixels can always win this race for moments at a time. **This is why the protective step never depends on the warning:** the clipboard has been neutralised, the paste held, the typing stopped or the download paused *before* the warning is drawn. Hiding the warning hides an explanation, not the protection |
| Clickjacking: draw something over the "hold to put the command back" button so the person holds it without knowing | Undoing a protection needs a press-and-hold of 1.5 s (or typing a word), never a single click. In Chromium the button also uses a visibility-tracking IntersectionObserver: if other content is painted over it, or it has been made transparent or transformed, the hold is refused and a message says the warning is covered. Firefox lacks that API, so there only the hold (or typed word) stands in the way |
| Draw a fake SafetyCatch warning that says "this page is safe" or tells the person to "press Allow" | Cannot be prevented: a page can draw anything. Real SafetyCatch warnings never tell the person to paste, type or approve anything, never appear inside the page's layout, and ask for a hold or a typed word only to undo a protection. The README and store listing say so |
| Train the person to dismiss warnings by provoking false alarms | Notices are rate-limited (one of a kind per 30 s), identical writes within 5 s reuse one verdict, and at most one full-page warning is shown at a time |

### Fingerprinting and evading the extension

A page can tell that SafetyCatch is installed: the hooked functions are not native (`toString()` shows it), a warning host element appears in the DOM when a warning is shown, and timing differs slightly. We do not try to hide: hiding is a losing game and risks breaking pages.

What a page can do with that knowledge:

- **Show the lure only to visitors without the extension.** That is a good outcome for the person in front of the screen.
- **Switch to a technique we do not cover** (see "Out of scope").
- **Refuse to work** ("disable your security extension to continue"). This is social engineering; the warning texts tell people that real sites never ask for such things.

We do not treat fingerprinting as a vulnerability unless it exposes extension internals (settings, history, the channel token) or lets a page change the extension's behaviour. No extension resource is web-accessible, and no extension identifier is written into pages.

### Abusing the escape hatches

- "Trust this site" can only be set from the popup or options page, needs a press-and-hold in the popup, has an end date by default (1 day), and is listed in the options page. Wildcards over public suffixes (`*.co.uk`) and over publish-anything platforms (`*.github.io`) are refused using the engine's Public Suffix List and platform list.
- "I started this myself" on a device-code page is remembered for that tab and address for 10 minutes, in memory only.
- A restored clipboard command is remembered for that document only.

## Hostile data

- **Imported settings** are parsed as JSON, size-capped and passed through the same sanitiser as storage contents; unknown fields are dropped; protections can only be switched off by an explicit `false`.
- **Storage contents** (which a compromised profile could alter) are sanitised on every read. Damaged settings fall back to "everything on".
- **Engine output** shown to the person passes through the engine's own sanitising; the extension additionally makes hidden and bidi characters visible in the copied-text sample and caps every string in a warning model (`parseModel`).
- **Regular expressions** in the pre-filters have no nested unbounded repeats and run on capped input.

## Privacy threats

| Threat | Mitigation |
|---|---|
| The extension as a keylogger or history recorder | Copied text, page text and addresses are processed in memory and never written to disk. The recent-warnings list has a fixed shape (site, protection, level, rule ids, action, time) enforced by `makeEntry`, checked by unit tests and by the real-browser test |
| Data leaving the device | No network code exists; extension pages have `default-src 'none'; connect-src 'self'`. A unit test fails the build if `XMLHttpRequest`, `WebSocket`, `sendBeacon`, remote `fetch` or remote scripts appear in the source |
| Navigation chain as a history log | Kept only in `storage.session` (memory), at most 6 addresses per tab, cut to 600 characters, dropped when the tab closes or after 30 minutes without activity |
| Leaking secrets through the AI-paste dialog | Only the engine's masked evidence is shown (`ghp_... (40 characters)`); a unit test checks the secret is absent from the model and from storage |

## Out of scope

- **Attacks that do not touch the browser**: phone calls, QR codes scanned with a phone, commands typed by hand from a picture, other applications writing to the clipboard.
- **A compromised browser, operating system or profile**, other malicious extensions, or malware already running on the device.
- **Network attackers.** The extension makes no connections.
- **Correctness of the verdicts.** False negatives and false positives of the rules belong to safetycatch-engine. The extension's job is to deliver the right text to the engine and act on the verdict faithfully.
- **Password managers and autofill** entering a password on a look-alike page without key presses.

## Assumptions worth re-checking

1. Content scripts declared `document_start` run before page scripts in ordinary documents (true in Chromium and Firefox).
2. Inline `!important` declarations beat author style sheets and animations (CSS cascade).
3. `isTrusted` cannot be forged by page script (DOM standard).
4. A closed shadow root created in the isolated world is unreachable from the page world.
5. With the `clipboardWrite` permission a content script may write to the clipboard without a user gesture while its document is focused (Chromium, Firefox).

If any of these changes in a browser release, the corresponding protection must be reviewed.
