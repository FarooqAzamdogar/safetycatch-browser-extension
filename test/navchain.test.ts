// Copyright 2026 The ActionGuard Authors
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { arrival, beforeNavigate, classify, committed, createdTarget, MAX_ENTRIES, MAX_TABS, MAX_URL_CHARS, prune, referrerCandidates, sanitizeNavState, tabRemoved, type NavState } from '../src/shared/navchain.ts';

const T = 1_800_000_000_000;
const DEVICE = 'https://microsoft.com/devicelogin';

test('classify: typed, bookmark and address-bar navigations are the person\'s own', () => {
  assert.equal(classify('typed', []), 'typed');
  assert.equal(classify('auto_bookmark', undefined), 'typed');
  assert.equal(classify('generated', []), 'typed');
  assert.equal(classify('link', ['from_address_bar']), 'typed');
});

test('classify: links, redirects, forms, reloads and the rest', () => {
  assert.equal(classify('link', []), 'link');
  assert.equal(classify('link', ['server_redirect']), 'redirect');
  assert.equal(classify('link', ['client_redirect']), 'redirect');
  assert.equal(classify('form_submit', []), 'form');
  assert.equal(classify('reload', []), 'reload');
  assert.equal(classify('typed', ['forward_back']), 'reload');
  assert.equal(classify('auto_subframe', []), 'other');
  assert.equal(classify(undefined, undefined), 'other');
});

test('a typed address has no referrer, even when the tab showed other pages before', () => {
  let s: NavState = {};
  s = committed(s, 1, 'https://news.example/story', 'link', [], T);
  s = committed(s, 1, DEVICE, 'typed', [], T + 1);
  assert.equal(arrival(s, 1), 'typed');
  assert.deepEqual(referrerCandidates(s, 1, DEVICE), []);
});

test('following a link from another site makes that site a referrer candidate', () => {
  let s: NavState = {};
  s = committed(s, 1, 'https://mail.example/inbox', 'typed', [], T);
  s = committed(s, 1, DEVICE, 'link', [], T + 1);
  assert.equal(arrival(s, 1), 'link');
  assert.deepEqual(referrerCandidates(s, 1, DEVICE), ['https://mail.example/inbox']);
});

test('redirect hops are part of the chain: both the redirector and the page before it are candidates', () => {
  let s: NavState = {};
  s = committed(s, 1, 'https://mail.example/inbox', 'typed', [], T);
  s = beforeNavigate(s, 1, 'https://track.example/r?id=1', T + 1);
  s = committed(s, 1, DEVICE, 'link', ['server_redirect'], T + 2);
  assert.equal(arrival(s, 1), 'link');
  assert.deepEqual(referrerCandidates(s, 1, DEVICE), ['https://track.example/r?id=1', 'https://mail.example/inbox']);
});

test('a link opened in a new tab remembers the page that opened it', () => {
  let s: NavState = {};
  s = committed(s, 1, 'https://chat.example/room', 'typed', [], T);
  s = createdTarget(s, 1, 2, T + 1);
  s = committed(s, 2, DEVICE, 'link', [], T + 2);
  assert.equal(arrival(s, 2), 'link');
  assert.deepEqual(referrerCandidates(s, 2, DEVICE), ['https://chat.example/room']);
});

test('the first page of a new tab, reached by a link with no opener, came from outside the browser', () => {
  const s = committed({}, 7, DEVICE, 'link', [], T);
  assert.equal(arrival(s, 7), 'external');
  assert.deepEqual(referrerCandidates(s, 7, DEVICE), []);
});

test('an outside link that passes through a redirector is still "external"', () => {
  let s = beforeNavigate({}, 7, 'https://short.example/x', T);
  s = committed(s, 7, DEVICE, 'link', ['server_redirect'], T + 1);
  assert.equal(arrival(s, 7), 'external');
  assert.deepEqual(referrerCandidates(s, 7, DEVICE), ['https://short.example/x']);
});

