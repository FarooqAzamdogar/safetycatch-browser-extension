// Copyright 2026 The ActionGuard Authors
// SPDX-License-Identifier: Apache-2.0

/**
 * Content script (isolated world, document_start, every frame).
 *
 * It is deliberately thin: it watches for the few risky actions, runs cheap
 * local pre-filters, and asks the service worker (where the detection engine
 * lives) only when something needs a real check. On an ordinary page it sends
 * no messages at all. If the service worker cannot be reached it falls back to
 * a neutral "could not check" state and never reports "safe".
 */

import { findTrust } from '../shared/allowlist.ts';
import type { UpMessage } from '../shared/channel.ts';
import { copyCandidates, newCopyContext, type CopyContext } from '../shared/copytrack.ts';
import { decidePaste, type LoginUi, type PasteAction, type PasteSource } from '../shared/decisions.ts';
import type { RiskLevel } from '../shared/levels.ts';
import { parseModel, type WarningModel } from '../shared/model.ts';
import type { ModuleId } from '../shared/modules.ts';
import { isPlatformHint } from '../shared/platform-hints.ts';
import { hasInstructionHint, isAuthUrlCandidate, looksRunnable, mightHoldSecret, needsCommandCheck } from '../shared/prefilter.ts';
import { LIMITS, type AuthReply, type ClipboardReply, type ContentRequest, type LoginReply, type PageReply, type SecretsReply } from '../shared/protocol.ts';
import { DEFAULT_AI_SITES, sanitizeSettings, SETTINGS_KEY, type Settings } from '../shared/settings.ts';
import { matchesSite } from '../shared/sites.ts';
import { clip, displaySample } from '../shared/text.ts';
import { createIsoChannel } from './channel-iso.ts';
import { deepActive, insertText, saveTarget } from './insert.ts';
import { createUi, type ModalHandle } from './ui.ts';

const w = window;
const doc = document;
let isTop = false;
try {
  isTop = w.top === w;
} catch {
  isTop = false;
}

/** False once the extension was updated, disabled or removed while this page stayed open. */
let alive = true;
const ui = createUi(w, doc);

// ---------------------------------------------------------------- service worker

function stillAlive(): boolean {
  if (!alive) return false;
  try {
    if (chrome.runtime.id) return true;
  } catch {
    // extension context is gone
  }
  alive = false;
  channel.passive(); // let the page's clipboard calls through untouched
  return false;
}

/**
 * How long to wait for checks that hold nothing up (sign-in page, device-code page, platform notice).
 * A copy or a paste that is waiting for its answer uses the shorter defaults below.
 */
const PASSIVE_TIMEOUT_MS = 8000;
/** Pause before a passive check is repeated after it got no answer. */
const RETRY_AFTER_MS = 1500;
/**
 * A copy that is waiting for its verdict. Must stay below the page-world hook's own limit
 * (about 6 seconds, see main-hooks.ts), after which the hook refuses the write.
 */
const COPY_TIMEOUT_MS = 4500;

/** Ask the service worker. Resolves to null on any failure or timeout ("could not check"). */
function ask<T>(msg: ContentRequest, timeoutMs = 3000): Promise<T | null> {
  if (!stillAlive()) return Promise.resolve(null);
  return new Promise((resolve) => {
    let done = false;
    const finish = (value: T | null): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    try {
      chrome.runtime.sendMessage(msg).then(
        (r) => finish(typeof r === 'object' && r !== null ? (r as T) : null),
        () => {
          stillAlive();
          finish(null);
        },
      );
    } catch {
      stillAlive();
      finish(null);
    }
  });
}

function tell(msg: ContentRequest): void {
  void ask(msg, 1500);
}

function report(module: ModuleId, action: 'restored' | 'proceeded' | 'redacted' | 'cancelled', model: WarningModel): void {
  tell({ type: 'report', module, action, level: model.level, ruleIds: model.ruleIds });
}

/** A string from the browser-language catalog, for the few warnings built without the service worker. */
function local(key: string, params?: Readonly<Record<string, string>>): string {
  let text = '';
  try {
    text = chrome.i18n.getMessage(key);
  } catch {
    return '';
  }
  return params ? text.replace(/\{([a-z]+)\}/g, (whole, name: string) => params[name] ?? whole) : text;
}

