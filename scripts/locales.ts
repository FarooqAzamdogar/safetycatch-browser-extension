// Copyright 2026 The ActionGuard Authors
// SPDX-License-Identifier: Apache-2.0
//
// Turns the flat catalogs in src/locales/<locale>.json into the browser's
// `_locales/<folder>/messages.json` format. English fills any gap so every
// shipped catalog is complete. Used by the build and by the tests.

import { readFileSync } from 'node:fs';
import { LOCALE_FOLDERS, UI_LOCALES, type UiLocale } from '../src/shared/i18n.ts';

const SOURCE = new URL('../src/locales/', import.meta.url);

/** The flat catalog for one locale, without bookkeeping keys (those start with "_"). */
export function readLocale(locale: UiLocale): Record<string, string> {
  const raw = JSON.parse(readFileSync(new URL(`${locale}.json`, SOURCE), 'utf8')) as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) if (!key.startsWith('_') && typeof value === 'string') out[key] = value;
  return out;
}

/** The translation note of a locale file (`_note`), if any. */
export function localeNote(locale: UiLocale): string {
  const raw = JSON.parse(readFileSync(new URL(`${locale}.json`, SOURCE), 'utf8')) as Record<string, unknown>;
  return typeof raw['_note'] === 'string' ? raw['_note'] : '';
}

/** Browser-format catalog for one locale, completed with English. */
export function messagesJson(locale: UiLocale): Record<string, { message: string }> {
  const english = readLocale('en');
  const own = locale === 'en' ? english : readLocale(locale);
  const out: Record<string, { message: string }> = {};
  for (const key of Object.keys(english)) out[key] = { message: own[key] ?? (english[key] as string) };
  return out;
}

/** Every `_locales` folder to write, with the locale it comes from. */
export function localeFolders(): Array<{ folder: string; locale: UiLocale }> {
  return UI_LOCALES.flatMap((locale) => LOCALE_FOLDERS[locale].map((folder) => ({ folder, locale })));
}
