// Copyright 2026 The ActionGuard Authors
// SPDX-License-Identifier: Apache-2.0

/**
 * Warning UI drawn inside web pages. The page is assumed hostile:
 *
 * - Everything lives in a closed shadow root with reset styles, built with
 *   createElement and textContent only.
 * - Input is handled by ONE listener registered on `window` at document_start,
 *   before any page listener exists. It takes every event aimed at the warning
 *   away from the page (stopImmediatePropagation), ignores synthetic events
 *   (isTrusted) and finds the control inside the shadow root itself. The page
 *   can therefore neither press our buttons nor block them.
 * - A small guardian puts the warning back if the page removes, hides or
 *   covers it. The protective action (clearing the clipboard, stopping a
 *   paste) has always happened before the warning is drawn, so a page that
 *   wins this fight only hides an explanation.
 */

import { HOLD_MS, holdComplete, holdStart, phraseMatches, type HoldState } from '../shared/friction.ts';
import type { RiskLevel } from '../shared/levels.ts';
import type { ButtonId, ModelButton, WarningModel } from '../shared/model.ts';

export interface ModalHandle {
  /** Paste warnings: show whether the clipboard could be cleared. */
  setCleared(cleared: boolean): void;
  close(): void;
  isOpen(): boolean;
}

export interface Ui {
  /** True when the event came from inside the warning UI. */
  owns(e: Event): boolean;
  modal(model: WarningModel, onButton: (id: ButtonId, handle: ModalHandle) => void, cleared?: boolean): ModalHandle;
  banner(model: WarningModel, onButton?: (id: ButtonId) => void): void;
  modalOpen(): boolean;
  /** Put the input listener back after `document.open()` erased it. */
  reattach(): void;
}

/** Level colours. All give at least 4.5:1 contrast with white text; the level is always written out too. */
const COLORS: Readonly<Record<RiskLevel, string>> = { safe: '#166534', low: '#1d4ed8', medium: '#92400e', high: '#c2410c', critical: '#b91c1c' };

const CSS = `
:host{all:initial}
*,*::before,*::after{box-sizing:border-box}
.layer{position:fixed;inset:0;pointer-events:none;font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans",Arial,sans-serif;color:#111827;text-align:start}
.veil{position:absolute;inset:0;pointer-events:auto;display:flex;align-items:center;justify-content:center;padding:16px;overflow:auto;background:rgba(15,23,42,.94)}
.veil.dialog{background:rgba(15,23,42,.6)}
.card{background:#fff;color:#111827;width:100%;max-width:660px;max-height:100%;overflow:auto;border-radius:12px;border-top:8px solid var(--lvl);padding:22px 24px;box-shadow:0 12px 48px rgba(0,0,0,.5)}
.head{display:flex;flex-wrap:wrap;gap:10px;align-items:center;font-size:14px;font-weight:700;color:#374151}
.pill{background:var(--lvl);color:#fff;border-radius:999px;padding:2px 12px;font-size:13px;font-weight:700}
h1{font-size:22px;line-height:1.3;margin:10px 0 6px;font-weight:700}
h2{font-size:15px;margin:16px 0 4px;font-weight:700}
p{margin:6px 0;font-size:15px}
ul{margin:4px 0;padding-inline-start:22px}
li{font-size:15px;margin:3px 0}
.status{font-weight:700}
pre{direction:ltr;text-align:left;unicode-bidi:isolate;margin:6px 0;padding:10px;max-height:150px;overflow:auto;white-space:pre-wrap;word-break:break-all;background:#f3f4f6;color:#111827;border:1px solid #9ca3af;border-radius:8px;font:13px/1.45 ui-monospace,Consolas,Menlo,monospace;user-select:none;-webkit-user-select:none}
.more{font-size:13px;color:#4b5563}
.row{display:flex;flex-wrap:wrap;gap:10px;margin-top:18px}
button{font:inherit;font-size:15px;font-weight:700;min-height:44px;padding:9px 16px;border-radius:8px;border:2px solid #1d4ed8;background:#1d4ed8;color:#fff;cursor:pointer}
button.secondary{background:#fff;color:#1d4ed8}
button.hold{position:relative;overflow:hidden;background:#fff;color:#7f1d1d;border-color:#7f1d1d;touch-action:none}
button.hold .bar{position:absolute;top:0;bottom:0;inset-inline-start:0;width:0;background:rgba(127,29,29,.22)}
button.hold .lbl{position:relative}
button:focus-visible,input:focus-visible{outline:3px solid #f59e0b;outline-offset:2px}
.fr{margin-top:12px;font-size:13px;color:#374151}
.fr label{display:block;margin-top:6px}
.fr input{font:inherit;font-size:14px;margin-inline-start:6px;padding:5px 8px;width:9em;border:1px solid #6b7280;border-radius:6px;background:#fff;color:#111827}
.cov{color:#b91c1c;font-weight:700}
[hidden]{display:none!important}
.banners{position:absolute;top:0;inset-inline:0;display:flex;flex-direction:column}
.banner{pointer-events:auto;display:flex;flex-wrap:wrap;gap:8px 14px;align-items:flex-start;background:#fff;color:#111827;border-bottom:5px solid var(--lvl);box-shadow:0 2px 14px rgba(0,0,0,.35);padding:10px 16px}
.banner .txt{flex:1 1 320px;min-width:0}
.banner strong{display:block;font-size:15px}
.banner p,.banner li{font-size:14px;margin:2px 0}
.banner button{min-height:36px;padding:5px 14px;font-size:14px}
@media (prefers-color-scheme:dark){
.card,.banner{background:#111827;color:#f9fafb}
.head{color:#d1d5db}
pre{background:#1f2937;color:#f9fafb;border-color:#6b7280}
.more,.fr{color:#d1d5db}
button.secondary{background:#111827;color:#93c5fd;border-color:#93c5fd}
button.hold{background:#111827;color:#fecaca;border-color:#fecaca}
.cov{color:#fca5a5}
.fr input{background:#1f2937;color:#f9fafb}
}
`;