function localModel(kind: 'paste-block' | 'unchecked' | 'ai-unchecked', text = ''): WarningModel | null {
  const brand = local('brand');
  if (!brand) return null;
  const base = {
    level: 'medium' as RiskLevel,
    levelLabel: local('level_unknown'),
    lang: local('ui_lang') || 'en',
    dir: local('ui_dir') === 'rtl' ? ('rtl' as const) : ('ltr' as const),
    brand,
    sections: [],
    ruleIds: [],
  };
  if (kind === 'unchecked') {
    return { ...base, kind, layout: 'banner', module: 'pasteGuard', title: local('unchecked_title'), lead: [local('unchecked_text')], buttons: [{ id: 'ok', label: local('btn_got_it'), style: 'primary' }] };
  }
  if (kind === 'ai-unchecked') {
    return {
      ...base,
      kind,
      layout: 'dialog',
      module: 'aiPaste',
      title: local('ai_unchecked_title'),
      lead: [local('ai_unchecked_text')],
      buttons: [
        { id: 'cancel', label: local('btn_cancel'), style: 'primary' },
        { id: 'paste', label: local('ai_paste'), style: 'secondary' },
      ],
    };
  }
  const sample = displaySample(text);
  return {
    ...base,
    kind,
    layout: 'page',
    module: 'pasteGuard',
    title: local('paste_unchecked_title'),
    lead: [local('paste_unchecked_lead', { site: location.hostname })],
    cleared: local('paste_cleared'),
    notCleared: local('paste_not_cleared'),
    sample: { title: local('paste_sample_title'), text: sample.text, more: sample.hiddenChars > 0 ? local('paste_more_chars', { count: String(sample.hiddenChars) }) : '' },
    buttons: [
      { id: 'keep', label: local('paste_keep'), style: 'primary' },
      { id: 'clear', label: local('paste_clear_now'), style: 'secondary' },
      { id: 'restore', label: local('paste_restore_hold'), style: 'hold' },
    ],
    friction: { hint: local('hold_hint'), typeLabel: local('type_label', { word: local('confirm_word') }), word: local('confirm_word'), covered: local('covered_warning') },
  };
}

function pageText(max: number): string {
  try {
    return clip(doc.body?.innerText ?? '', max);
  } catch {
    return '';
  }
}

function leave(): void {
  void ask<{ ok?: boolean }>({ type: 'leave' }, 1500).then((r) => {
    if (r && r.ok === true) return;
    try {
      location.replace('about:blank');
    } catch {
      // nothing else to do
    }
  });
}

// ---------------------------------------------------------------- paste guard (ClickFix / FileFix)

/** Set while we copy our own harmless note with execCommand, so our copy listener fills it in. */
let selfCopy: string | null = null;
/** Texts the person deliberately put back; the page may copy them again without a new warning. */
const approved = new Set<string>();
const recent = new Map<string, { at: number; outcome: Promise<Outcome> }>();
const stamps: number[] = [];
let tampered = false;
let lastBackstop = 0;
let blockOpen: { text: string; handle: ModalHandle } | null = null;
const lastNotice: Record<string, number> = {};

interface Outcome {
  action: PasteAction;
  model: WarningModel | null;
  note: string;
  shownInTop: boolean;
}

async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // The frame is not focused, or the browser refused: try the older way.
  }
  selfCopy = text;
  try {
    return doc.execCommand('copy');
  } catch {
    return false;
  } finally {
    selfCopy = null;
  }
}

function presentBlock(model: WarningModel, text: string, note: string, cleared: boolean): void {
  if (blockOpen && blockOpen.handle.isOpen()) {
    if (cleared) blockOpen.handle.setCleared(true);
    return;
  }
  const handle = ui.modal(
    model,
    (id, h) => {
      if (id === 'keep') {
        h.close();
      } else if (id === 'clear') {
        void writeClipboard(note).then((ok) => h.setCleared(ok));
      } else if (id === 'restore' && text !== '') {
        approved.add(text);
        void writeClipboard(text).then((ok) => {
          if (!ok) return;
          report('pasteGuard', 'restored', model);
          h.close();
        });
      }
    },
    cleared,
  );
  blockOpen = { text, handle };
}

function showNotice(model: WarningModel): void {
  const now = Date.now();
  if (now - (lastNotice[model.kind] ?? 0) < 30_000) return;
  lastNotice[model.kind] = now;
  ui.banner(model);
}

/** The engine reads at most 100,000 characters: for longer text send the start and the end. */
function fit(text: string): string {
  return text.length <= LIMITS.text ? text : `${text.slice(0, LIMITS.text - 20_001)}\n${text.slice(-20_000)}`;
}

