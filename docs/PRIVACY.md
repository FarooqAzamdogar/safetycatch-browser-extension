# Privacy policy

*ActionGuard browser extension. Draft for store submission. Last updated 26 November 2026.*

## The short version

ActionGuard does not collect, send, sell or share any data. Everything it does happens inside your browser, on your device. There are no accounts, no analytics, no advertising and no servers.

## What the extension looks at

To warn you, the extension has to look at a few things at the moment they matter:

- **Text a web page puts on your clipboard**, to see whether it is a dangerous command.
- **Text you paste into an AI chat site**, to see whether it contains passwords, keys, card or ID numbers.
- **The address and visible text of a page** that shows a password box, a device-code sign-in, an app-approval request, or instructions on a publish-anything platform.
- **How a tab reached a sign-in page** (the last few addresses of that tab).
- **The name and source address of a download.**

All of this is checked in memory by code that ships inside the extension, and then forgotten. None of it is sent anywhere. None of it is written to disk.

## What is stored on your device

| What | Where | How long |
|---|---|---|
| Your settings: which protections are on, your list of AI chat sites, sites you chose to trust (with their end dates), your language | Browser extension storage on your device | Until you change them or remove the extension |
| Recent warnings, at most 50: the site name, which protection fired, the names of the rules, the risk level, what happened (blocked, warned, restored...) and the time | Browser extension storage on your device | Until you clear the list or remove the extension. Older entries drop off after 50 |
| The last few addresses visited in each open tab, "I chose to continue" marks, and downloads waiting for your decision | Browser memory only | Erased when the tab or the browser closes |

## What is never stored

Page content, copied or pasted text, passwords, the secrets found in a paste, file names or file contents, full page addresses, your browsing history, anything that identifies you.

## What is sent to us or to anyone else

Nothing. The extension contains no code that makes network requests, and its security policy forbids connections to any server. We have no way of knowing that you installed it, which sites you visit, or which warnings you saw.

## Your choices

- Switch any protection off, or all of them, in the popup or the options page.
- Trust a site for a limited time, or remove that trust, in the popup or the options page.
- Clear the list of recent warnings in the popup.
- Export your settings to a file, or import them, on the options page. The export contains settings only.
- Remove the extension: the browser deletes everything it stored.

## Permissions

Why each browser permission is needed is explained in [PERMISSIONS.md](PERMISSIONS.md). In particular, the extension cannot read your clipboard; it can only replace it.

## Children

The extension is suitable for all ages and collects no data from anyone.

## Changes

If a future version ever offers an optional feature that uses the network (for example downloading an updated list of known scam sites), it will be off by default, switched on only by you, described here first, and listed under "Network use" in the README.

## Contact

Questions and reports: the project's issue tracker. Security problems: see [SECURITY.md](../SECURITY.md). **[CONTACT EMAIL TO BE ADDED before store submission]**

## Store data-use declarations (for the submission forms)

- Chrome Web Store: collects none of the listed data types. Not sold or transferred to third parties; not used for purposes unrelated to the single purpose; not used for creditworthiness or lending.
- Firefox Add-ons: `data_collection_permissions: { "required": ["none"] }` is declared in the manifest.
- Microsoft Edge Add-ons: no personal data collected.
