# Security policy

## Reporting a vulnerability

Please report security problems **privately** through GitHub's private vulnerability reporting: open the repository's **Security** tab and choose **Report a vulnerability**. Do not open a public issue for security problems.

Especially useful reports for this extension:

- a web page that can **dismiss, alter or forge input to** an ActionGuard warning without a real key press or click by the person;
- a web page that can make the extension **restore a neutralised clipboard**, trust a site, switch a protection off or resume a paused download;
- a web page, or another extension, that can **read** anything from the extension: settings, recent warnings, the private channel token, text held for a warning;
- anything that makes the extension **send data off the device** or store page content, clipboard text or passwords;
- a way to get the page-world hooks or the content script to **run page-supplied code** with extension privileges;
- input (page text, a clipboard string, an imported settings file, a download name) that makes the extension hang, crash, or use excessive CPU or memory;
- a clipboard-hook or warning **bypass** for a technique that THREAT_MODEL.md says is covered.

Bypasses that THREAT_MODEL.md already lists as residual risk (for example reaching a fresh frame through `window[0]`), and detection gaps in the rules, are welcome as normal issues. Rule gaps belong in the actionguard-engine repository.

Please make samples safe to handle: use `example.com`, `.test` or `.invalid` domains, and split attack strings (for example with a marker character inside key words) so that they do not trigger antivirus software or run by accident.

We aim to acknowledge reports within 5 working days and to agree a disclosure date with you.

## Supported versions

| Version | Supported |
|---|---|
| 0.1.x | yes |
| < 0.1 | no |

Only the latest 0.x release receives fixes until 1.0.

## How releases are built

Releases are built from this repository and the sibling `actionguard-engine` with `pnpm install --frozen-lockfile && pnpm run build`. The build is reproducible apart from the bundler version: the zip writer uses fixed timestamps and sorted entries. Store packages contain no source maps and no remote code. All GitHub Actions are pinned to full commit hashes.
