# Permissions

SafetyCatch asks for four permissions and for access to web pages. This page explains each one, what the browser tells the person at install time, and what the extension deliberately does **not** ask for. The list lives in `scripts/manifest.ts`; a unit test fails if it changes without this page in mind.

## Requested

### `storage`

- **Used for:** saving settings (which protections are on, the AI chat site list, trusted sites, language) and the list of the last 50 warnings in `storage.local`; and, in `storage.session` (memory only), the last few addresses of each tab, "I chose to continue" marks and downloads waiting for a decision.
- **Browser warning:** none.
- **Without it:** settings could not be kept, and the service worker could not remember anything across its normal sleep and wake cycle.

### `webNavigation`

- **Used for:** learning how a tab reached a sign-in page: typed address, link from another page (and which), redirect, or a link opened from outside the browser. Device-code phishing depends on *sending* the victim to a real sign-in page, so "how did you get here" is the strongest available signal.
- **Browser warning:** Chrome and Edge show "Read your browsing history" for this permission. That wording is broader than what the extension does: it keeps at most 6 addresses per tab, only in memory, drops them when the tab closes, and never stores or sends them.
- **Without it:** device-code and app-approval pages would always get the same calm banner, whether you typed the address yourself or were sent there by a phishing email.
- **Alternatives considered:** `document.referrer` alone (empty for links from mail and chat apps and after many redirects); the `tabs` permission (broader, and shows the same warning).

### `downloads`

- **Used for:** seeing that a download started and what it is called, pausing a risky one, and carrying out the person's choice (resume, cancel, delete the file).
- **Browser warning:** "Manage your downloads".
- **Without it:** the risky-download protection would not exist. The other protections do not depend on it.

### `clipboardWrite`

- **Used for:** replacing a dangerous copied command with a harmless note, and putting the command back if the person insists. Without the permission a content script may only write to the clipboard during a user gesture, and a ClickFix page writes the clipboard at a moment of its own choosing.
- **Browser warning:** Chrome shows "Modify data you copy and paste".
- **Not included:** reading the clipboard. The extension does **not** request `clipboardRead` and cannot see what other applications or other pages copied. It learns what a page copies only because the page hands that text to the browser inside the page itself.

### Site access: `http://*/*` and `https://*/*`

- **Used for:** running the two content scripts on web pages. The protections act inside pages (clipboard hooks, the password-box watcher, the warnings), and an attack page can be on any address, so a fixed list of sites would defeat the purpose.
- **Browser warning:** "Read and change all your data on all websites".
- **Limits we set ourselves:** only `http` and `https` (no `file://`, no `ftp://`); page text is read only when a check needs it (a suspicious copy, a password box, a platform page with instruction words) and is sent only to the extension's own service worker; nothing is stored or transmitted.
- **Firefox:** site access is optional in Manifest V3. The person must allow "Access your data for all websites" in about:addons, and can restrict it to chosen sites.
- **Chrome and Edge:** the person can restrict site access per extension ("On click", "On specific sites") from the extensions page. SafetyCatch then protects only where it is allowed to run.

## Not requested

| Permission | Why not |
|---|---|
| `tabs` | The popup reads the active tab's address through the site access above; closing or redirecting a tab works without it |
| `scripting` | Content scripts are declared statically in the manifest; nothing is injected at run time |
| `notifications` | The download question is asked in a small extension window instead, which also allows the press-and-hold control |
| `clipboardRead` | Not needed, and far too invasive |
| `activeTab`, `offscreen`, `history`, `cookies`, `webRequest`, `declarativeNetRequest`, `nativeMessaging`, `management`, `identity` | Not needed for any current feature |

No optional permissions, no `externally_connectable`, no `web_accessible_resources`: web pages and other extensions cannot message the extension or load its files.

## Content security policy

```
default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self';
base-uri 'none'; form-action 'none'; frame-ancestors 'none'
```

Extension pages can load only files shipped inside the extension. There is no remote code, no inline script, no `eval`, and no connection to any server (`connect-src 'self'` is needed only to read the packaged language files).
