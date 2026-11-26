# Store listing (draft)

Draft text for the Chrome Web Store, Microsoft Edge Add-ons and Firefox Add-ons (AMO). Nothing has been submitted. "ActionGuard" is a working name: confirm it (trademark search) before submitting, and replace every placeholder in square brackets.

## Name (up to 75 characters)

ActionGuard: paste, sign-in and download guard

## Short description (up to 132 characters; this is `extDescription` in the catalogs)

Warns before the risky step: pasting a hidden command, entering a device code, approving an app or signing in on a fake page.

## Category

Chrome: Privacy and Security. Edge: Productivity (Security). Firefox: Privacy & Security.

## Single purpose (Chrome Web Store)

Warn the user at the moment of a risky action on a web page: pasting a copied command, entering a device sign-in code, approving an app's access, typing a password on a look-alike page, pasting secrets into an AI chat, or opening a risky download.

## Detailed description

Scammers change web addresses every few hours, so lists of "bad sites" are always behind. What does not change is the step they need from you. ActionGuard watches for that step and explains, in plain words, what is happening.

WHAT IT DOES

- Fake "verify you are human" pages. Some pages secretly copy a command and tell you to paste it into the Run box, PowerShell or Terminal. ActionGuard replaces the copied command with a harmless note before you can paste, and shows you what the page tried to copy.
- "Enter this code" sign-in pages. Scammers send people a code and a link to a real Microsoft, Google or GitHub sign-in page; entering the code signs the scammer in. ActionGuard explains this on the page, and asks you to stop and think if you arrived from an email, a chat or another site.
- "This app wants access" pages. ActionGuard lists what an app is asking for in plain language (for example "Send email as you") before you approve it.
- Look-alike sign-in pages. When a page that imitates a well-known brand asks for your password, ActionGuard stops the typing and shows you the brand's real address.
- Pages anyone can publish. On shared AI chats, site builders and similar services, ActionGuard reminds you that paste or download instructions were written by an unknown person, not by the company in the address bar.
- Secrets in AI chats. If text you paste into an AI chat contains a password, key, card or ID number, ActionGuard offers to paste it with the secrets hidden.
- Disguised downloads. Files such as "Invoice.pdf.js" are paused, and you are asked first.

HOW IT TREATS YOU

- Every warning says what happened, why it is risky and what to do next.
- The safe choice is always the default. Going ahead anyway takes a deliberate press-and-hold, never one quick click.
- You can switch off any protection, and trust a site you know well for a limited time.

PRIVACY

- Everything runs on your device. Nothing is sent anywhere: no accounts, no analytics, no tracking.
- ActionGuard cannot read your clipboard. It can only replace a dangerous command that a page tried to copy.
- It keeps your settings and a short list of recent warnings (site name, kind of warning, time) on your device. It never stores page content, copied text or passwords.

HONEST LIMITS

- ActionGuard only sees your browser. It cannot protect you from phone calls, QR codes scanned with a phone, or commands you type by hand.
- It will sometimes warn about something harmless, and it will not catch everything. It is one layer of protection, not a guarantee.
- Translations other than English were made by a machine and are still being reviewed.

A real ActionGuard warning never asks you to paste, type or approve anything. If a web page says "ActionGuard needs you to press Allow", it is not us.

Open source (Apache-2.0): [REPOSITORY URL]

## Permission justifications (submission form)

| Permission | Justification |
|---|---|
| storage | Saves the user's settings and a list of the last 50 warnings locally. No data is synced or transmitted |
| webNavigation | Determines how a tab reached a device-code or app-approval sign-in page (typed, link from another site, external link) to decide how strong the warning should be. At most 6 addresses per tab are kept in memory only |
| downloads | Detects new downloads, pauses risky ones (for example double extensions such as .pdf.js) and resumes, cancels or deletes according to the user's choice |
| clipboardWrite | Replaces a dangerous command that a web page placed on the clipboard with a harmless note, and restores it only at the user's explicit request. The extension does not request clipboardRead |
| Host permissions (http, https) | Content scripts must run on any page because attack pages can be on any address: they hook clipboard writes made by the page, watch for password fields and draw the warnings. Page data is processed locally and never transmitted |
| Remote code | None. All code is packaged; the CSP is `script-src 'self'` |

## Data-use disclosures

No user data is collected or transmitted. See [PRIVACY.md](PRIVACY.md) (publish it at a public URL for the "privacy policy" field: [PRIVACY POLICY URL]).

## Assets still to produce

- Screenshots, 1280 x 800: paste warning; device-code warning; look-alike sign-in warning; AI-chat secrets dialog; popup; options page. Use the pages in `test/pages/` (run `npm run serve`), which contain no real brands' designs and no personal data.
- Small promotional tile 440 x 280 (Chrome), store logo 300 x 300 (Edge). The icon is drawn by `scripts/icons.ts`.
- Support address and homepage: [SUPPORT URL], [HOMEPAGE URL].

## Before submitting

1. Replace the Firefox add-on id in `scripts/manifest.ts` (`FIREFOX_ID`) with the real one.
2. Have native speakers review the translations, or submit English only at first.
3. Run `npm run check` and `npm run smoke`, and walk through `docs/MANUAL_TEST.md` in each target browser, including a real Firefox.
4. Upload `dist/actionguard-browser-<version>-chrome.zip` (Chrome, Edge) and `...-firefox.zip` (AMO). AMO also asks for the source: the repository at the release tag plus the sibling `actionguard-engine` at its tag, with the build steps from the README.
5. Brand names in listings: describe what is detected ("look-alike sign-in pages of well-known brands") rather than naming brands in the title or screenshots.