test('unknown tabs, reloads and session restores are "unknown", never "external"', () => {
  assert.equal(arrival({}, 3), 'unknown');
  assert.equal(arrival(committed({}, 3, DEVICE, 'reload', [], T), 3), 'unknown');
  assert.equal(arrival(committed({}, 3, DEVICE, 'auto_toplevel', [], T), 3), 'unknown');
});

test('reloading keeps how the page was first reached', () => {
  let s = committed({}, 1, 'https://mail.example/', 'typed', [], T);
  s = committed(s, 1, DEVICE, 'link', [], T + 1);
  s = committed(s, 1, DEVICE, 'reload', [], T + 2);
  assert.equal(s['1']?.entries.length, 2);
  assert.equal(arrival(s, 1), 'link');
  assert.deepEqual(referrerCandidates(s, 1, DEVICE), ['https://mail.example/']);
});

test('pages on the same host as the current one are not referrers', () => {
  let s = committed({}, 1, 'https://login.example/start', 'typed', [], T);
  s = committed(s, 1, 'https://login.example/device', 'link', [], T + 1);
  assert.deepEqual(referrerCandidates(s, 1, 'https://login.example/device'), []);
});

test('a browser page (new tab, settings) breaks the chain', () => {
  let s = committed({}, 1, 'https://mail.example/', 'typed', [], T);
  s = committed(s, 1, 'chrome://newtab/', 'typed', [], T + 1);
  assert.deepEqual(s['1']?.entries, []);
  s = committed(s, 1, DEVICE, 'link', [], T + 2);
  assert.deepEqual(referrerCandidates(s, 1, DEVICE), []);
});

test('only web addresses are recorded, and they are capped in length and number', () => {
  let s = beforeNavigate({}, 1, 'about:blank', T);
  assert.deepEqual(s, {});
  s = committed({}, 1, `https://long.example/${'a'.repeat(5000)}`, 'typed', [], T);
  assert.equal(s['1']?.entries[0]?.url.length, MAX_URL_CHARS);
  for (let i = 0; i < 30; i++) s = committed(s, 1, `https://site${i}.example/`, 'link', [], T + i);
  assert.equal(s['1']?.entries.length, MAX_ENTRIES);
});

test('closing a tab forgets its history; quiet tabs are pruned', () => {
  let s = committed({}, 1, 'https://a.example/', 'typed', [], T);
  s = committed(s, 2, 'https://b.example/', 'typed', [], T + 40 * 60 * 1000);
  assert.deepEqual(Object.keys(tabRemoved(s, 1)), ['2']);
  assert.equal(tabRemoved(s, 99), s);
  assert.deepEqual(Object.keys(prune(s, T + 41 * 60 * 1000)), ['2']);
  assert.equal(prune(s, T + 1), s);
});

test('the table of tabs stays small', () => {
  let s: NavState = {};
  for (let i = 0; i < MAX_TABS + 50; i++) s = committed(s, i, 'https://a.example/', 'typed', [], T + i);
  const pruned = prune(s, T + MAX_TABS + 50);
  assert.equal(Object.keys(pruned).length, MAX_TABS);
  assert.equal('0' in pruned, false);
});

test('state read back from storage is validated', () => {
  const raw = {
    '1': { entries: [{ url: 'https://a.example/', t: 1, how: 'link' }, { url: 'javascript:alert(1)', t: 1, how: 'link' }, { url: 'https://b.example/', t: 1, how: 'teleport' }], opener: 'file:///etc/passwd', seen: 5 },
    'not-a-tab': { entries: [] },
    '2': 'nope',
  };
  const clean = sanitizeNavState(raw);
  assert.deepEqual(clean, { '1': { entries: [{ url: 'https://a.example/', t: 1, how: 'link' }], seen: 5 } });
  assert.deepEqual(sanitizeNavState(null), {});
  assert.deepEqual(sanitizeNavState([1, 2]), {});
});
