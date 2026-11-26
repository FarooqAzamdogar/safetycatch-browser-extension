// Copyright 2026 The SafetyCatch Authors
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addTrust, findTrust, isExpired, matchesPattern, MAX_TRUST_ENTRIES, normalizeHost, normalizePattern, pruneExpired, removeTrust, sanitizeTrustList, TRUST_DURATIONS, type TrustEntry } from '../src/shared/allowlist.ts';

const NOW = 1_800_000_000_000;
const HOUR = 60 * 60 * 1000;

test('normalizeHost: accepts hosts and pasted http(s) addresses', () => {
  assert.equal(normalizeHost('Example.COM'), 'example.com');
  assert.equal(normalizeHost('https://docs.example.com/path?x=1#y'), 'docs.example.com');
  assert.equal(normalizeHost('example.com:8443'), 'example.com');
  assert.equal(normalizeHost('example.com.'), 'example.com');
  assert.equal(normalizeHost('localhost'), 'localhost');
});

test('normalizeHost: rejects anything that is not a plain host', () => {
  for (const bad of ['', '   ', 'javascript:alert(1)', 'ftp://example.com', 'user@example.com', 'exa mple.com', 'a..b', '-bad-.com', '[::1]', 'file:///C:/x', 5, null, undefined, 'x'.repeat(400)]) {
    assert.equal(normalizeHost(bad), null, String(bad));
  }
});

test('normalizeHost: international names are stored in their ASCII form', () => {
  const host = normalizeHost(`b${String.fromCodePoint(0xfc)}cher.example`);
  assert.equal(host, 'xn--bcher-kva.example');
});

test('normalizePattern: plain hosts and wildcards', () => {
  assert.equal(normalizePattern('example.com'), 'example.com');
  assert.equal(normalizePattern('*.Example.com'), '*.example.com');
  assert.equal(normalizePattern('https://example.com/login'), 'example.com');
});

test('normalizePattern: refuses wildcards that are too wide', () => {
  assert.equal(normalizePattern('*.com'), null);
  assert.equal(normalizePattern('*'), null);
  assert.equal(normalizePattern('*.'), null);
  assert.equal(normalizePattern('*.192.168.1.1'), null);
  assert.equal(normalizePattern('a.*.example.com'), null);
});

test('normalizePattern: a caller can veto shared bases such as public suffixes', () => {
  const shared = (base: string): boolean => base === 'co.uk' || base === 'github.io';
  assert.equal(normalizePattern('*.co.uk', shared), null);
  assert.equal(normalizePattern('*.github.io', shared), null);
  assert.equal(normalizePattern('*.example.co.uk', shared), '*.example.co.uk');
  assert.equal(normalizePattern('user.github.io', shared), 'user.github.io');
});

test('matchesPattern: exact entries match the host (www is ignored), not other sub-sites', () => {
  assert.equal(matchesPattern('example.com', 'example.com'), true);
  assert.equal(matchesPattern('www.example.com', 'example.com'), true);
  assert.equal(matchesPattern('example.com', 'www.example.com'), true);
  assert.equal(matchesPattern('login.example.com', 'example.com'), false);
  assert.equal(matchesPattern('notexample.com', 'example.com'), false);
  assert.equal(matchesPattern('example.com.evil.test', 'example.com'), false);
});

test('matchesPattern: wildcards cover the site and its sub-sites only', () => {
  assert.equal(matchesPattern('example.com', '*.example.com'), true);
  assert.equal(matchesPattern('a.b.example.com', '*.example.com'), true);
  assert.equal(matchesPattern('badexample.com', '*.example.com'), false);
  assert.equal(matchesPattern('example.com.evil.test', '*.example.com'), false);
});

test('trust entries expire', () => {
  const entry: TrustEntry = { pattern: 'example.com', addedAt: NOW, expiresAt: NOW + HOUR };
  assert.equal(isExpired(entry, NOW + HOUR - 1), false);
  assert.equal(isExpired(entry, NOW + HOUR), true);
  assert.equal(isExpired({ ...entry, expiresAt: null }, NOW + 1e12), false);
});

