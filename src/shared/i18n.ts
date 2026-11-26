// Copyright 2026 The SafetyCatch Authors
// SPDX-License-Identifier: Apache-2.0

/**
 * Message catalogs for the extension's own wording. The source of truth is
 * `_locales/<folder>/messages.json` (the browser's standard format), which the
 * browser uses for the manifest and which we load ourselves so the language
 * chosen on the options page applies to every warning. Placeholders are
 * written as `{name}`.
 */

/** Languages with a catalog. English is the source; the others are machine translations awaiting native review. */
export const UI_LOCALES = ['en', 'es', 'fr', 'pt', 'ar', 'hi', 'ur', 'id'] as const;
export type UiLocale = (typeof UI_LOCALES)[number];

export const RTL_LOCALES: readonly string[] = ['ar', 'ur'];

/** Locale folders inside `_locales`. Browsers have no plain `pt` folder, so Portuguese ships twice. */
export const LOCALE_FOLDERS: Readonly<Record<UiLocale, readonly string[]>> = {
  en: ['en'],
  es: ['es'],
  fr: ['fr'],
  pt: ['pt_BR', 'pt_PT'],
  ar: ['ar'],
  hi: ['hi'],
  ur: ['ur'],
  id: ['id'],
};

export type Catalog = Readonly<Record<string, string>>;

function isUiLocale(value: unknown): value is UiLocale {
  return typeof value === 'string' && (UI_LOCALES as readonly string[]).includes(value);
}

/** Choose the catalog language: the setting if it names one, otherwise the browser language, otherwise English. */
export function pickLocale(setting: unknown, browserLanguage: unknown): UiLocale {
  if (isUiLocale(setting)) return setting;
  const tag = typeof browserLanguage === 'string' ? browserLanguage.toLowerCase().replace('_', '-') : '';
  const primary = tag.split('-')[0] ?? '';
  return isUiLocale(primary) ? primary : 'en';
}

export function localeDir(locale: string): 'ltr' | 'rtl' {
  return RTL_LOCALES.includes(locale) ? 'rtl' : 'ltr';
}

export function localeFolder(locale: UiLocale): string {
  return LOCALE_FOLDERS[locale][0] as string;
}

/** Read a browser-format `messages.json` object into a flat catalog. Anything malformed is skipped. */
export function parseMessages(raw: unknown): Catalog {
  const out: Record<string, string> = {};
  if (typeof raw !== 'object' || raw === null) return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'object' && value !== null && typeof (value as Record<string, unknown>)['message'] === 'string') {
      out[key] = (value as Record<string, string>)['message'] as string;
    }
  }
  return out;
}

/** First-strong isolate and pop-directional-isolate, built from code points so the file holds no invisible characters. */
const FSI = String.fromCharCode(0x2068);
const PDI = String.fromCharCode(0x2069);

export type Translate = (key: string, params?: Readonly<Record<string, string | number>>) => string;

/**
 * Build a translate function. Missing keys fall back to English, then to the
 * key itself (so a gap is visible instead of silent). Interpolated values are
 * wrapped in Unicode isolates in right-to-left languages so a domain or file
 * name cannot reorder the sentence around it.
 */
export function makeTranslate(catalog: Catalog, english: Catalog, dir: 'ltr' | 'rtl' = 'ltr'): Translate {
  return (key, params) => {
    const template = catalog[key] ?? english[key] ?? key;
    if (!params) return template;
    return template.replace(/\{([a-z][a-zA-Z0-9]{0,30})\}/g, (whole, name: string) => {
      const value = params[name];
      if (value === undefined) return whole;
      const text = String(value);
      return dir === 'rtl' ? FSI + text + PDI : text;
    });
  };
}

/** Placeholder names used in a message, sorted (for catalog consistency tests). */
export function placeholdersOf(message: string): string[] {
  const names = new Set<string>();
  for (const m of message.matchAll(/\{([a-z][a-zA-Z0-9]{0,30})\}/g)) names.add(m[1] as string);
  return [...names].sort();
}
