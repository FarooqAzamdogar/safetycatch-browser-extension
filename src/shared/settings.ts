// Copyright 2026 The SafetyCatch Authors
// SPDX-License-Identifier: Apache-2.0

import { sanitizeTrustList, type TrustEntry } from './allowlist.ts';
import { MODULE_IDS, type ModuleId } from './modules.ts';
import { formatSitePattern, parseSitePattern } from './sites.ts';

const SETTINGS_VERSION = 1;
export const SETTINGS_KEY = 'settings';

/** `auto` follows the browser language. */
export const LANGUAGE_CHOICES = ['auto', 'en', 'es', 'fr', 'pt', 'ar', 'hi', 'ur', 'id'] as const;

/** AI chat sites where pasted text is checked for secrets. Editable on the options page. */
export const DEFAULT_AI_SITES: readonly string[] = [
  'chatgpt.com',
  'claude.ai',
  'gemini.google.com',
  'copilot.microsoft.com',
  'perplexity.ai',
  'chat.deepseek.com',
  'grok.com',
  'poe.com',
  'chat.mistral.ai',
  'huggingface.co/chat',
  'meta.ai',
];

export const MAX_AI_SITES = 100;
export const MAX_IMPORT_CHARS = 200_000;
export const EXPORT_APP = 'safetycatch-browser-extension';

export interface Settings {
  version: 1;
  modules: Record<ModuleId, boolean>;
  aiSites: string[];
  language: string;
  allowlist: TrustEntry[];
}

export function defaultSettings(): Settings {
  const modules = {} as Record<ModuleId, boolean>;
  for (const id of MODULE_IDS) modules[id] = true;
  return { version: SETTINGS_VERSION, modules, aiSites: [...DEFAULT_AI_SITES], language: 'auto', allowlist: [] };
}

/** Normalise, de-duplicate and cap a list of AI-chat sites. Anything that is not an array gives the defaults. */
export function sanitizeAiSites(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [...DEFAULT_AI_SITES];
  const out: string[] = [];
  for (const item of raw.slice(0, MAX_AI_SITES * 3)) {
    const p = parseSitePattern(item);
    if (!p) continue;
    const s = formatSitePattern(p);
    if (!out.includes(s)) out.push(s);
    if (out.length >= MAX_AI_SITES) break;
  }
  return out;
}

/**
 * Build a valid settings object from anything (storage contents, an imported
 * file). Unknown fields are dropped, wrong types fall back to the defaults,
 * and protections default to ON so damaged storage never silently disables them.
 */
export function sanitizeSettings(raw: unknown, now: number): Settings {
  const base = defaultSettings();
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return base;
  const r = raw as Record<string, unknown>;
  const mods = typeof r['modules'] === 'object' && r['modules'] !== null ? (r['modules'] as Record<string, unknown>) : {};
  for (const id of MODULE_IDS) if (mods[id] === false) base.modules[id] = false;
  if ('aiSites' in r) base.aiSites = sanitizeAiSites(r['aiSites']);
  if (typeof r['language'] === 'string' && (LANGUAGE_CHOICES as readonly string[]).includes(r['language'])) base.language = r['language'];
  base.allowlist = sanitizeTrustList(r['allowlist'], now);
  return base;
}

/** Serialise settings for the "Export settings" button. Contains no history and no page data. */
export function exportSettings(settings: Settings, now: number): string {
  return JSON.stringify({ app: EXPORT_APP, format: SETTINGS_VERSION, exportedAt: new Date(now).toISOString(), settings }, null, 2);
}

export type ImportResult = { ok: true; settings: Settings } | { ok: false; error: 'too-large' | 'not-json' | 'wrong-format' };

/** Parse an exported file. The content is treated as hostile and passed through {@link sanitizeSettings}. */
export function importSettings(json: unknown, now: number): ImportResult {
  if (typeof json !== 'string') return { ok: false, error: 'wrong-format' };
  if (json.length > MAX_IMPORT_CHARS) return { ok: false, error: 'too-large' };
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return { ok: false, error: 'not-json' };
  }
  if (typeof data !== 'object' || data === null) return { ok: false, error: 'wrong-format' };
  const d = data as Record<string, unknown>;
  if (d['app'] !== EXPORT_APP || typeof d['settings'] !== 'object' || d['settings'] === null) return { ok: false, error: 'wrong-format' };
  return { ok: true, settings: sanitizeSettings(d['settings'], now) };
}
