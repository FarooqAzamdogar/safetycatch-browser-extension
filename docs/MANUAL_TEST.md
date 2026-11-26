# Manual test guide

Use this to check a build by hand, in each target browser, before a release. The automated real-browser test (`npm run smoke`) covers the same ground in headless Chrome or Edge; this guide is for a visible browser, for Firefox, and for the things automation cannot judge (wording, layout, right-to-left text, screen readers).

Everything here is harmless. The test pages are local files served from your own computer; the "command" they copy only prints a line of text; the "secret" is a made-up token; the downloads are one line of plain text.

## Set up

```bash
cd actionguard-engine && npm ci && npm run build
cd ../actionguard-browser && npm ci && npm run build
npm run serve          # leave this running; serves http://localhost:8377/
```

Load the extension as described in the README ("Install"): `dist/chrome` for Chrome and Edge, `dist/firefox/manifest.json` for Firefox (then grant site access in about:addons). Use a spare browser profile if you can.

Open <http://localhost:8377/>.

## 1. Paste guard

1. Open **Fake "verify you are human" page**. Click **I'm not a robot**.
   - Expected: a full-page ActionGuard warning titled "This page secretly copied a command". It names `localhost`, shows the copied text in a grey box, and says the clipboard was replaced by a harmless note.
2. Open a text editor and paste.
   - Expected: `ActionGuard removed a risky command that a web page copied...`, not a command.