function underRateLimit(): boolean {
  const now = Date.now();
  while (stamps.length > 0 && now - (stamps[0] as number) > 60_000) stamps.shift();
  if (stamps.length >= 30) return false;
  stamps.push(now);
  return true;
}

async function evaluate(text: string, source: PasteSource): Promise<Outcome> {
  let reply: ClipboardReply | null = null;
  if (underRateLimit()) reply = await ask<ClipboardReply>({ type: 'check-clipboard', text: fit(text), pageText: pageText(LIMITS.pageText), source, tampered }, COPY_TIMEOUT_MS);
  if (reply && (reply.action === 'allow' || reply.action === 'notice' || reply.action === 'block' || reply.action === 'unchecked')) {
    return { action: reply.action, model: parseModel(reply.model), note: typeof reply.note === 'string' && reply.note ? reply.note : local('clipboard_note'), shownInTop: reply.shownInTop === true };
  }
  // Could not check. Decide locally and never call it safe.
  const action = decidePaste({ command: 'unknown', page: 'unknown', source, runnable: looksRunnable(text), tampered });
  const model = action === 'block' ? localModel('paste-block', text) : action === 'unchecked' ? localModel('unchecked') : null;
  return { action, model, note: local('clipboard_note'), shownInTop: false };
}

/** Check text that a page put (or wants to put) on the clipboard, and act on the result. */
async function guardWrite(text: string, source: PasteSource): Promise<PasteAction> {
  if (!stillAlive() || approved.has(text)) return 'allow';
  const key = `${source}\n${text}`;
  const now = Date.now();
  for (const [k, old] of recent) if (now - old.at > 5000) recent.delete(k); // copied text is not kept longer than needed
  let entry = recent.get(key);
  if (!entry) {
    entry = { at: now, outcome: evaluate(text, source) };
    recent.set(key, entry);
    if (recent.size > 8) recent.delete(recent.keys().next().value as string);
  }
  const o = await entry.outcome;
  if (o.action === 'block') {
    const cleared = o.note !== '' && (await writeClipboard(o.note));
    if (o.model && !o.shownInTop) presentBlock(o.model, text, o.note, cleared);
  } else if ((o.action === 'notice' || o.action === 'unchecked') && o.model && !o.shownInTop) {
    showNotice(o.model);
  }
  return o.action;
}

/** The page swapped our hooks for pristine browser functions: look at what the page tells people to do. */
function backstop(): void {
  const now = Date.now();
  if (now - lastBackstop < 5000) return;
  lastBackstop = now;
  void guardWrite('', 'programmatic');
}

let copyCtx: CopyContext | null = null;
let exec: { pre: string; setData: string[]; hadEvent: boolean } | null = null;
let lastCopyKey = 0;
let lastMenu = 0;
let lastVerify = 0;

function selectedText(): string {
  let text = '';
  try {
    text = doc.getSelection()?.toString() ?? '';
  } catch {
    // ignore
  }
  if (text === '') {
    const el = deepActive(doc);
    if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
      try {
        const a = el.selectionStart;
        const b = el.selectionEnd;
        if (typeof a === 'number' && typeof b === 'number' && b > a) text = el.value.slice(a, b);
      } catch {
        // input types without a selection
      }
    }
  }
  return text;
}

function settleCopy(c: CopyContext): void {
  for (const candidate of copyCandidates(c)) {
    if (needsCommandCheck(candidate.text)) void guardWrite(candidate.text, candidate.source).catch(() => undefined);
  }
}

function onCopyCapture(e: Event): void {
  if (selfCopy !== null) {
    // Our own "replace the clipboard with a harmless note" copy. The page never sees it.
    e.stopImmediatePropagation();
    e.preventDefault();
    if (e.type === 'copy') (e as ClipboardEvent).clipboardData?.setData('text/plain', selfCopy);
    return;
  }
  if ((e.type !== 'copy' && e.type !== 'cut') || !e.isTrusted || !alive || ui.owns(e)) return;
  const now = Date.now();
  const byPerson = now - lastCopyKey < 1500 || now - lastMenu < 60_000;
  const programmatic = exec !== null || !byPerson;
  if (exec) exec.hadEvent = true;
  if (!copyCtx) {
    const mine = newCopyContext(programmatic);
    if (exec && exec.pre) mine.selections.push(exec.pre);
    copyCtx = mine;
    setTimeout(() => {
      if (copyCtx === mine) copyCtx = null;
      mine.selections.push(selectedText());
      settleCopy(mine);
    }, 0);
  } else if (programmatic) {
    copyCtx.programmatic = true;
  }
  copyCtx.selections.push(selectedText());
}

