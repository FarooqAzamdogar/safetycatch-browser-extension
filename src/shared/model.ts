// Copyright 2026 The SafetyCatch Authors
// SPDX-License-Identifier: Apache-2.0

/**
 * The "view model" of a warning. The service worker builds it (already
 * translated); content scripts and extension pages only render it with
 * `textContent`. Keeping all wording in the service worker keeps the content
 * script small and lets the language setting apply everywhere.
 */

import { isLevel, type RiskLevel } from './levels.ts';
import { isModuleId, type ModuleId } from './modules.ts';
import { clip } from './text.ts';

const WARNING_KINDS = ['paste-block', 'paste-notice', 'unchecked', 'login', 'login-banner', 'auth', 'auth-banner', 'lure', 'ai-paste', 'ai-unchecked', 'download', 'info'] as const;
type WarningKind = (typeof WARNING_KINDS)[number];

export const BUTTON_IDS = ['keep', 'clear', 'restore', 'leave', 'stay', 'continue', 'ok', 'redact', 'anyway', 'cancel', 'paste', 'resume', 'delete'] as const;
export type ButtonId = (typeof BUTTON_IDS)[number];

export interface ModelButton {
  id: ButtonId;
  label: string;
  /** `hold` = press-and-hold (or type the word) before it acts. */
  style: 'primary' | 'secondary' | 'hold';
}

export interface ModelSection {
  title: string;
  items: string[];
}

export interface WarningModel {
  kind: WarningKind;
  /** `page` covers the whole page, `dialog` is a centred box, `banner` sits at the top and does not block the page. */
  layout: 'page' | 'banner' | 'dialog';
  module: ModuleId;
  level: RiskLevel;
  levelLabel: string;
  lang: string;
  dir: 'ltr' | 'rtl';
  brand: string;
  title: string;
  lead: string[];
  /** Paste warnings: which line to show depending on whether the clipboard could be cleared. */
  cleared?: string;
  notCleared?: string;
  sections: ModelSection[];
  /** The copied text, already made safe for display. Rendered left-to-right in a non-selectable box. */
  sample?: { title: string; text: string; more: string };
  buttons: ModelButton[];
  /** Wording for hold buttons. */
  friction?: { hint: string; typeLabel: string; word: string; covered: string };
  ruleIds: string[];
}

const str = (v: unknown, max: number): string => (typeof v === 'string' ? clip(v, max) : '');
const strList = (v: unknown, maxItems: number, max: number): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, maxItems).map((x) => clip(x, max)) : [];

/**
 * Validate and cap a model that arrived in a message. Returns null when it is
 * not a model at all. Defence in depth: the sender is our own service worker.
 */
export function parseModel(raw: unknown): WarningModel | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (!(WARNING_KINDS as readonly unknown[]).includes(r['kind'])) return null;
  if (r['layout'] !== 'page' && r['layout'] !== 'banner' && r['layout'] !== 'dialog') return null;
  if (!isModuleId(r['module']) || !isLevel(r['level'])) return null;
  const buttons: ModelButton[] = [];
  if (Array.isArray(r['buttons'])) {
    for (const b of r['buttons'].slice(0, 4)) {
      if (typeof b !== 'object' || b === null) continue;
      const x = b as Record<string, unknown>;
      if (!(BUTTON_IDS as readonly unknown[]).includes(x['id'])) continue;
      const style = x['style'] === 'hold' || x['style'] === 'secondary' ? x['style'] : 'primary';
      buttons.push({ id: x['id'] as ButtonId, label: str(x['label'], 120), style });
    }
  }
  if (buttons.length === 0) return null;
  const sections: ModelSection[] = [];
  if (Array.isArray(r['sections'])) {
    for (const s of r['sections'].slice(0, 5)) {
      if (typeof s !== 'object' || s === null) continue;
      const x = s as Record<string, unknown>;
      const items = strList(x['items'], 12, 500);
      if (items.length > 0) sections.push({ title: str(x['title'], 120), items });
    }
  }
  const model: WarningModel = {
    kind: r['kind'] as WarningKind,
    layout: r['layout'],
    module: r['module'],
    level: r['level'],
    levelLabel: str(r['levelLabel'], 60),
    lang: /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/.test(str(r['lang'], 12)) ? str(r['lang'], 12) : 'en',
    dir: r['dir'] === 'rtl' ? 'rtl' : 'ltr',
    brand: str(r['brand'], 40),
    title: str(r['title'], 200),
    lead: strList(r['lead'], 5, 600),
    sections,
    buttons,
    ruleIds: strList(r['ruleIds'], 8, 64),
  };
  if (typeof r['cleared'] === 'string') model.cleared = str(r['cleared'], 400);
  if (typeof r['notCleared'] === 'string') model.notCleared = str(r['notCleared'], 400);
  if (typeof r['sample'] === 'object' && r['sample'] !== null) {
    const s = r['sample'] as Record<string, unknown>;
    model.sample = { title: str(s['title'], 160), text: str(s['text'], 1200), more: str(s['more'], 120) };
  }
  if (typeof r['friction'] === 'object' && r['friction'] !== null) {
    const f = r['friction'] as Record<string, unknown>;
    const word = str(f['word'], 30);
    if (word.trim().length > 0) model.friction = { hint: str(f['hint'], 120), typeLabel: str(f['typeLabel'], 200), word, covered: str(f['covered'], 300) };
  }
  if (buttons.some((b) => b.style === 'hold') && !model.friction) return null;
  return model;
}