test('findTrust: returns live entries only', () => {
  const list: TrustEntry[] = [
    { pattern: 'old.example', addedAt: NOW - 2 * HOUR, expiresAt: NOW - HOUR },
    { pattern: 'example.com', addedAt: NOW, expiresAt: null },
  ];
  assert.equal(findTrust('example.com', list, NOW)?.pattern, 'example.com');
  assert.equal(findTrust('old.example', list, NOW), undefined);
  assert.equal(findTrust('other.example', list, NOW), undefined);
  assert.equal(findTrust(null, list, NOW), undefined);
  assert.equal(findTrust('', list, NOW), undefined);
});

test('addTrust: sets the end date, refreshes an existing entry and drops expired ones', () => {
  let list = addTrust([], 'example.com', NOW, TRUST_DURATIONS['hour'] as number);
  assert.deepEqual(list, [{ pattern: 'example.com', addedAt: NOW, expiresAt: NOW + HOUR }]);
  list = addTrust(list, 'example.com', NOW + 10, null);
  assert.equal(list.length, 1);
  assert.equal(list[0]?.expiresAt, null);
  list = addTrust([{ pattern: 'gone.example', addedAt: 0, expiresAt: 1 }], 'new.example', NOW, null);
  assert.deepEqual(
    list.map((e) => e.pattern),
    ['new.example'],
  );
});

test('addTrust: the list is capped, oldest removed first', () => {
  let list: TrustEntry[] = [];
  for (let i = 0; i < MAX_TRUST_ENTRIES + 5; i++) list = addTrust(list, `site${i}.example`, NOW + i, null);
  assert.equal(list.length, MAX_TRUST_ENTRIES);
  assert.equal(list[0]?.pattern, 'site5.example');
});

test('removeTrust and pruneExpired', () => {
  const list: TrustEntry[] = [
    { pattern: 'a.example', addedAt: NOW, expiresAt: NOW - 1 },
    { pattern: 'b.example', addedAt: NOW, expiresAt: null },
  ];
  assert.deepEqual(pruneExpired(list, NOW), [list[1]]);
  assert.deepEqual(removeTrust(list, 'b.example'), [list[0]]);
  assert.deepEqual(removeTrust(list, 'missing.example'), list);
});

test('trust durations offered in the UI', () => {
  assert.deepEqual(Object.keys(TRUST_DURATIONS), ['hour', 'day', 'month', 'forever']);
  assert.equal(TRUST_DURATIONS['forever'], null);
  assert.equal(TRUST_DURATIONS['day'], 24 * HOUR);
});

test('sanitizeTrustList: keeps well-formed live entries and nothing else', () => {
  const raw = [
    { pattern: 'Example.com', addedAt: 5, expiresAt: null },
    { pattern: '*.com', addedAt: 5, expiresAt: null },
    { pattern: 'expired.example', addedAt: 5, expiresAt: NOW - 1 },
    { pattern: 'javascript:alert(1)' },
    'example.org',
    null,
    { pattern: 'no-dates.example' },
    { pattern: 'bad-date.example', expiresAt: 'tomorrow' },
  ];
  const clean = sanitizeTrustList(raw, NOW);
  assert.deepEqual(clean, [
    { pattern: 'example.com', addedAt: 5, expiresAt: null },
    { pattern: 'no-dates.example', addedAt: NOW, expiresAt: null },
  ]);
  assert.deepEqual(sanitizeTrustList('nope', NOW), []);
  assert.deepEqual(sanitizeTrustList(undefined, NOW), []);
});

test('sanitizeTrustList: duplicates collapse and the list stays capped', () => {
  const many = Array.from({ length: 500 }, (_, i) => ({ pattern: `s${i % 300}.example`, addedAt: i, expiresAt: null }));
  const clean = sanitizeTrustList(many, NOW);
  assert.ok(clean.length <= MAX_TRUST_ENTRIES);
  assert.equal(new Set(clean.map((e) => e.pattern)).size, clean.length);
});