function onCopyBubble(e: Event): void {
  if (selfCopy !== null || !copyCtx || !e.isTrusted) return;
  copyCtx.defaultPrevented = e.defaultPrevented;
  if (e.defaultPrevented) {
    try {
      copyCtx.finalData = (e as ClipboardEvent).clipboardData?.getData('text/plain') ?? null;
    } catch {
      // ignore
    }
  } else {
    copyCtx.selections.push(selectedText());
  }
}

function onUp(m: UpMessage): void {
  switch (m.kind) {
    case 'w':
    case 'W':
      if (!alive || !needsCommandCheck(m.text)) {
        channel.reply(m.id, true); // answered during the page's own call: nothing is delayed
        return;
      }
      void guardWrite(m.text, 'programmatic').then(
        (action) => channel.reply(m.id, action !== 'block'),
        // An error of our own is "could not check": refuse what looks like a command, let the rest through.
        () => channel.reply(m.id, !looksRunnable(m.text)),
      );
      return;
    case 's':
      if (copyCtx) copyCtx.setData.push(m.text);
      else if (exec) exec.setData.push(m.text);
      return;
    case 'x':
      exec = { pre: m.text, setData: [], hadEvent: false };
      return;
    case 'X': {
      const e = exec;
      exec = null;
      if (!e || m.id !== 1 || !alive) return;
      if (copyCtx && e.hadEvent) {
        copyCtx.programmatic = true;
        if (m.text) copyCtx.selections.push(m.text);
      } else {
        // The copy happened in a document whose events we do not see (a frame hooked from here).
        const c = newCopyContext(true);
        c.setData = e.setData;
        c.selections = [e.pre, m.text].filter((t) => t !== '');
        settleCopy(c);
      }
      return;
    }
    case 't':
      tampered = true;
      backstop();
      return;
    default:
      return;
  }
}

// ---------------------------------------------------------------- AI-chat paste guard

let settings: Settings | null = null;
let settingsAsked = false;
const ownEvents = new WeakSet<Event>();

function loadSettings(): void {
  if (settingsAsked || !stillAlive()) return;
  settingsAsked = true;
  try {
    chrome.storage.local.get(SETTINGS_KEY).then(
      (stored) => {
        settings = sanitizeSettings(stored[SETTINGS_KEY], Date.now());
        chrome.storage.onChanged.addListener((changes, area) => {
          const change = changes[SETTINGS_KEY];
          if (area === 'local' && change) settings = sanitizeSettings(change.newValue, Date.now());
        });
      },
      () => {
        settingsAsked = false;
      },
    );
  } catch {
    settingsAsked = false;
  }
}

function topHost(): string {
  if (isTop) return location.hostname;
  try {
    const origins = location.ancestorOrigins;
    const top = origins && origins.length > 0 ? origins[origins.length - 1] : undefined;
    if (top) return new URL(top).hostname;
  } catch {
    // not available in every browser
  }
  return location.hostname;
}

function aiActive(): boolean {
  const s = settings;
  if (!s) return matchesSite(location.hostname, location.pathname, DEFAULT_AI_SITES);
  return s.modules.aiPaste && matchesSite(location.hostname, location.pathname, s.aiSites) && !findTrust(topHost(), s.allowlist, Date.now());
}

function onPaste(e: Event): void {
  if (ownEvents.has(e) || !e.isTrusted || ui.owns(e) || !stillAlive()) return;
  if (loginBlocks(e)) return;
  if (!aiActive()) return;
  let text = '';
  try {
    text = (e as ClipboardEvent).clipboardData?.getData('text/plain') ?? '';
  } catch {
    return;
  }
  if (!mightHoldSecret(text)) return;
  // The engine runs in the service worker, so the paste has to be held back first and replayed after the answer.
  e.preventDefault();
  e.stopImmediatePropagation();
  const saved = saveTarget(doc);
  const put = (value: string): void => {
    insertText(doc, saved, value, (ev) => ownEvents.add(ev));
  };
  const refocus = (): void => {
    if (saved.element instanceof HTMLElement) saved.element.focus({ preventScroll: true });
  };
  const request: Promise<SecretsReply | null> = text.length > LIMITS.text ? Promise.resolve(null) : ask<SecretsReply>({ type: 'check-secrets', text }, 4000);
  void request.then((reply) => {
    if (reply && reply.action === 'allow') return put(text);
    const model = reply ? parseModel(reply.model) : null;
    if (reply && reply.action === 'prompt' && model && typeof reply.redacted === 'string') {
      const redacted = reply.redacted;
      ui.modal(model, (id, h) => {
        h.close();
        if (id === 'redact') {
          put(redacted);
          report('aiPaste', 'redacted', model);
        } else if (id === 'anyway') {
          put(text);
          report('aiPaste', 'proceeded', model);
        } else {
          refocus();
          report('aiPaste', 'cancelled', model);
        }
      });
      return;
    }
    // Could not check: say so, and let the person decide.
    const fallback = (reply && reply.action === 'unchecked' ? model : null) ?? localModel('ai-unchecked');
    if (!fallback) return put(text);
    ui.modal(fallback, (id, h) => {
      h.close();
      if (id === 'paste') put(text);
      else refocus();
    });
  });
}

