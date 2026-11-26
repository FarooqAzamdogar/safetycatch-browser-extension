// Copyright 2026 The SafetyCatch Authors
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addEntry, cleanRuleIds, HISTORY_CAP, makeEntry, MAX_RULE_IDS, sanitizeHistory, type HistoryEntry } from '../src/shared/history.ts';
import { MODULE_IDS } from '../src/shared/modules.ts';
import { DEFAULT_AI_SITES, defaultSettings, EXPORT_APP, exportSettings, importSettings, MAX_AI_SITES, MAX_IMPORT_CHARS, sanitizeAiSites, sanitizeSettings } from '../src/shared/settings.ts';

const NOW = 1_800_000_000_000;

test('settings: every protection is on by default and the AI list has the eleven documented sites', () => {
  const s = defaultSettings();
  for (const id of MODULE_IDS) assert.equal(s.modules[id], true);
  assert.deepEqual(s.aiSites, ['chatgpt.com', 'claude.ai', 'gemini.google.com', 'copilot.microsoft.com', 'perplexity.ai', 'chat.deepseek.com', 'grok.com', 'poe.com', 'chat.mistral.ai', 'huggingface.co/chat', 'meta.ai']);
  assert.equal(s.language, 'auto');
  assert.deepEqual(s.allowlist, []);
});

test('settings: garbage in storage gives the defaults (protection stays on)', () => {
  for (const raw of [undefined, null, 'x', 7, [], { modules: 'no' }, { modules: { pasteGuard: 'false' } }]) {
    assert.deepEqual(sanitizeSettings(raw, NOW).modules, defaultSettings().modules);
  }
});

test('settings: only an explicit false switches a protection off', () => {
  const s = sanitizeSettings({ modules: { pasteGuard: false, aiPaste: 0, downloads: null, bogus: false } }, NOW);
  assert.equal(s.modules.pasteGuard, false);
  assert.equal(s.modules.aiPaste, true);
  assert.equal(s.modules.downloads, true);
  assert.equal('bogus' in s.modules, false);
});

test('settings: unknown fields are dropped and the language must be a known choice', () => {
  const s = sanitizeSettings({ language: 'ur', extra: 'x', version: 99 }, NOW);
  assert.equal(s.language, 'ur');
  assert.equal(s.version, 1);
  assert.equal('extra' in s, false);
  assert.equal(sanitizeSettings({ language: 'tlh' }, NOW).language, 'auto');
  assert.equal(sanitizeSettings({ language: 5 }, NOW).language, 'auto');
});

test('settings: AI sites are normalised, de-duplicated and capped', () => {
  assert.deepEqual(sanitizeAiSites(['ChatGPT.com', 'https://chatgpt.com/', 'huggingface.co/chat/', 'not a host', 5, 'localhost']), ['chatgpt.com', 'huggingface.co/chat', 'localhost']);
  assert.deepEqual(sanitizeAiSites('chatgpt.com'), [...DEFAULT_AI_SITES]);
  assert.deepEqual(sanitizeAiSites([]), []);
  const many = Array.from({ length: 500 }, (_, i) => `ai${i}.example`);
  assert.equal(sanitizeAiSites(many).length, MAX_AI_SITES);
});

test('settings: an empty AI list is kept (the person removed every site)', () => {
  assert.deepEqual(sanitizeSettings({ aiSites: [] }, NOW).aiSites, []);
  assert.deepEqual(sanitizeSettings({}, NOW).aiSites, [...DEFAULT_AI_SITES]);
});

test('settings: the allowlist inside settings is sanitised too', () => {
  const s = sanitizeSettings({ allowlist: [{ pattern: 'example.com', addedAt: 1, expiresAt: null }, { pattern: '*.com' }, { pattern: 'old.example', expiresAt: 5 }] }, NOW);
  assert.deepEqual(s.allowlist, [{ pattern: 'example.com', addedAt: 1, expiresAt: null }]);
});

test('settings: export then import gives the same settings back', () => {
  const s = sanitizeSettings({ modules: { downloads: false }, aiSites: ['chat.example'], language: 'fr', allowlist: [{ pattern: 'example.com', addedAt: 1, expiresAt: null }] }, NOW);
  const json = exportSettings(s, NOW);
  const parsed = JSON.parse(json) as Record<string, unknown>;
  assert.equal(parsed['app'], EXPORT_APP);
  assert.equal(parsed['exportedAt'], new Date(NOW).toISOString());
  assert.equal('history' in parsed, false);
  const back = importSettings(json, NOW);
  assert.equal(back.ok, true);
  if (back.ok) assert.deepEqual(back.settings, s);
});