const HOST_STYLE: ReadonlyArray<readonly [string, string]> = [
  ['all', 'initial'],
  ['position', 'fixed'],
  ['inset', '0'],
  ['width', '100vw'],
  ['height', '100vh'],
  ['max-width', 'none'],
  ['max-height', 'none'],
  ['margin', '0'],
  ['padding', '0'],
  ['border', '0'],
  ['background', 'transparent'],
  ['overflow', 'visible'],
  ['display', 'block'],
  ['visibility', 'visible'],
  ['opacity', '1'],
  ['transform', 'none'],
  ['filter', 'none'],
  ['clip-path', 'none'],
  ['pointer-events', 'none'],
  ['z-index', '2147483647'],
];

interface Action {
  mode: 'click' | 'hold';
  run: () => void;
  bar?: HTMLElement;
}

interface ModalState {
  veil: HTMLElement;
  model: WarningModel;
  focusFirst: HTMLElement | null;
  status: HTMLElement | null;
  clearButton: HTMLElement | null;
  word: HTMLInputElement | null;
  covered: HTMLElement | null;
  holdAction: Action | null;
  holdButton: HTMLElement | null;
  onButton: (id: ButtonId) => void;
  visible: boolean | undefined;
  io: IntersectionObserver | undefined;
}

export function createUi(w: Window, doc: Document): Ui {
  let host: HTMLElement | null = null;
  let shadow: ShadowRoot | null = null;
  let banners: HTMLElement | null = null;
  let layer: HTMLElement | null = null;
  let modal: ModalState | null = null;
  let guard: ReturnType<typeof setInterval> | undefined;
  let observer: MutationObserver | undefined;
  let reattached = 0;
  let hold: { action: Action; via: 'pointer' | 'key'; state: HoldState; timer: ReturnType<typeof setTimeout> } | null = null;
  const actions = new WeakMap<Element, Action>();

  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] => {
    // Always an HTML element, even when the page is an XML or SVG document.
    const node = doc.createElementNS('http://www.w3.org/1999/xhtml', tag) as HTMLElementTagNameMap[K];
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  /** The host's style attribute exactly as we last wrote it; anything else means the page changed it. */
  let hostStyle = '';
  const styleHost = (): void => {
    if (!host) return;
    if (hostStyle === '' || host.getAttribute('style') !== hostStyle) {
      host.removeAttribute('style');
      // Inline declarations marked important beat every rule a page style sheet can contain.
      for (const [name, value] of HOST_STYLE) host.style.setProperty(name, value, 'important');
      hostStyle = host.getAttribute('style') ?? '';
    }
    for (const attr of ['hidden', 'inert', 'class', 'aria-hidden']) if (host.hasAttribute(attr)) host.removeAttribute(attr);
  };

  /** Modal warnings go into the browser's top layer so no z-index on the page can cover them. */
  const topLayer = (): void => {
    if (!host || typeof host.showPopover !== 'function') return;
    try {
      if (modal) {
        if (host.getAttribute('popover') !== 'manual') host.setAttribute('popover', 'manual');
        if (!host.matches(':popover-open')) host.showPopover();
      } else if (host.hasAttribute('popover')) {
        if (host.matches(':popover-open')) host.hidePopover();
        host.removeAttribute('popover');
      }
    } catch {
      // Older browsers: the fixed, max z-index host is the fallback.
    }
  };

  const hasContent = (): boolean => modal !== null || (banners !== null && banners.childElementCount > 0);

  const teardown = (): void => {
    if (guard !== undefined) clearInterval(guard);
    guard = undefined;
    observer?.disconnect();
    observer = undefined;
    host?.remove();
  };

  const check = (): void => {
    if (!host) return;
    if (!hasContent()) return teardown();
    const root = doc.documentElement;
    // Also undo being moved inside another element, where a hidden parent could hide the warning.
    if (root && host.parentNode !== root && reattached++ < 200) root.appendChild(host);
    styleHost();
    topLayer();
    if (modal && shadow && !shadow.activeElement && doc.hasFocus()) modal.focusFirst?.focus({ preventScroll: true });
  };

  const ensureHost = (): void => {
    if (!host) {
      host = el('div');
      shadow = host.attachShadow({ mode: 'closed' });
      try {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(CSS);
        shadow.adoptedStyleSheets = [sheet];
      } catch {
        shadow.appendChild(el('style', undefined, CSS));
      }
      layer = el('div', 'layer');
      banners = el('div', 'banners');
      layer.appendChild(banners);
      shadow.appendChild(layer);
    }
    styleHost();
    const root = doc.documentElement;
    if (root && host.parentNode !== root) root.appendChild(host);
    if (guard === undefined) {
      reattached = 0;
      guard = setInterval(() => {
        reattached = 0;
        check();
      }, 400);
      observer = new MutationObserver(check);
      observer.observe(doc, { childList: true });
      if (root) observer.observe(root, { childList: true });
    }
  };

  const resetHold = (): void => {
    if (!hold) return;
    clearTimeout(hold.timer);
    const bar = hold.action.bar;
    if (bar) {
      bar.style.transition = 'none';
      bar.style.width = '0';
    }
    hold = null;
  };

  const confirmHold = (action: Action): void => {
    // If something on the page is drawn over the button, the person may not know what they are holding.
    if (modal && modal.visible === false && modal.covered) {
      modal.covered.hidden = false;
      return;
    }
    action.run();
  };

  const startHold = (action: Action, via: 'pointer' | 'key'): void => {
    resetHold();
    const state = holdStart(performance.now(), true);
    if (action.bar) {
      action.bar.style.transition = `width ${HOLD_MS}ms linear`;
      action.bar.style.width = '100%';
    }
    const timer = setTimeout(() => {
      if (!hold || hold.action !== action || !holdComplete(hold.state, performance.now() + 30)) return;
      resetHold();
      confirmHold(action);
    }, HOLD_MS);
    hold = { action, via, state, timer };
  };

  const find = (node: Element | null): Action | undefined => {
    for (let n = node; n; n = n.parentElement) {
      const a = actions.get(n);
      if (a) return a;
    }
    return undefined;
  };

  const focusables = (): HTMLElement[] => (modal ? [...modal.veil.querySelectorAll<HTMLElement>('button:not([hidden]),input')] : []);

  const route = (e: Event): void => {
    if (hold && (e.type === 'pointerup' || e.type === 'pointercancel' || (e.type === 'keyup' && hold.via === 'key'))) resetHold();
    if (!host || !shadow || e.target !== host) return;
    e.stopImmediatePropagation(); // events aimed at the warning never reach the page
    if (!e.isTrusted) return; // the page cannot click for the person
    switch (e.type) {
      case 'click': {
        const me = e as MouseEvent;
        const inner = me.detail === 0 ? shadow.activeElement : shadow.elementFromPoint(me.clientX, me.clientY);
        const a = find(inner);
        if (a && a.mode === 'click') a.run();
        break;
      }
      case 'pointerdown': {
        const pe = e as PointerEvent;
        if (pe.button !== 0) break;
        const a = find(shadow.elementFromPoint(pe.clientX, pe.clientY));
        if (a && a.mode === 'hold') startHold(a, 'pointer');
        break;
      }
      case 'keydown': {
        const ke = e as KeyboardEvent;
        const active = shadow.activeElement;
        if (ke.key === 'Tab' && modal) {
          const list = focusables();
          if (list.length === 0) break;
          const i = list.indexOf(active as HTMLElement);
          const next = list[(i + (ke.shiftKey ? -1 : 1) + list.length) % list.length];
          ke.preventDefault();
          next?.focus();
        } else if (ke.key === 'Escape' && modal) {
          const safe = modal.model.buttons.find((b) => (b.id === 'keep' || b.id === 'cancel') && b.style !== 'hold');
          if (safe) modal.onButton(safe.id);
        } else if (ke.key === 'Enter' || ke.key === ' ') {
          const a = find(active);
          if (a && a.mode === 'hold') {
            ke.preventDefault();
            if (!ke.repeat) startHold(a, 'key');
          } else if (ke.key === 'Enter' && modal && modal.word && active === modal.word && modal.holdAction && modal.model.friction) {
            ke.preventDefault();
            if (phraseMatches(modal.word.value, modal.model.friction.word)) modal.holdAction.run();
          }
        }
        break;
      }
      default:
        break;
    }
  };
  const attach = (): void => {
    for (const type of ['click', 'pointerdown', 'pointerup', 'pointercancel', 'keydown', 'keyup']) w.addEventListener(type, route, true);
    w.addEventListener('blur', resetHold, true);
  };
  attach();

  const closeModal = (): void => {
    if (!modal) return;
    resetHold();
    modal.io?.disconnect();
    modal.veil.remove();
    modal = null;
    topLayer();
    if (!hasContent()) teardown();
  };

  const makeButton = (b: ModelButton, run: () => void): { node: HTMLButtonElement; action: Action } => {
    const node = el('button', b.style === 'primary' ? undefined : b.style);
    node.type = 'button';
    const action: Action = { mode: b.style === 'hold' ? 'hold' : 'click', run };
    if (b.style === 'hold') {
      action.bar = el('span', 'bar');
      node.appendChild(action.bar);
      node.appendChild(el('span', 'lbl', b.label));
    } else {
      node.textContent = b.label;
    }
    actions.set(node, action);
    return { node, action };
  };

  const showModal = (model: WarningModel, onButton: (id: ButtonId, handle: ModalHandle) => void, cleared?: boolean): ModalHandle => {
    closeModal();
    ensureHost();
    const veil = el('div', `veil ${model.layout === 'dialog' ? 'dialog' : 'page'}`);
    veil.lang = model.lang;
    veil.dir = model.dir;
    const card = el('div', 'card');
    card.style.setProperty('--lvl', COLORS[model.level]);
    card.setAttribute('role', 'alertdialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-labelledby', 'ag-t');
    card.setAttribute('aria-describedby', 'ag-d');
    const head = el('div', 'head');
    head.appendChild(el('span', undefined, model.brand));
    head.appendChild(el('span', 'pill', `! ${model.levelLabel}`));
    card.appendChild(head);
    const title = el('h1', undefined, model.title);
    title.id = 'ag-t';
    card.appendChild(title);
    const desc = el('div');
    desc.id = 'ag-d';
    for (const line of model.lead) desc.appendChild(el('p', undefined, line));
    let status: HTMLElement | null = null;
    if (model.cleared !== undefined || model.notCleared !== undefined) {
      status = el('p', 'status');
      status.setAttribute('role', 'status');
      desc.appendChild(status);
    }
    card.appendChild(desc);
    for (const section of model.sections) {
      if (section.title) card.appendChild(el('h2', undefined, section.title));
      const list = el('ul');
      for (const item of section.items) list.appendChild(el('li', undefined, item));
      card.appendChild(list);
    }
    if (model.sample) {
      card.appendChild(el('h2', undefined, model.sample.title));
      const pre = el('pre', undefined, model.sample.text);
      pre.dir = 'ltr';
      card.appendChild(pre);
      if (model.sample.more) card.appendChild(el('p', 'more', model.sample.more));
    }
    const state: ModalState = { veil, model, focusFirst: null, status, clearButton: null, word: null, covered: null, holdAction: null, holdButton: null, onButton: () => undefined, visible: undefined, io: undefined };
    const handle: ModalHandle = {
      setCleared: (ok) => {
        if (state.status) state.status.textContent = (ok ? model.cleared : model.notCleared) ?? '';
        if (state.clearButton) state.clearButton.hidden = ok;
      },
      close: () => {
        if (modal === state) closeModal();
      },
      isOpen: () => modal === state,
    };
    state.onButton = (id) => onButton(id, handle);
    const row = el('div', 'row');
    for (const b of model.buttons) {
      const { node, action } = makeButton(b, () => state.onButton(b.id));
      if (b.id === 'clear') state.clearButton = node;
      if (b.style === 'hold') {
        state.holdAction = action;
        state.holdButton = node;
      } else if (!state.focusFirst && b.id !== 'clear') state.focusFirst = node;
      row.appendChild(node);
    }
    card.appendChild(row);
    if (state.holdAction && model.friction) {
      const fr = el('div', 'fr');
      fr.appendChild(el('span', undefined, model.friction.hint));
      const label = el('label', undefined, model.friction.typeLabel);
      const input = el('input');
      input.type = 'text';
      input.autocomplete = 'off';
      input.spellcheck = false;
      input.setAttribute('autocapitalize', 'off');
      label.appendChild(input);
      fr.appendChild(label);
      state.word = input;
      state.covered = el('p', 'cov', model.friction.covered);
      state.covered.hidden = true;
      state.covered.setAttribute('role', 'alert');
      fr.appendChild(state.covered);
      card.appendChild(fr);
    }
    veil.appendChild(card);
    layer?.appendChild(veil);
    modal = state;
    handle.setCleared(cleared !== false);
    topLayer();
    state.focusFirst?.focus({ preventScroll: true });
    if (state.holdButton && typeof IntersectionObserver === 'function' && 'isVisible' in IntersectionObserverEntry.prototype) {
      try {
        // "Visibility" intersection observer: tells us when other content is painted over the button.
        const options = { threshold: [1], trackVisibility: true, delay: 100 } as IntersectionObserverInit;
        state.io = new IntersectionObserver((entries) => {
          const last = entries[entries.length - 1] as (IntersectionObserverEntry & { isVisible?: boolean }) | undefined;
          if (last) state.visible = last.isIntersecting ? last.isVisible === true : undefined;
          if (state.visible !== false && state.covered) state.covered.hidden = true;
        }, options);
        state.io.observe(state.holdButton);
      } catch {
        state.visible = undefined;
      }
    }
    return handle;
  };

  const showBanner = (model: WarningModel, onButton?: (id: ButtonId) => void): void => {
    ensureHost();
    if (!banners) return;
    for (const old of [...banners.children]) if (old.getAttribute('data-kind') === model.kind) old.remove();
    while (banners.childElementCount >= 3) banners.lastElementChild?.remove();
    const box = el('div', 'banner');
    box.setAttribute('data-kind', model.kind);
    box.setAttribute('role', 'alert');
    box.lang = model.lang;
    box.dir = model.dir;
    box.style.setProperty('--lvl', COLORS[model.level]);
    box.appendChild(el('span', 'pill', `! ${model.levelLabel}`));
    const txt = el('div', 'txt');
    txt.appendChild(el('strong', undefined, `${model.brand}: ${model.title}`));
    for (const line of model.lead) txt.appendChild(el('p', undefined, line));
    const items = model.sections.flatMap((s) => s.items).slice(0, 4);
    if (items.length > 0) {
      const list = el('ul');
      for (const item of items) list.appendChild(el('li', undefined, item));
      txt.appendChild(list);
    }
    box.appendChild(txt);
    for (const b of model.buttons) {
      if (b.style === 'hold') continue;
      const { node } = makeButton(b, () => {
        box.remove();
        if (!hasContent()) teardown();
        onButton?.(b.id);
      });
      box.appendChild(node);
    }
    banners.prepend(box);
  };

  return {
    owns: (e) => host !== null && e.target === host,
    // Drawing can fail on unusual documents. The protective step has always been taken before a
    // warning is drawn, so a drawing failure must never turn into an error in the caller.
    modal: (model, onButton, cleared) => {
      try {
        return showModal(model, onButton, cleared);
      } catch {
        return { setCleared: () => undefined, close: () => undefined, isOpen: () => false };
      }
    },
    banner: (model, onButton) => {
      try {
        showBanner(model, onButton);
      } catch {
        // nothing to show
      }
    },
    modalOpen: () => modal !== null,
    reattach: attach,
  };
}