3. Back on the page, press **Keep it removed**. The warning closes.
4. Click **I'm not a robot** again. Click the **Hold to put the command back** button briefly: nothing happens. Press and hold it until the bar fills (about a second and a half). Paste into the text editor.
   - Expected: now the harmless test command is pasted (it starts with the word for Windows' command shell and ends with a fake "Verification ID"). Do not run it; it would only print a line of text.
5. Repeat step 1 with each variant link on the index page: **execCommand**, **copy-event hijack**, **fresh iframe**. Each must end with the same warning and the harmless note on the clipboard.
6. Click **Copy a plain sentence**, then **Copy a link**. Paste each.
   - Expected: no warning, and exactly the sentence or link is pasted.
7. Try to defeat the warning: with a warning open, open the browser's developer console and run `document.documentElement.lastElementChild.remove()`.
   - Expected: the warning is back within half a second.

## 2. Look-alike sign-in

1. Open **Look-alike sign-in form**.
   - Expected: a banner at the top naming the imitated brand, this page's address (`localhost`) and the brand's real address.
2. Click in the password box.
   - Expected: a full-page warning. Typing does not reach the password box.
3. Press **Leave this page**: the tab goes to a blank page. Go back, click the password box again, and this time hold **Hold to stay and type anyway**.
   - Expected: the warning closes and you can type. Reloading the page within 10 minutes shows only the banner.

## 3. AI-chat paste guard

1. Open the extension's options page (popup, **Settings**). Under **AI chat sites** add a line `localhost` and press **Save**.
2. Open **AI-chat-like editor**. Click **Copy text with a fake key**.
3. Click into the first box and paste (Ctrl+V or Cmd+V).
   - Expected: a dialog "This text seems to contain secrets" that lists a GitHub token with only its first characters shown. The default button is **Paste with secrets hidden**.
4. Press **Paste with secrets hidden**.
   - Expected: the text appears with `[REDACTED:github-token]` in place of the token.
5. Repeat in the second box and in the text area. Try **Cancel** (nothing is pasted) and **Hold to paste everything** (the full text is pasted after a hold).
6. Click **Copy text without secrets**, paste.
   - Expected: no dialog; the text is pasted normally.
7. Remove `localhost` from the AI chat sites again when you are done.

## 4. Risky download

1. Open **Download with a disguised name**. Click **Download notes**.
   - Expected: an ordinary download, no question.
2. Click **Download invoice**.
   - Expected: a small ActionGuard window "This download looks risky" naming `Invoice_2026.pdf.js`. The toolbar icon shows a red "!".
3. Press **Cancel the download**.
   - Expected: the window confirms the cancellation; the download list shows it as cancelled (or the file is gone).
4. Repeat and hold **Hold to continue the download**: the download completes. Delete the file afterwards (it is one line of text).

## 5. Device-code and app-approval pages

These need the real sign-in addresses, which a local page cannot imitate. Visiting them is safe: do **not** enter any code.

1. Type `https://microsoft.com/devicelogin` into the address bar.
   - Expected: a calm banner "Only enter a code here if you started this yourself". The page stays usable.
2. Open **A page that links to a device-code page** on the test site and click **Open the sign-in page**.
   - Expected: this time a full-page warning that says "You came here from localhost". **Leave this page** sends the tab to a blank page; holding **Hold: I started this on my own device** lets you continue.
3. Paste `https://microsoft.com/devicelogin` into another application (a mail program, a chat app, a terminal) and click it there, so the browser opens it from outside.
   - Expected: the full-page warning, with the line about a link from outside the browser.
4. App approval: start "Sign in with Google" or "Sign in with Microsoft" on any site you use.
   - Expected: nothing for the everyday request (name, email, profile). A warning with a plain-language list appears only when an app asks for mail, files or similar access.

## 6. Notice on publish-anything platforms

The notice appears only on platform host names (shared AI chats, site builders, and so on), so it cannot be shown on `localhost`. Two ways to see it:

- Automated: `npm run smoke` maps a stand-in platform host name to the local server and checks the notice.
- By hand: start the browser with a host mapping, for example
  `chrome --user-data-dir=/tmp/ag-test --host-resolver-rules="MAP actionguard-test.weebly.com 127.0.0.1"`, load the extension, and open `http://actionguard-test.weebly.com:8377/help/fix-update`.
  - Expected: a blue banner "This page was written by an unknown person".

## 7. Popup and options

1. Click the shield icon on any ordinary site.
   - Expected: "Protection is on for <site>", six switches, "Trust this site", recent warnings from the steps above (site name, kind, level, time; never the copied text).
2. Hold **Hold to trust <site>** with "1 hour" selected. Repeat a test from section 1 on that site.
   - Expected: no warning while trusted. The popup says until when. **Stop trusting this site** restores protection.
3. Options page: switch a protection off and on; add `*.com` as a trusted site (refused); add `example.org` (accepted, listed with its end date, removable); export settings, change something, import the file (the change is undone).
4. Change the language to Arabic or Urdu and trigger a warning.
   - Expected: the warning reads right to left; the copied command inside the grey box still reads left to right; the options page shows the machine-translation note.
5. Open the popup on `chrome://extensions` (or `about:addons`).
   - Expected: "ActionGuard cannot run on this page".

## 8. Accessibility spot checks

- Keyboard only: with a full-page warning open, Tab cycles through its controls and never leaves it; the focus ring is visible; Escape picks the safe option on the paste warning and the secrets dialog; holding Space or Enter on a hold button works like holding the mouse.
- Screen reader: the warning is announced as an alert dialog with its title; the level is spoken as words ("High risk"), not only shown as a colour.
- Zoom to 200 %: the warning scrolls inside itself and the buttons stay reachable.
- Dark mode: text stays readable.

## 9. Fail-safe check

1. On the extensions page, click the "service worker" link for ActionGuard to open its DevTools, and in the console run `chrome.runtime.reload()`.
2. Without reloading the test tab, go back to the fake CAPTCHA page (opened before the reload) and click **I'm not a robot**.
   - Expected: the page behaves as if no extension were installed (the old page scripts step aside after an update). Reload the tab: protection is back.

## What to record

Browser and version, operating system, which sections passed, and for any failure the page, the step, what you expected and what happened. Never paste real secrets or real attack commands into an issue; describe them or split them up.