test('settings: import refuses files that are not ours', () => {
  assert.deepEqual(importSettings('not json', NOW), { ok: false, error: 'not-json' });
  assert.deepEqual(importSettings('[]', NOW), { ok: false, error: 'wrong-format' });
  assert.deepEqual(importSettings('null', NOW), { ok: false, error: 'wrong-format' });
  assert.deepEqual(importSettings(JSON.stringify({ app: 'other', settings: {} }), NOW), { ok: false, error: 'wrong-format' });
  assert.deepEqual(importSettings(JSON.stringify({ app: EXPORT_APP }), NOW), { ok: false, error: 'wrong-format' });
  assert.deepEqual(importSettings(42, NOW), { ok: false, error: 'wrong-format' });
  assert.deepEqual(importSettings('x'.repeat(MAX_IMPORT_CHARS + 1), NOW), { ok: false, error: 'too-large' });
});

test('settings: an imported file is treated as hostile and sanitised', () => {
  const json = JSON.stringify({ app: EXPORT_APP, settings: { modules: { pasteGuard: false, __proto__: { polluted: true } }, aiSites: ['<script>', 'ok.example'], allowlist: [{ pattern: '*' }], language: '../../etc' } });
  const r = importSettings(json, NOW);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.settings.modules.pasteGuard, false);
  assert.deepEqual(r.settings.aiSites, ['ok.example']);
  assert.deepEqual(r.settings.allowlist, []);
  assert.equal(r.settings.language, 'auto');
  assert.equal(({} as Record<string, unknown>)['polluted'], undefined);
});

test('history: an entry holds only site, protection, level, rule ids, action and time', () => {
  const e = makeEntry('Example.com', 'pasteGuard', 'critical', ['cmd.ps.hidden-window'], 'blocked', NOW);
  assert.deepEqual(e, { t: NOW, d: 'example.com', m: 'pasteGuard', l: 'critical', r: ['cmd.ps.hidden-window'], a: 'blocked' });
  assert.deepEqual(Object.keys(e ?? {}).sort(), ['a', 'd', 'l', 'm', 'r', 't']);
});

test('history: anything that could carry page content is refused', () => {
  assert.equal(makeEntry('https://example.com/secret?token=1', 'pasteGuard', 'high', [], 'blocked', NOW), null);
  assert.equal(makeEntry('example.com some pasted text', 'pasteGuard', 'high', [], 'blocked', NOW), null);
  assert.equal(makeEntry('', 'pasteGuard', 'high', [], 'blocked', NOW), null);
  assert.equal(makeEntry('example.com', 'nope', 'high', [], 'blocked', NOW), null);
  assert.equal(makeEntry('example.com', 'pasteGuard', 'severe', [], 'blocked', NOW), null);
  assert.equal(makeEntry('example.com', 'pasteGuard', 'high', [], 'exploded', NOW), null);
  assert.deepEqual(cleanRuleIds(['cmd.ok', 'has space', 'UPPER', 'x'.repeat(80), 'cmd.ok', 7, 'url.lookalike-domain']), ['cmd.ok', 'url.lookalike-domain']);
  assert.deepEqual(cleanRuleIds('cmd.ok'), []);
});

test('history: rule ids are capped', () => {
  const ids = Array.from({ length: 30 }, (_, i) => `rule.${i}`);
  assert.equal(cleanRuleIds(ids).length, MAX_RULE_IDS);
});

test('history: newest first, capped at the limit', () => {
  let list: HistoryEntry[] = [];
  for (let i = 0; i < HISTORY_CAP + 20; i++) list = addEntry(list, makeEntry(`s${i}.example`, 'lookalike', 'high', [], 'warned', NOW + i * 60_000) as HistoryEntry);
  assert.equal(list.length, HISTORY_CAP);
  assert.equal(list[0]?.d, `s${HISTORY_CAP + 19}.example`);
});

test('history: quick repeats on the same site merge into one entry', () => {
  const a = makeEntry('example.com', 'pasteGuard', 'high', ['cmd.a'], 'blocked', NOW) as HistoryEntry;
  const b = makeEntry('example.com', 'pasteGuard', 'critical', ['cmd.b'], 'blocked', NOW + 2000) as HistoryEntry;
  const later = makeEntry('example.com', 'pasteGuard', 'high', ['cmd.a'], 'blocked', NOW + 60_000) as HistoryEntry;
  let list = addEntry(addEntry([], a), b);
  assert.equal(list.length, 1);
  assert.deepEqual(list[0]?.r, ['cmd.a', 'cmd.b']);
  assert.equal(list[0]?.l, 'critical');
  list = addEntry(list, later);
  assert.equal(list.length, 2);
});

test('history: damaged storage is cleaned on read', () => {
  const good = { t: NOW, d: 'example.com', m: 'aiPaste', l: 'high', r: ['secret.github-token'], a: 'redacted' };
  const clean = sanitizeHistory([good, { ...good, d: 'bad host' }, { ...good, t: 'yesterday' }, null, 'x', { ...good, extra: 'clipboard text' }]);
  assert.equal(clean.length, 2);
  assert.equal('extra' in (clean[1] as object), false);
  assert.deepEqual(sanitizeHistory({}), []);
});
