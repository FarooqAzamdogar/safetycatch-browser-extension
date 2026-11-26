// Copyright 2026 The ActionGuard Authors
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { SUPPORTED_LOCALES } from 'actionguard-engine';
import { LOCALE_FOLDERS, localeDir, localeFolder, makeTranslate, parseMessages, pickLocale, placeholdersOf, RTL_LOCALES, UI_LOCALES } from '../src/shared/i18n.ts';
import { LANGUAGE_CHOICES } from '../src/shared/settings.ts';
import { localeFolders, localeNote, messagesJson, readLocale } from '../scripts/locales.ts';

const english = readLocale('en');
const keys = Object.keys(english);

test('the UI languages are exactly the engine\'s languages', () => {
  assert.deepEqual([...UI_LOCALES].sort(), [...SUPPORTED_LOCALES].sort());
  assert.deepEqual([...LANGUAGE_CHOICES], ['auto', ...UI_LOCALES]);
});

test('every catalog has exactly the English keys', () => {
  for (const locale of UI_LOCALES) {
    assert.deepEqual(Object.keys(readLocale(locale)).sort(), [...keys].sort(), locale);
  }
});

test('every translation keeps the placeholders of the English message', () => {
  for (const locale of UI_LOCALES) {
    const catalog = readLocale(locale);
    for (const key of keys) assert.deepEqual(placeholdersOf(catalog[key] as string), placeholdersOf(english[key] as string), `${locale}.${key}`);
  }
});

test('no message is empty, uses "$" (special to the browser) or carries markup', () => {
  for (const locale of UI_LOCALES) {
    for (const [key, message] of Object.entries(readLocale(locale))) {
      assert.ok(message.trim().length > 0, `${locale}.${key} is empty`);
      assert.equal(message.includes('$'), false, `${locale}.${key} contains $`);
      assert.equal(/<[a-z/]/i.test(message), false, `${locale}.${key} contains markup`);
    }
  }
});

test('translations are flagged as machine translations; English is the source', () => {
  assert.equal(localeNote('en'), '');
  for (const locale of UI_LOCALES) if (locale !== 'en') assert.match(localeNote(locale), /machine translation, needs native review/, locale);
});

test('translated catalogs are really translated (not copies of English)', () => {
  const same = new Set(['extName', 'brand', 'dur_hour', 'dur_day', 'dur_month']);
  for (const locale of UI_LOCALES) {
    if (locale === 'en') continue;
    const catalog = readLocale(locale);
    const copied = keys.filter((k) => !same.has(k) && catalog[k] === english[k]);
    assert.ok(copied.length <= 3, `${locale} has untranslated keys: ${copied.join(', ')}`);
  }
});

test('each catalog states its own language and direction', () => {
  for (const locale of UI_LOCALES) {
    const catalog = readLocale(locale);
    assert.equal(catalog['ui_lang'], locale);
    assert.equal(catalog['ui_dir'], RTL_LOCALES.includes(locale) ? 'rtl' : 'ltr');
    assert.ok((catalog['confirm_word'] as string).trim().length >= 3 && !/\s/.test((catalog['confirm_word'] as string).trim()), `${locale} confirm word`);
  }
});

test('store limits: name up to 75 characters, description up to 132', () => {
  for (const locale of UI_LOCALES) {
    const catalog = readLocale(locale);
    assert.ok((catalog['extName'] as string).length <= 75, locale);
    assert.ok((catalog['extDescription'] as string).length <= 132, `${locale} description is ${(catalog['extDescription'] as string).length} characters`);
  }
});

