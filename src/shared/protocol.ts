// Copyright 2026 The SafetyCatch Authors
// SPDX-License-Identifier: Apache-2.0

/**
 * Messages between content scripts / extension pages and the service worker.
 * Every message is validated on arrival: content scripts run inside web pages
 * and are the less trusted side. Text is capped here, before it reaches the
 * engine. Requests that change settings are only accepted from extension pages
 * (the service worker checks the sender, see background/service-worker.ts).
 */

import { PASTE_SOURCES, type AiPasteAction, type LoginUi, type LureUi, type PasteAction, type PasteSource } from './decisions.ts';
import { cleanRuleIds, isHistoryAction, type HistoryAction } from './history.ts';
import { isLevel, type RiskLevel } from './levels.ts';
import { isModuleId, type ModuleId } from './modules.ts';
import { clip } from './text.ts';

export const LIMITS = {
  /** Same cap as the engine (`MAX_INPUT_CHARS`). */
  text: 100_000,
  pageText: 20_000,
  loginText: 5_000,
  title: 300,
  url: 2_000,
  settingsJson: 200_000,
} as const;

export type ContentRequest =
  | { type: 'check-clipboard'; text: string; pageText: string; source: PasteSource; tampered: boolean }
  | { type: 'check-login'; title: string; pageText: string; referrer: string }
  | { type: 'check-auth'; referrer: string }
  | { type: 'check-page'; pageText: string }
  | { type: 'check-secrets'; text: string }
  | { type: 'report'; module: ModuleId; action: HistoryAction; level: RiskLevel; ruleIds: string[] }
  | { type: 'ack'; scope: 'auth' | 'login' }
  | { type: 'leave' };

export type DownloadChoice = 'resume' | 'cancel' | 'delete' | 'keep';

export type PageRequest =
  | { type: 'get-state'; url: string }
  | { type: 'set-settings'; settings: unknown }
  | { type: 'set-module'; module: ModuleId; enabled: boolean }
  | { type: 'add-trust'; pattern: string; duration: string }
  | { type: 'remove-trust'; pattern: string }
  | { type: 'clear-history' }
  | { type: 'import-settings'; json: string }
  | { type: 'download-info'; id: number }
  | { type: 'download-choice'; id: number; choice: DownloadChoice };

/** Replies to content scripts. `model` is a {@link WarningModel}; the receiver re-validates it with `parseModel`. */
export interface ClipboardReply {
  action: PasteAction;
  model?: unknown;
  /** The harmless line that replaces a blocked clipboard. */
  note?: string;
  /** True when the warning was handed to the top frame of the tab (the request came from a sub-frame). */
  shownInTop?: boolean;
}
export interface LoginReply {
  ui: LoginUi;
  /** Full-page warning shown when the person goes to type a password. */
  model?: unknown;
  /** Banner shown straight away. */
  banner?: unknown;
}
export interface AuthReply {
  ui: 'none' | 'banner' | 'interstitial';
  model?: unknown;
}
export interface PageReply {
  ui: LureUi;
  model?: unknown;
}
export interface SecretsReply {
  action: AiPasteAction;
  redacted?: string;
  model?: unknown;
}

/** Service worker to the top frame of a tab: show a warning that a sub-frame triggered. */
export interface ShowPush {
  type: 'show';
  model: unknown;
  text: string;
  note: string;
}

const s = (v: unknown, max: number): string => (typeof v === 'string' ? clip(v, max) : '');

/** Validate a message from a content script. Returns null for anything unexpected. */
export function parseContentRequest(raw: unknown): ContentRequest | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  switch (r['type']) {
    case 'check-clipboard': {
      if (typeof r['text'] !== 'string') return null;
      const source = (PASTE_SOURCES as readonly unknown[]).includes(r['source']) ? (r['source'] as PasteSource) : 'programmatic';
      return { type: 'check-clipboard', text: clip(r['text'], LIMITS.text), pageText: s(r['pageText'], LIMITS.pageText), source, tampered: r['tampered'] === true };
    }
    case 'check-login':
      return { type: 'check-login', title: s(r['title'], LIMITS.title), pageText: s(r['pageText'], LIMITS.loginText), referrer: s(r['referrer'], LIMITS.url) };
    case 'check-auth':
      return { type: 'check-auth', referrer: s(r['referrer'], LIMITS.url) };
    case 'check-page':
      if (typeof r['pageText'] !== 'string') return null;
      return { type: 'check-page', pageText: clip(r['pageText'], LIMITS.pageText) };
    case 'check-secrets':
      if (typeof r['text'] !== 'string') return null;
      return { type: 'check-secrets', text: clip(r['text'], LIMITS.text) };
    case 'report':
      if (!isModuleId(r['module']) || !isHistoryAction(r['action']) || !isLevel(r['level'])) return null;
      return { type: 'report', module: r['module'], action: r['action'], level: r['level'], ruleIds: cleanRuleIds(r['ruleIds']) };
    case 'ack':
      return r['scope'] === 'auth' || r['scope'] === 'login' ? { type: 'ack', scope: r['scope'] } : null;
    case 'leave':
      return { type: 'leave' };
    default:
      return null;
  }
}

const isId = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < 2 ** 31;

/** Validate a message from the popup, the options page or the download prompt. */
export function parsePageRequest(raw: unknown): PageRequest | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  switch (r['type']) {
    case 'get-state':
      return { type: 'get-state', url: s(r['url'], LIMITS.url) };
    case 'set-settings':
      return typeof r['settings'] === 'object' && r['settings'] !== null ? { type: 'set-settings', settings: r['settings'] } : null;
    case 'set-module':
      return isModuleId(r['module']) && typeof r['enabled'] === 'boolean' ? { type: 'set-module', module: r['module'], enabled: r['enabled'] } : null;
    case 'add-trust':
      return typeof r['pattern'] === 'string' && typeof r['duration'] === 'string' ? { type: 'add-trust', pattern: clip(r['pattern'], 300), duration: clip(r['duration'], 20) } : null;
    case 'remove-trust':
      return typeof r['pattern'] === 'string' ? { type: 'remove-trust', pattern: clip(r['pattern'], 300) } : null;
    case 'clear-history':
      return { type: 'clear-history' };
    case 'import-settings':
      return typeof r['json'] === 'string' && r['json'].length <= LIMITS.settingsJson ? { type: 'import-settings', json: r['json'] } : null;
    case 'download-info':
      return isId(r['id']) ? { type: 'download-info', id: r['id'] } : null;
    case 'download-choice': {
      const c = r['choice'];
      return isId(r['id']) && (c === 'resume' || c === 'cancel' || c === 'delete' || c === 'keep') ? { type: 'download-choice', id: r['id'], choice: c } : null;
    }
    default:
      return null;
  }
}

/** Names of the request types a content script may send. Everything else needs an extension page as sender. */
export const CONTENT_TYPES: readonly string[] = ['check-clipboard', 'check-login', 'check-auth', 'check-page', 'check-secrets', 'report', 'ack', 'leave'];

export function isContentType(raw: unknown): boolean {
  return typeof raw === 'object' && raw !== null && CONTENT_TYPES.includes((raw as Record<string, unknown>)['type'] as string);
}
