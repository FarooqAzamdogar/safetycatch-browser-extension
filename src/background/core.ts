// Copyright 2026 The SafetyCatch Authors
// SPDX-License-Identifier: Apache-2.0

/**
 * The service worker's logic, kept free of `chrome.*` so it runs under
 * `node --test` with the real engine and a fake storage. service-worker.ts
 * only wires browser events to these functions.
 *
 * Fail-safe rule: every engine call is wrapped; an error or an "incomplete"
 * verdict becomes the level `unknown`, which the decision logic turns into a
 * neutral "could not check" state and never into "safe".
 */

import type { SecretsVerdict, Verdict } from 'safetycatch-engine';
import { addTrust, findTrust, normalizePattern, removeTrust, TRUST_DURATIONS, type TrustEntry } from '../shared/allowlist.ts';
import { asAuthFlow, decideAiPaste, decideAuth, decideDownload, decideLogin, decideLure, decidePaste } from '../shared/decisions.ts';
import { downloadName, opsForChoice, sanitizePending, type DownloadOp, type PendingDownload } from '../shared/downloads.ts';
import { addEntry, HISTORY_KEY, makeEntry, sanitizeHistory, type HistoryAction, type HistoryEntry } from '../shared/history.ts';
import { localeDir, localeFolder, makeTranslate, parseMessages, pickLocale, type Catalog, type Translate, type UiLocale } from '../shared/i18n.ts';
import { LEVELS, rank, type CheckedLevel, type RiskLevel } from '../shared/levels.ts';
import type { WarningModel } from '../shared/model.ts';
import type { ModuleId } from '../shared/modules.ts';
import * as nav from '../shared/navchain.ts';
import { isPlatformHint } from '../shared/platform-hints.ts';
import { hasDownloadStep, looksRunnable } from '../shared/prefilter.ts';
import type { AuthReply, ClipboardReply, ContentRequest, LoginReply, PageReply, PageRequest, SecretsReply, ShowPush } from '../shared/protocol.ts';
import { importSettings, sanitizeSettings, SETTINGS_KEY, type Settings } from '../shared/settings.ts';
import { hostOf, isHttpUrl, originPath } from '../shared/sites.ts';
import * as models from './models.ts';

/** The part of the engine the extension uses. */
export interface Engine {
  analyzeCommand(text: string): Verdict;
  analyzePageText(text: string, ctx?: { url?: string | undefined }): Verdict;
  analyzeUrl(url: string, ctx?: { pageTitle?: string | undefined; pageText?: string | undefined; hasPasswordField?: boolean | undefined; referrer?: string | undefined }): Verdict;
  analyzeAuthFlow(url: string, ctx?: { referrer?: string | undefined }): Verdict;
  scanSecrets(text: string): SecretsVerdict;
  analyzeDownload(fileName: string, ctx: { url: string; referrer?: string | undefined; pageUrl?: string | undefined }): Verdict;
  localize(verdict: Verdict, locale: string): Verdict;
  levelLabel(level: RiskLevel, locale: string): string;
  translate(key: string, locale: string, params?: Readonly<Record<string, string>>): string | undefined;
  registrableDomain(hostOrUrl: string): string | null;
  ENGINE_VERSION: string;
}

export interface KeyValue {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
}

export interface CoreDeps {
  engine: Engine;
  /** Persistent storage (settings, recent warnings). */
  local: KeyValue;
  /** Memory-only storage that survives service-worker sleep but not a browser restart. */
  session: KeyValue;
  now(): number;
  uiLanguage(): string;
  /** Load `_locales/<folder>/messages.json`. */
  loadMessages(folder: string): Promise<unknown>;
  /** Hand a warning to the top frame of a tab. Resolves to true when it was shown. */
  showInTop(tabId: number, push: ShowPush): Promise<boolean>;
  /** Navigate a tab away from the current page. */
  leaveTab(tabId: number): Promise<boolean>;
  /** Wait a little (used only while a navigation event may still be on its way). */
  sleep(ms: number): Promise<void>;
  /** Run a job soon, after the current event has been handled. */
  defer(job: () => void): void;
  version: string;
}

export interface Sender {
  tabId: number;
  frameId: number;
  /** Address of the tab's top-level page. */
  tabUrl: string;
}

export interface DownloadItemLike {
  id: number;
  url: string;
  finalUrl?: string | undefined;
  referrer?: string | undefined;
  filename?: string | undefined;
}

