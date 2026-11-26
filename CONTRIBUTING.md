# Contributing

Thank you for helping. This extension runs inside every page its users visit, so changes are reviewed with security and privacy first. Please read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [THREAT_MODEL.md](THREAT_MODEL.md) before a larger change, and the suite-wide rules in `../docs/CONVENTIONS.md`.

## Set up

Requirements: Node.js 22.18 or newer. No native tools are needed.

```bash
# the engine sits next to this folder
cd actionguard-engine && npm ci && npm run build
cd ../actionguard-browser && npm ci

npm run typecheck   # tsc --noEmit (strict)
npm test            # node --test on the TypeScript sources
npm run build       # dist/chrome, dist/firefox, zip files
npm run check       # all three; must pass before you open a pull request
npm run smoke       # optional: real-browser test in headless Chrome or Edge
npm run serve       # harmless test pages on http://localhost:8377/
```

TypeScript is run directly by Node (type stripping), so only erasable syntax is allowed: no `enum`, no `namespace`, no constructor parameter properties.

## Where things go

- **Decisions and anything else that can be a pure function** go in `src/shared/` with unit tests. If you find yourself writing an `if` about levels inside `src/content/` or `src/background/service-worker.ts`, it probably belongs in `shared/decisions.ts`.
- **`src/content/main-hooks.ts`** shares a JavaScript world with hostile pages. Rules for that file:
  - use only the private references taken at the top of `installHooks`; never call a method on a prototype or a global after start-up (`text.indexOf(...)` is wrong, `apply(indexOf, text, [...])` is right);
  - create helper objects with `create(null)`;
  - no `for...of`, spread or array destructuring on values a page can influence (they use iterators a page can replace);
  - convert a page-supplied value once and pass the converted value on;
  - no analysis and no UI. Keep it small (the build fails above 12 KB).
- **`src/content/ui.ts`** builds DOM with `createElement` and `textContent` only. All input goes through the single router; every action checks `isTrusted`.
- **Wording** goes in `src/locales/en.json` and is produced in `src/background/models.ts`. Write for a 12-year-old: what happened, why it is risky, what to do. No fear-mongering.

## Tests

- Every decision branch needs a test. Every bug fix needs a test that fails without the fix.
- **Attack-like test data must be safe to store.** Microsoft Defender and other antivirus tools quarantine files that contain realistic attack strings, and refuse to start a process with one on its command line. Write such samples with the `¦` marker inside sensitive words and pass them through `arm()` from `test/helpers.ts`; build invisible characters with `String.fromCodePoint`; never type a `\u` escape for a control character; never put a sample on a command line. Use only defanged domains (`example.com`, `*.example`, `*.test`).
- Fake secrets must be assembled at run time too (see `fakeToken()`), so secret scanners do not flag the repository.
- The fake window in `test/fake-window.ts` exists only to test the hooks and their channel. Do not grow it into a DOM library; UI behaviour belongs in `npm run smoke` and `docs/MANUAL_TEST.md`.
- If you change anything in `src/content/`, run `npm run smoke` and say so in the pull request.

## Adding or changing things

**A language.** Add `src/locales/<code>.json` with every key of `en.json` and the same `{placeholders}`, start it with `"_note": "machine translation, needs native review"` unless a native speaker wrote or reviewed it, set `ui_lang` and `ui_dir`, and add the code to `UI_LOCALES` and `LOCALE_FOLDERS` in `src/shared/i18n.ts` (and `RTL_LOCALES` if it is written right to left). The engine must support the language as well. `npm test` checks keys, placeholders, the store length limits and that no message contains markup.

**A reviewed translation.** Remove the `_note` line from that file in the same pull request that carries the native speaker's review, and say who reviewed it.

**An AI chat site.** Add it to `DEFAULT_AI_SITES` in `src/shared/settings.ts` (host, optionally with a path) and update the test that lists them.

**A detection rule.** Rules live in actionguard-engine, not here. If a new engine rule needs a signal only the browser has, describe it in an issue first.

**A permission.** Avoid it. If there is truly no other way, update `scripts/manifest.ts`, `docs/PERMISSIONS.md`, the README table and the manifest test in the same pull request, and explain what the browser will tell users at install or update time.

**A network request.** Not accepted, except for an opt-in feature discussed in an issue first; it must be off by default and listed under "Network use" in the README.

## Pull requests

- Keep them small and focused. Describe what the person using the browser will notice.
- `npm run check` must pass. CI runs it on Linux and Windows with Node 22 and 24.
- Dependencies: none are added without discussion. Runtime dependencies must be pure JavaScript, permissively licensed, maintained, pinned to an exact version and justified in the README.
- By contributing you agree that your work is licensed under Apache-2.0.
- Be kind. See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## Reporting false alarms

False alarms matter as much as misses. Open an issue with the site (if public), which warning appeared, and the rule names shown in the popup's recent warnings. Do not paste secrets or working attack commands.