// ---------------------------------------------------------------- look-alike sign-in page (top frame)

const login: { state: 'idle' | 'checking' | 'done'; ui: LoginUi; model: WarningModel | null; acked: boolean; href: string; checks: number } = {
  state: 'idle',
  ui: 'none',
  model: null,
  acked: false,
  href: '',
  checks: 0,
};

const isPassword = (node: unknown): node is HTMLInputElement => node instanceof HTMLInputElement && node.type === 'password';

function eventField(e: Event): unknown {
  try {
    return e.composedPath()[0];
  } catch {
    return e.target;
  }
}

function showLoginModal(): void {
  const model = login.model;
  if (!model || ui.modalOpen()) return;
  const field = deepActive(doc);
  ui.modal(model, (id, h) => {
    if (id === 'leave') {
      leave();
    } else if (id === 'stay') {
      login.acked = true;
      h.close();
      tell({ type: 'ack', scope: 'login' });
      report('lookalike', 'proceeded', model);
      if (field instanceof HTMLElement) field.focus({ preventScroll: true });
    }
  });
}

function checkLogin(): void {
  if (!isTop || !stillAlive() || login.state === 'checking' || login.checks >= 5) return;
  if (login.state === 'done' && login.href === location.href) return;
  login.state = 'checking';
  login.href = location.href;
  login.checks++;
  void ask<LoginReply>({ type: 'check-login', title: doc.title, pageText: pageText(LIMITS.loginText), referrer: doc.referrer }, PASSIVE_TIMEOUT_MS).then((reply) => {
    login.ui = 'none';
    login.model = null;
    if (!reply) {
      // No answer (the service worker was restarting, or the machine is very slow): this is "not checked",
      // not "fine". Ask again shortly; the number of checks per page is capped.
      login.state = 'idle';
      setTimeout(scanForPassword, RETRY_AFTER_MS);
      return;
    }
    login.state = 'done';
    const banner = parseModel(reply.banner);
    if (reply.ui !== 'none' && banner) ui.banner(banner);
    if (reply.ui === 'intercept') {
      login.model = parseModel(reply.model);
      if (login.model) {
        login.ui = 'intercept';
        if (isPassword(deepActive(doc)) && !login.acked) showLoginModal();
      }
    } else {
      login.ui = reply.ui === 'banner' ? 'banner' : 'none';
    }
  });
}

/** Stop typing into a password field on a page judged to be a look-alike, and show why. */
function loginBlocks(e: Event): boolean {
  if (!isTop || !alive || !isPassword(eventField(e))) return false;
  if (login.state === 'idle' || (login.state === 'done' && login.href !== location.href)) checkLogin();
  if (login.ui !== 'intercept' || login.acked || !login.model) return false;
  if (e.type !== 'focusin') {
    e.preventDefault();
    e.stopImmediatePropagation();
  }
  showLoginModal();
  return true;
}