export interface StateReply {
  ok: true;
  version: string;
  engineVersion: string;
  settings: Settings;
  history: HistoryEntry[];
  locale: UiLocale;
  dir: 'ltr' | 'rtl';
  /** Every UI string in the chosen language (English where a translation is missing). */
  messages: Catalog;
  /** Translated names of the five risk levels. */
  levels: Record<RiskLevel, string>;
  site: { host: string; canRun: boolean; trust: TrustEntry | null };
}

const ACK_MS = 10 * 60 * 1000;
/** Ordinary prose, long enough for the JavaScript engine to compile the page rules fully on first use. */
const WARM_TEXT = 'This is an ordinary page with a few plain sentences that say nothing of interest at all. '.repeat(30);
/** A character outside Latin-1 (an em dash): strings that contain one are matched by separately compiled code. */
const WIDE_CHARACTER = String.fromCharCode(0x2014);
const NAV_KEY = 'nav';
const ACK_KEY = 'acks';
const DOWNLOADS_KEY = 'downloads';
/** Browser-owned sites where no extension may run content scripts. */
const RESTRICTED_HOSTS = ['chromewebstore.google.com', 'chrome.google.com', 'microsoftedge.microsoft.com', 'addons.mozilla.org'];

export function createCore(deps: CoreDeps) {
  const { engine } = deps;
  let settingsCache: Settings | null = null;
  const catalogs = new Map<string, Catalog>();
  /**
   * Read-modify-write steps on storage run one after another, so parallel events cannot overwrite
   * each other. Two separate queues: memory-backed session storage (navigation chain, "continue"
   * marks, pending downloads) must never wait behind a slow write to disk (recent warnings).
   */
  const makeQueue = (): { run<T>(job: () => Promise<T>): Promise<T>; idle(): Promise<void> } => {
    let tail: Promise<unknown> = Promise.resolve();
    return {
      run: (job) => {
        const next = tail.then(job, job);
        tail = next.catch(() => undefined);
        return next;
      },
      idle: () => tail.then(() => undefined),
    };
  };
  const disk = makeQueue();
  const memory = makeQueue();

  /**
   * The engine compiles its page rules the first time they are used, which can take a second or more.
   * When a tab opens a page on a publish-anything platform, the question "does this page carry
   * instructions?" is about to be asked, so do that one-off work ahead of it. Once per worker life.
   */
  let warmed = false;
  function warmPageRules(): void {
    if (warmed) return;
    warmed = true;
    safe(() => engine.analyzePageText(WARM_TEXT));
    safe(() => engine.analyzePageText(`${WARM_TEXT} ${WIDE_CHARACTER}`));
  }
  function warmIfPlatform(url: string): void {
    if (warmed) return;
    try {
      const u = new URL(url);
      if (isPlatformHint(u.hostname, u.pathname)) deps.defer(warmPageRules);
    } catch {
      // not a web address
    }
  }

  function safe<T>(fn: () => T): T | null {
    try {
      return fn();
    } catch {
      return null;
    }
  }

  /** `unknown` when the engine threw or reported that it could not finish. */
  function levelOf(v: Verdict | null): CheckedLevel {
    if (!v || v.meta?.['incomplete'] === true) return 'unknown';
    return v.level;
  }

  async function getSettings(): Promise<Settings> {
    if (!settingsCache) settingsCache = sanitizeSettings(await deps.local.get(SETTINGS_KEY).catch(() => undefined), deps.now());
    return settingsCache;
  }

  async function saveSettings(next: Settings): Promise<Settings> {
    settingsCache = next;
    await deps.local.set(SETTINGS_KEY, next);
    return next;
  }

  async function catalog(folder: string): Promise<Catalog> {
    const cached = catalogs.get(folder);
    if (cached) return cached;
    const loaded = parseMessages(await deps.loadMessages(folder).catch(() => null));
    if (Object.keys(loaded).length > 0) catalogs.set(folder, loaded);
    return loaded;
  }

  async function i18n(): Promise<{ t: Translate; locale: UiLocale; dir: 'ltr' | 'rtl'; english: Catalog; local: Catalog }> {
    const locale = pickLocale((await getSettings()).language, deps.uiLanguage());
    const english = await catalog('en');
    const local = locale === 'en' ? english : await catalog(localeFolder(locale));
    const dir = localeDir(locale);
    return { t: makeTranslate(local, english, dir), locale, dir, english, local };
  }

  async function context(): Promise<models.ModelContext & { locale: UiLocale }> {
    const i = await i18n();
    return {
      t: i.t,
      lang: i.locale,
      dir: i.dir,
      locale: i.locale,
      levelLabel: (level) => safe(() => engine.levelLabel(level, i.locale)) ?? level,
      scopeTitle: (category) => safe(() => engine.translate(`auth.scope.${category}.title`, i.locale)) ?? undefined,
    };
  }

  const localized = (v: Verdict, locale: string): Verdict => safe(() => engine.localize(v, locale)) ?? v;

  function isTrusted(settings: Settings, ...urls: Array<string | undefined>): boolean {
    return urls.some((u) => findTrust(hostOf(u), settings.allowlist, deps.now()) !== undefined);
  }

  /** Site name stored in "recent warnings": the registrable domain when there is one. */
  function siteName(url: string): string {
    const host = hostOf(url);
    if (!host) return '';
    return safe(() => engine.registrableDomain(host)) ?? host;
  }

  /**
   * Add an entry to "recent warnings". Callers do not wait for it: a slow disk must never delay a
   * warning. The write is queued, so entries keep their order.
   */
  function record(url: string, module: ModuleId, level: RiskLevel, ruleIds: readonly string[], action: HistoryAction): Promise<void> {
    const entry = makeEntry(siteName(url), module, level, ruleIds, action, deps.now());
    if (!entry) return Promise.resolve();
    return disk.run(async () => {
      const list = sanitizeHistory(await deps.local.get(HISTORY_KEY).catch(() => undefined));
      await deps.local.set(HISTORY_KEY, addEntry(list, entry));
    }).catch(() => undefined);
  }

  // ------------------------------------------------------------------ navigation chain

  async function loadNav(): Promise<nav.NavState> {
    return nav.sanitizeNavState(await deps.session.get(NAV_KEY).catch(() => undefined));
  }

  function updateNav(change: (state: nav.NavState) => nav.NavState): Promise<void> {
    return memory.run(async () => {
      const before = await loadNav();
      const after = nav.prune(change(before), deps.now());
      if (after !== before) await deps.session.set(NAV_KEY, after);
    }).catch(() => undefined);
  }

  /**
   * The navigation chain as seen by a check for the page in `sender`. The content script can ask
   * a moment before the browser's "navigation committed" event for the same page has been
   * processed, so wait briefly until the chain ends at that page.
   */
  async function navFor(sender: Sender): Promise<nav.NavState> {
    const here = originPath(sender.tabUrl);
    let state = await memory.run(loadNav);
    for (let i = 0; i < 5 && here !== null; i++) {
      const entries = state[String(sender.tabId)]?.entries ?? [];
      if (originPath(entries[entries.length - 1]?.url) === here) break;
      await deps.sleep(50);
      state = await memory.run(loadNav);
    }
    return state;
  }

  async function isAcked(key: string): Promise<boolean> {
    const acks = (await deps.session.get(ACK_KEY).catch(() => undefined)) as Record<string, unknown> | undefined;
    const until = acks && typeof acks === 'object' ? acks[key] : undefined;
    return typeof until === 'number' && until > deps.now();
  }

  function setAck(key: string): Promise<void> {
    return memory.run(async () => {
      const raw = await deps.session.get(ACK_KEY).catch(() => undefined);
      const now = deps.now();
      const acks: Record<string, number> = {};
      if (raw && typeof raw === 'object') for (const [k, v] of Object.entries(raw as Record<string, unknown>)) if (typeof v === 'number' && v > now) acks[k] = v;
      acks[key] = now + ACK_MS;
      await deps.session.set(ACK_KEY, Object.fromEntries(Object.entries(acks).slice(-100)));
    }).catch(() => undefined);
  }

  const ackKey = (sender: Sender, scope: 'auth' | 'login'): string => `${sender.tabId}|${scope}|${(scope === 'auth' ? originPath(sender.tabUrl) : hostOf(sender.tabUrl)) ?? ''}`;

  // ------------------------------------------------------------------ checks asked for by content scripts

  async function checkClipboard(req: Extract<ContentRequest, { type: 'check-clipboard' }>, sender: Sender): Promise<ClipboardReply> {
    const settings = await getSettings();
    if (!settings.modules.pasteGuard || isTrusted(settings, sender.tabUrl)) return { action: 'allow' };
    const command = req.text === '' ? null : safe(() => engine.analyzeCommand(req.text));
    const known = { command: req.text === '' ? ('safe' as const) : levelOf(command), source: req.source, runnable: looksRunnable(req.text), tampered: req.tampered };
    // Reading the page's instructions is by far the slowest step (the engine compiles its page rules the
    // first time, which can take a second or more after the worker wakes). The copy is waiting, so do it
    // only when the page's level could change the outcome. It cannot for the two common cases: ordinary
    // text, and a command that is blocked on its own.
    const pageMatters = req.pageText !== '' && decidePaste({ ...known, page: 'safe' }) !== decidePaste({ ...known, page: 'critical' });
    const page = pageMatters ? safe(() => engine.analyzePageText(req.pageText, { url: sender.tabUrl })) : null;
    const action = decidePaste({ ...known, page: pageMatters ? levelOf(page) : 'safe' });
    if (action === 'allow') return { action };
    const c = await context();
    const info: models.PasteInfo = {
      site: hostOf(sender.tabUrl) ?? '',
      text: req.text,
      source: req.source,
      command: command && levelOf(command) !== 'unknown' ? localized(command, c.locale) : null,
      page: page && levelOf(page) !== 'unknown' ? localized(page, c.locale) : null,
      unchecked: req.text !== '' && levelOf(command) === 'unknown',
    };
    const model = action === 'block' ? models.pasteBlockModel(c, info) : action === 'notice' ? models.pasteNoticeModel(c, info) : models.uncheckedModel(c);
    void record(sender.tabUrl, 'pasteGuard', model.level, model.ruleIds, action === 'block' ? 'blocked' : action === 'notice' ? 'noticed' : 'unchecked');
    const note = c.t('clipboard_note');
    let shownInTop = false;
    if (sender.frameId !== 0) shownInTop = await deps.showInTop(sender.tabId, { type: 'show', model, text: action === 'block' ? req.text : '', note }).catch(() => false);
    return { action, model, note, shownInTop };
  }

  /** Find the brand a page imitates and that brand's real address (using only the engine's public results). */
  function impersonated(v: Verdict): { brand: string | undefined; official: string | undefined } {
    let brand: string | undefined;
    let official: string | undefined;
    for (const f of v.findings) {
      const p = f.params;
      if (!p) continue;
      if (!brand && p['brand']) brand = p['brand'];
      if (!official && p['official'] && /^[a-z0-9.-]{3,253}$/.test(p['official'])) official = p['official'];
    }
    if (brand && !official) {
      const words = brand.toLowerCase().split(/[^a-z0-9]+/).filter((x) => x.length >= 3);
      for (const candidate of [words.join(''), ...words]) {
        const host = `${candidate}.com`;
        const meta = safe(() => engine.analyzeUrl(`https://${host}/`))?.meta;
        if (meta && meta['officialBrand'] === brand) {
          official = host;
          break;
        }
      }
    }
    return { brand, official };
  }

  async function checkLogin(req: Extract<ContentRequest, { type: 'check-login' }>, sender: Sender): Promise<LoginReply> {
    const settings = await getSettings();
    const url = sender.tabUrl;
    if (!settings.modules.lookalike || !isHttpUrl(url) || isTrusted(settings, url)) return { ui: 'none' };
    const referrer = req.referrer || nav.referrerCandidates(await navFor(sender), sender.tabId, url)[0];
    const verdict = safe(() => engine.analyzeUrl(url, { pageTitle: req.title, pageText: req.pageText, hasPasswordField: true, referrer }));
    let ui = decideLogin(levelOf(verdict), verdict?.findings[0]?.severity ?? 'safe');
    if (ui === 'none' || !verdict) return { ui: 'none' };
    if (ui === 'intercept' && (await isAcked(ackKey(sender, 'login')))) ui = 'banner';
    const c = await context();
    const shown = localized(verdict, c.locale);
    const info: models.LoginInfo = { site: hostOf(url) ?? '', verdict: shown, ...impersonated(shown) };
    const strong = decideLogin(verdict.level, verdict.findings[0]?.severity ?? 'safe') === 'intercept';
    const banner = models.loginBannerModel(c, info, strong);
    void record(url, 'lookalike', banner.level, banner.ruleIds, 'warned');
    return ui === 'intercept' ? { ui, model: models.loginModel(c, info), banner } : { ui, banner };
  }

  async function checkAuth(req: Extract<ContentRequest, { type: 'check-auth' }>, sender: Sender): Promise<AuthReply> {
    const settings = await getSettings();
    const url = sender.tabUrl;
    if (!settings.modules.authFlow || !isHttpUrl(url) || isTrusted(settings, url)) return { ui: 'none' };
    const state = await navFor(sender);
    const candidates = [req.referrer, ...nav.referrerCandidates(state, sender.tabId, url)].filter((r, i, all) => isHttpUrl(r) && all.indexOf(r) === i).slice(0, 6);
    // The engine judges one referrer at a time: try each page that led here and keep the most serious result.
    let best = safe(() => engine.analyzeAuthFlow(url));
    let from = '';
    for (const referrer of candidates) {
      const v = safe(() => engine.analyzeAuthFlow(url, { referrer }));
      if (v && (!best || rank(v.level) > rank(best.level) || (v.level === best.level && v.score > best.score))) {
        best = v;
        from = hostOf(referrer) ?? '';
      }
    }
    const flow = asAuthFlow(best?.meta?.['flow']);
    let arrival = nav.arrival(state, sender.tabId);
    if (arrival === 'external' && isHttpUrl(req.referrer)) arrival = 'link';
    const decision = decideAuth(levelOf(best), flow, arrival);
    if (decision.ui === 'none' || !best || flow === 'none' || flow === 'impersonation') return { ui: 'none' };
    let ui = decision.ui;
    if (ui === 'interstitial' && (await isAcked(ackKey(sender, 'auth')))) ui = 'banner';
    const c = await context();
    const provider = typeof best.meta?.['provider'] === 'string' ? best.meta['provider'] : '';
    const model = models.authModel(c, { verdict: localized(best, c.locale), flow, provider, level: decision.level, blocking: ui === 'interstitial', arrival, raised: decision.raised, from });
    void record(url, 'authFlow', decision.level, model.ruleIds, 'warned');
    return { ui, model };
  }

  async function checkPage(req: Extract<ContentRequest, { type: 'check-page' }>, sender: Sender): Promise<PageReply> {
    const settings = await getSettings();
    const url = sender.tabUrl;
    if (!settings.modules.platformLure || !isHttpUrl(url) || isTrusted(settings, url)) return { ui: 'none' };
    const meta = safe(() => engine.analyzeUrl(url))?.meta;
    const platform = meta && typeof meta['platform'] === 'string' ? meta['platform'] : '';
    if (!platform) return { ui: 'none' };
    const page = safe(() => engine.analyzePageText(req.pageText, { url }));
    const hasInstructions = (page?.findings ?? []).some((f) => f.ruleId !== 'page.ugc-host' && f.ruleId !== 'page.educational');
    const ui = decideLure(true, levelOf(page), hasInstructions, hasDownloadStep(req.pageText));
    if (ui === 'none') return { ui };
    const c = await context();
    const model = models.lureModel(c, platform, page ? localized(page, c.locale) : null, ui === 'warn');
    void record(url, 'platformLure', model.level, model.ruleIds, ui === 'warn' ? 'warned' : 'noticed');
    return { ui, model };
  }

  async function checkSecrets(req: Extract<ContentRequest, { type: 'check-secrets' }>, sender: Sender): Promise<SecretsReply> {
    const settings = await getSettings();
    if (!settings.modules.aiPaste || isTrusted(settings, sender.tabUrl)) return { action: 'allow' };
    const verdict = safe(() => engine.scanSecrets(req.text));
    const action = decideAiPaste(levelOf(verdict));
    if (action === 'allow') return { action };
    const c = await context();
    if (action === 'unchecked' || !verdict || typeof verdict.redacted !== 'string') return { action: 'unchecked', model: models.aiUncheckedModel(c) };
    const model = models.aiPasteModel(c, localized(verdict, c.locale));
    void record(sender.tabUrl, 'aiPaste', model.level, model.ruleIds, 'warned');
    return { action: 'prompt', redacted: verdict.redacted, model };
  }

  async function handleContent(req: ContentRequest, sender: Sender): Promise<unknown> {
    switch (req.type) {
      case 'check-clipboard':
        return checkClipboard(req, sender);
      case 'check-login':
        return checkLogin(req, sender);
      case 'check-auth':
        return checkAuth(req, sender);
      case 'check-page':
        return checkPage(req, sender);
      case 'check-secrets':
        return checkSecrets(req, sender);
      case 'report':
        void record(sender.tabUrl, req.module, req.level, req.ruleIds, req.action);
        return { ok: true };
      case 'ack':
        await setAck(ackKey(sender, req.scope));
        return { ok: true };
      case 'leave':
        return { ok: await deps.leaveTab(sender.tabId).catch(() => false) };
    }
  }

  // ------------------------------------------------------------------ popup, options and download prompt

  /** Wildcards must not cover a public suffix or a platform where every sub-site belongs to someone else. */
  function isSharedBase(base: string): boolean {
    if ((safe(() => engine.registrableDomain(base)) ?? null) === null) return true;
    const meta = safe(() => engine.analyzeUrl(`https://sub.${base}/`))?.meta;
    return typeof meta?.['platform'] === 'string';
  }

  function cleanAllowlist(settings: Settings): Settings {
    return { ...settings, allowlist: settings.allowlist.filter((e) => normalizePattern(e.pattern, isSharedBase) !== null) };
  }

  async function state(url: string): Promise<StateReply> {
    const settings = await getSettings();
    const i = await i18n();
    const host = hostOf(url) ?? '';
    return {
      ok: true,
      version: deps.version,
      engineVersion: engine.ENGINE_VERSION,
      settings,
      history: sanitizeHistory(await deps.local.get(HISTORY_KEY).catch(() => undefined)),
      locale: i.locale,
      dir: i.dir,
      messages: { ...i.english, ...i.local },
      levels: Object.fromEntries(LEVELS.map((l) => [l, safe(() => engine.levelLabel(l, i.locale)) ?? l])) as Record<RiskLevel, string>,
      site: { host, canRun: host !== '' && !RESTRICTED_HOSTS.includes(host), trust: findTrust(host, settings.allowlist, deps.now()) ?? null },
    };
  }

  async function handlePage(req: PageRequest): Promise<unknown> {
    switch (req.type) {
      case 'get-state':
        return state(req.url);
      case 'set-settings':
        await saveSettings(cleanAllowlist(sanitizeSettings(req.settings, deps.now())));
        return { ok: true };
      case 'set-module': {
        const s = await getSettings();
        await saveSettings({ ...s, modules: { ...s.modules, [req.module]: req.enabled } });
        return { ok: true };
      }
      case 'add-trust': {
        const pattern = normalizePattern(req.pattern, isSharedBase);
        if (pattern === null || !(req.duration in TRUST_DURATIONS)) return { ok: false, error: 'invalid' };
        const s = await getSettings();
        await saveSettings({ ...s, allowlist: addTrust(s.allowlist, pattern, deps.now(), TRUST_DURATIONS[req.duration] ?? null) });
        return { ok: true };
      }
      case 'remove-trust': {
        const s = await getSettings();
        await saveSettings({ ...s, allowlist: removeTrust(s.allowlist, req.pattern.trim().toLowerCase()) });
        return { ok: true };
      }
      case 'clear-history':
        await disk.run(() => deps.local.set(HISTORY_KEY, []));
        return { ok: true };
      case 'import-settings': {
        const result = importSettings(req.json, deps.now());
        if (!result.ok) return result;
        await saveSettings(cleanAllowlist(result.settings));
        return { ok: true };
      }
      case 'download-info':
        return downloadInfo(req.id);
      case 'download-choice':
        return downloadChoice(req.id, req.choice);
    }
  }

  // ------------------------------------------------------------------ downloads

  async function loadPending(): Promise<Record<string, PendingDownload>> {
    return sanitizePending(await deps.session.get(DOWNLOADS_KEY).catch(() => undefined), deps.now());
  }

  function judgeDownload(name: string, item: { url: string; referrer: string; pageUrl: string }): Verdict | null {
    return safe(() => engine.analyzeDownload(name, { url: item.url, referrer: item.referrer || undefined, pageUrl: item.pageUrl || undefined }));
  }

  /**
   * A download started (or its final name became known). Returns true when the
   * person should be asked; the caller then pauses the download and opens the prompt.
   */
  async function downloadSeen(item: DownloadItemLike, pageUrl: string): Promise<boolean> {
    const settings = await getSettings();
    if (!settings.modules.downloads) return false;
    const url = item.finalUrl || item.url || '';
    const referrer = item.referrer ?? '';
    if (isTrusted(settings, pageUrl, referrer)) return false;
    const name = downloadName(item.filename, url);
    if (name === '') return false;
    const verdict = judgeDownload(name, { url, referrer, pageUrl });
    if (decideDownload(levelOf(verdict)) !== 'ask' || !verdict) return false;
    const fresh = await memory.run(async () => {
      const pending = await loadPending();
      if (pending[String(item.id)]) return false; // already asked about this download
      pending[String(item.id)] = { id: item.id, name, url, referrer, pageUrl, finished: false, decided: false, t: deps.now() };
      await deps.session.set(DOWNLOADS_KEY, pending);
      return true;
    });
    if (fresh) void record(pageUrl || referrer || url, 'downloads', verdict.level, verdict.findings.map((f) => f.ruleId), 'warned');
    return fresh;
  }

  /** Remember whether the file had already finished when we tried to pause it. */
  function downloadFinished(id: number, finished: boolean): Promise<void> {
    return memory.run(async () => {
      const pending = await loadPending();
      const p = pending[String(id)];
      if (!p) return;
      p.finished = finished;
      await deps.session.set(DOWNLOADS_KEY, pending);
    });
  }

  async function downloadInfo(id: number): Promise<{ ok: boolean; model?: WarningModel; decided?: boolean; messages?: Record<string, string>; dir?: 'ltr' | 'rtl'; lang?: string }> {
    const p = (await loadPending())[String(id)];
    const c = await context();
    const messages = { gone: c.t('dl_gone'), cancelled: c.t('dl_done_cancelled'), resumed: c.t('dl_done_resumed'), deleted: c.t('dl_done_deleted'), kept: c.t('dl_done_kept'), title: c.t('dl_title') };
    if (!p || p.decided) return { ok: false, decided: p?.decided === true, messages, dir: c.dir, lang: c.lang };
    const verdict = judgeDownload(p.name, p);
    if (!verdict) return { ok: false, messages, dir: c.dir, lang: c.lang };
    const site = hostOf(p.pageUrl) ?? hostOf(p.referrer) ?? hostOf(p.url) ?? '';
    return { ok: true, model: models.downloadModel(c, p.name, site, localized(verdict, c.locale), p.finished), messages, dir: c.dir, lang: c.lang };
  }

  async function downloadChoice(id: number, choice: 'resume' | 'cancel' | 'delete' | 'keep'): Promise<{ ok: boolean; ops: DownloadOp[] }> {
    const done = await memory.run(async () => {
      const pending = await loadPending();
      const p = pending[String(id)];
      if (!p || p.decided) return null;
      const ops = opsForChoice(choice, p.finished);
      if (ops === null) return null;
      p.decided = true;
      await deps.session.set(DOWNLOADS_KEY, pending);
      return { p, ops };
    });
    if (!done) return { ok: false, ops: [] };
    const verdict = judgeDownload(done.p.name, done.p);
    void record(done.p.pageUrl || done.p.referrer || done.p.url, 'downloads', verdict?.level ?? 'high', verdict?.findings.map((f) => f.ruleId) ?? [], choice === 'resume' || choice === 'keep' ? 'proceeded' : 'cancelled');
    return { ok: true, ops: done.ops };
  }

  async function pendingCount(): Promise<number> {
    return Object.values(await loadPending()).filter((p) => !p.decided).length;
  }

  return {
    handleContent,
    handlePage,
    /** Forget cached settings (storage changed elsewhere). */
    invalidate: (): void => {
      settingsCache = null;
    },
    navBefore: (tabId: number, url: string) => updateNav((s) => nav.beforeNavigate(s, tabId, url, deps.now())),
    navCommitted: (tabId: number, url: string, type: string | undefined, qualifiers: readonly string[] | undefined) => {
      warmIfPlatform(url);
      return updateNav((s) => nav.committed(s, tabId, url, type, qualifiers, deps.now()));
    },
    navCreated: (sourceTabId: number, tabId: number) => updateNav((s) => nav.createdTarget(s, sourceTabId, tabId, deps.now())),
    navRemoved: (tabId: number) => updateNav((s) => nav.tabRemoved(s, tabId)),
    downloadSeen,
    downloadFinished,
    pendingCount,
    /** Resolves when every queued storage write has finished (tests use this). */
    idle: (): Promise<void> => Promise.all([disk.idle(), memory.idle()]).then(() => undefined),
  };
}

export type Core = ReturnType<typeof createCore>;