test('every key used in the source code exists in the catalog, and every catalog key is used', () => {
  const walk = (dir: URL): URL[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(new URL(`${e.name}/`, dir)) : [new URL(e.name, dir)]));
  const source = walk(new URL('../src/', import.meta.url))
    .filter((u) => /\.(ts|html)$/.test(u.pathname) && !u.pathname.includes('/locales/'))
    .map((u) => readFileSync(u, 'utf8'))
    .join('\n');
  const used = new Set<string>();
  for (const m of source.matchAll(/\b(?:t|local|getMessage)\(\s*(?:`|')([a-zA-Z_]+)(?:`|')/g)) used.add(m[1] as string);
  for (const m of source.matchAll(/data-i18n(?:-label)?="([a-zA-Z_0-9]+)"/g)) used.add(m[1] as string);
  for (const m of source.matchAll(/'((?:paste|login|device|oauth|lure|ai|dl|level|scope|trust|btn|opt|unchecked)_[a-zA-Z0-9_]+)'/g)) used.add(m[1] as string);
  const dynamic = keys.filter((k) => /^(mod|dur)_/.test(k) || ['extName', 'extDescription', 'ui_lang', 'ui_dir', 'lang_auto'].includes(k));
  for (const key of used) assert.ok(key in english, `source uses "${key}" but the catalog has no such key`);
  for (const key of keys) assert.ok(used.has(key) || dynamic.includes(key), `catalog key "${key}" is not used anywhere`);
});

test('browser-format catalogs: one folder per language, Portuguese twice, all complete', () => {
  const folders = localeFolders();
  assert.deepEqual(folders.map((f) => f.folder).sort(), ['ar', 'en', 'es', 'fr', 'hi', 'id', 'pt_BR', 'pt_PT', 'ur']);
  for (const { locale } of folders) {
    const json = messagesJson(locale);
    assert.deepEqual(Object.keys(json).sort(), [...keys].sort());
    for (const entry of Object.values(json)) assert.equal(typeof entry.message, 'string');
    assert.equal('_note' in json, false);
  }
  assert.equal(localeFolder('pt'), 'pt_BR');
  assert.deepEqual(LOCALE_FOLDERS.pt, ['pt_BR', 'pt_PT']);
});

test('parseMessages reads the browser format and skips anything malformed', () => {
  assert.deepEqual(parseMessages({ a: { message: 'A' }, b: { message: 5 }, c: 'x', d: null, e: { description: 'no message' } }), { a: 'A' });
  assert.deepEqual(parseMessages(null), {});
  assert.deepEqual(parseMessages(messagesJson('fr'))['btn_cancel'], 'Annuler');
});

test('pickLocale: the setting wins, then the browser language, then English', () => {
  assert.equal(pickLocale('ur', 'en-US'), 'ur');
  assert.equal(pickLocale('auto', 'pt-BR'), 'pt');
  assert.equal(pickLocale('auto', 'pt_PT'), 'pt');
  assert.equal(pickLocale('auto', 'AR'), 'ar');
  assert.equal(pickLocale('auto', 'de-DE'), 'en');
  assert.equal(pickLocale('klingon', 'fr'), 'fr');
  assert.equal(pickLocale(undefined, undefined), 'en');
  assert.equal(localeDir('ar'), 'rtl');
  assert.equal(localeDir('ur'), 'rtl');
  assert.equal(localeDir('hi'), 'ltr');
});

test('translate: fills placeholders, falls back to English, shows the key when nothing exists', () => {
  const t = makeTranslate({ hello: 'Bonjour {name}' }, { hello: 'Hello {name}', bye: 'Bye {name}' });
  assert.equal(t('hello', { name: 'Sam' }), 'Bonjour Sam');
  assert.equal(t('bye', { name: 'Sam' }), 'Bye Sam');
  assert.equal(t('missing_key'), 'missing_key');
  assert.equal(t('hello'), 'Bonjour {name}');
  assert.equal(t('hello', { other: 'x' }), 'Bonjour {name}');
  assert.equal(t('hello', { name: 42 }), 'Bonjour 42');
});

test('translate: in right-to-left languages inserted values are isolated so they cannot reorder the sentence', () => {
  const t = makeTranslate({ from: 'from {site} now' }, {}, 'rtl');
  const out = t('from', { site: 'evil.example' });
  assert.equal(out.codePointAt(5), 0x2068);
  assert.equal(out.codePointAt(5 + 1 + 'evil.example'.length), 0x2069);
  assert.equal(makeTranslate({ from: 'from {site}' }, {}, 'ltr')('from', { site: 'a.example' }), 'from a.example');
});

test('a value containing braces is inserted as text, not expanded again', () => {
  const t = makeTranslate({ m: 'A {a} B {b}' }, {});
  assert.equal(t('m', { a: '{b}', b: 'x' }), 'A {b} B x');
});