let scanTimer: ReturnType<typeof setTimeout> | undefined;
function scanForPassword(): void {
  scanTimer = undefined;
  try {
    if (doc.querySelector('input[type="password" i]')) checkLogin();
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------- device-code / app-approval pages, platform lures (top frame)

let authHref = '';
let authTries = 0;
function checkAuth(): void {
  if (!isTop || authHref === location.href || !isAuthUrlCandidate(location.href)) return;
  authHref = location.href;
  void ask<AuthReply>({ type: 'check-auth', referrer: doc.referrer }, PASSIVE_TIMEOUT_MS).then((reply) => {
    if (!reply && ++authTries < 3) {
      // Not checked yet: try again shortly rather than leave a sign-in page without its warning.
      authHref = '';
      setTimeout(checkAuth, RETRY_AFTER_MS);
      return;
    }
    const model = reply ? parseModel(reply.model) : null;
    if (!reply || !model) return;
    if (reply.ui === 'banner') {
      ui.banner(model);
    } else if (reply.ui === 'interstitial') {
      ui.modal(model, (id, h) => {
        if (id === 'leave') {
          leave();
        } else if (id === 'continue') {
          h.close();
          tell({ type: 'ack', scope: 'auth' });
          report('authFlow', 'proceeded', model);
        }
      });
    }
  });
}

let lureTries = 0;
let lureDone = false;
function checkLure(): void {
  if (!isTop || lureDone || lureTries >= 3 || !stillAlive() || !isPlatformHint(location.hostname, location.pathname)) return;
  lureTries++;
  const text = pageText(LIMITS.pageText);
  if (!hasInstructionHint(text)) return;
  void ask<PageReply>({ type: 'check-page', pageText: text }, PASSIVE_TIMEOUT_MS).then((reply) => {
    const model = reply ? parseModel(reply.model) : null;
    if (!reply || !model || reply.ui === 'none' || lureDone) return;
    lureDone = true;
    ui.banner(model);
  });
}

// ---------------------------------------------------------------- wiring

function poke(): void {
  loadSettings();
  const now = Date.now();
  if (now - lastVerify > 1000) {
    lastVerify = now;
    channel.verify(); // "re-check on use": are our clipboard hooks still in place?
  }
}

function onKeyDown(e: Event): void {
  if (!e.isTrusted || ui.owns(e)) return;
  const ke = e as KeyboardEvent;
  const key = typeof ke.key === 'string' ? ke.key.toLowerCase() : '';
  if (((ke.ctrlKey || ke.metaKey) && (key === 'c' || key === 'x' || key === 'insert')) || (ke.shiftKey && key === 'delete')) lastCopyKey = Date.now();
  poke();
  loginBlocks(e);
}

function onTrusted(e: Event): void {
  if (!e.isTrusted || ui.owns(e)) return;
  if (e.type === 'contextmenu') lastMenu = Date.now();
  else if (e.type === 'pointerdown') poke();
  else loginBlocks(e);
}

const channel = createIsoChannel(w, (bytes) => crypto.getRandomValues(bytes), onUp);

/** (Re-)attach every listener. Adding the same listener twice is a no-op, so this is safe to repeat. */
function attach(): void {
  channel.ensure();
  for (const type of ['copy', 'cut', 'beforecopy', 'beforecut']) w.addEventListener(type, onCopyCapture, true);
  w.addEventListener('copy', onCopyBubble, false);
  w.addEventListener('cut', onCopyBubble, false);
  w.addEventListener('paste', onPaste, true);
  w.addEventListener('keydown', onKeyDown, true);
  for (const type of ['pointerdown', 'contextmenu']) w.addEventListener(type, onTrusted, true);
  if (isTop) {
    for (const type of ['focusin', 'beforeinput', 'drop']) w.addEventListener(type, onTrusted, true);
    w.addEventListener('hashchange', checkAuth, true);
    w.addEventListener('popstate', checkAuth, true);
  }
}
attach();

// document.open() wipes every listener on the window, ours included. It also replaces the
// document's children, which this observer sees, so the listeners are put back at once.
new MutationObserver(() => {
  attach();
  ui.reattach();
}).observe(doc, { childList: true });

if (isTop) {
  checkAuth();
  const start = (): void => {
    scanForPassword();
    if (doc.documentElement) {
      new MutationObserver(() => {
        if (scanTimer === undefined) scanTimer = setTimeout(scanForPassword, 700);
      }).observe(doc.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['type'] });
    }
    for (const delay of [900, 4000, 10_000]) setTimeout(checkLure, delay);
  };
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', start, { once: true });
  else start();

  // Warnings triggered inside a sub-frame are drawn here, where there is room for them.
  try {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (sender.tab || sender.id !== chrome.runtime.id || typeof msg !== 'object' || msg === null) return undefined;
      const m = msg as Record<string, unknown>;
      if (m['type'] !== 'show') return undefined;
      const model = parseModel(m['model']);
      if (!model) return undefined;
      const text = typeof m['text'] === 'string' ? m['text'] : '';
      const note = typeof m['note'] === 'string' ? m['note'] : '';
      if (model.kind === 'paste-block') void writeClipboard(note).then((ok) => presentBlock(model, text, note, ok));
      else showNotice(model);
      sendResponse({ ok: true });
      return undefined;
    });
  } catch {
    // extension context already gone
  }
}
