// Copyright 2026 The ActionGuard Authors
// SPDX-License-Identifier: Apache-2.0
//
// Helpers shared by the popup, the options page and the download prompt.

import type { StateReply } from '../background/core.ts';
import { HOLD_MS, holdComplete, holdStart, type HoldState } from '../shared/friction.ts';
import { makeTranslate, type Translate } from '../shared/i18n.ts';
import type { PageRequest } from '../shared/protocol.ts';

/** Ask the service worker. Null when it cannot be reached. */
export async function send<T>(req: PageRequest): Promise<T | null> {
  try {
    const reply = await chrome.runtime.sendMessage(req);
    return typeof reply === 'object' && reply !== null ? (reply as T) : null;
  } catch {
    return null;
  }
}

export interface Loaded {
  state: StateReply;
  t: Translate;
}

export async function loadState(url = ''): Promise<Loaded | null> {
  const state = await send<StateReply>({ type: 'get-state', url });
  if (!state || state.ok !== true) return null;
  return { state, t: makeTranslate(state.messages, state.messages, state.dir) };
}

/** Fill in every element marked with `data-i18n` (text) or `data-i18n-label` (accessible name). */
export function applyI18n(root: ParentNode, t: Translate, lang: string, dir: 'ltr' | 'rtl'): void {
  document.documentElement.lang = lang;
  document.documentElement.dir = dir;
  for (const node of root.querySelectorAll<HTMLElement>('[data-i18n]')) node.textContent = t(node.dataset['i18n'] ?? '');
  for (const node of root.querySelectorAll<HTMLElement>('[data-i18n-label]')) node.setAttribute('aria-label', t(node.dataset['i18nLabel'] ?? ''));
}

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

/**
 * Turn a button into a press-and-hold control (pointer, Space or Enter).
 * The action runs only after the button has been held for the full time.
 */
export function holdButton(button: HTMLButtonElement, onConfirm: () => void): void {
  const bar = el('span', undefined, 'bar');
  button.prepend(bar);
  button.classList.add('hold');
  let state: HoldState | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const reset = (): void => {
    state = null;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    bar.style.transition = 'none';
    bar.style.width = '0';
  };
  const start = (e: Event): void => {
    if (!e.isTrusted || button.disabled) return;
    reset();
    state = holdStart(performance.now(), true);
    bar.style.transition = `width ${HOLD_MS}ms linear`;
    bar.style.width = '100%';
    timer = setTimeout(() => {
      const done = state !== null && holdComplete(state, performance.now() + 30);
      reset();
      if (done) onConfirm();
    }, HOLD_MS);
  };
  button.addEventListener('pointerdown', (e) => {
    if (e.button === 0) start(e);
  });
  button.addEventListener('keydown', (e) => {
    if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) {
      e.preventDefault();
      start(e);
    }
  });
  for (const type of ['pointerup', 'pointerleave', 'pointercancel', 'keyup', 'blur']) button.addEventListener(type, reset);
}

/** A date and time in the chosen language. */
export function formatTime(ms: number, locale: string): string {
  try {
    return new Date(ms).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return new Date(ms).toISOString();
  }
}
