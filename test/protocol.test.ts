// Copyright 2026 The SafetyCatch Authors
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { baseName, downloadName, hasExtension, MAX_PENDING, nameFromUrl, opsForChoice, sanitizePending } from '../src/shared/downloads.ts';
import { parseModel, type WarningModel } from '../src/shared/model.ts';
import { CONTENT_TYPES, isContentType, LIMITS, parseContentRequest, parsePageRequest } from '../src/shared/protocol.ts';

test('content requests: clipboard check is validated and capped', () => {
  const r = parseContentRequest({ type: 'check-clipboard', text: 'x'.repeat(LIMITS.text + 50), pageText: 'y'.repeat(LIMITS.pageText + 50), source: 'selection', tampered: 'yes', extra: 1 });
  assert.equal(r?.type, 'check-clipboard');
  if (r?.type !== 'check-clipboard') return;
  assert.equal(r.text.length, LIMITS.text);
  assert.equal(r.pageText.length, LIMITS.pageText);
  assert.equal(r.source, 'selection');
  assert.equal(r.tampered, false);
  assert.equal('extra' in r, false);
});

test('content requests: an unknown source is treated as the strictest one', () => {
  const r = parseContentRequest({ type: 'check-clipboard', text: 'abc', source: 'trusted-i-promise' });
  assert.equal(r?.type === 'check-clipboard' && r.source, 'programmatic');
  assert.equal(r?.type === 'check-clipboard' && r.pageText, '');
});

test('content requests: missing or wrong fields are refused', () => {
  for (const bad of [null, undefined, 'check-clipboard', 7, [], {}, { type: 'check-clipboard' }, { type: 'check-clipboard', text: 5 }, { type: 'check-secrets' }, { type: 'check-page', pageText: {} }, { type: 'nope' }, { type: 'ack', scope: 'everything' }]) {
    assert.equal(parseContentRequest(bad), null, JSON.stringify(bad));
  }
});

test('content requests: login, auth, page, secrets, ack and leave', () => {
  assert.deepEqual(parseContentRequest({ type: 'check-login', title: 'T'.repeat(1000), pageText: 5, referrer: 'https://a.example/' }), { type: 'check-login', title: 'T'.repeat(LIMITS.title), pageText: '', referrer: 'https://a.example/' });
  assert.deepEqual(parseContentRequest({ type: 'check-auth' }), { type: 'check-auth', referrer: '' });
  assert.deepEqual(parseContentRequest({ type: 'check-page', pageText: 'abc' }), { type: 'check-page', pageText: 'abc' });
  assert.deepEqual(parseContentRequest({ type: 'check-secrets', text: 'abc' }), { type: 'check-secrets', text: 'abc' });
  assert.deepEqual(parseContentRequest({ type: 'ack', scope: 'auth' }), { type: 'ack', scope: 'auth' });
  assert.deepEqual(parseContentRequest({ type: 'leave', anything: true }), { type: 'leave' });
});

test('content requests: a report carries only a protection, an action, a level and clean rule ids', () => {
  assert.deepEqual(parseContentRequest({ type: 'report', module: 'pasteGuard', action: 'restored', level: 'critical', ruleIds: ['cmd.a', 'not a rule id', 'cmd.a'], text: 'clipboard contents' }), {
    type: 'report',
    module: 'pasteGuard',
    action: 'restored',
    level: 'critical',
    ruleIds: ['cmd.a'],
  });
  assert.equal(parseContentRequest({ type: 'report', module: 'x', action: 'restored', level: 'high' }), null);
  assert.equal(parseContentRequest({ type: 'report', module: 'pasteGuard', action: 'hacked', level: 'high' }), null);
});

test('content scripts may only send check-type messages', () => {
  for (const type of CONTENT_TYPES) assert.equal(isContentType({ type }), true);
  for (const type of ['set-settings', 'add-trust', 'set-module', 'download-choice', 'clear-history', 'import-settings', 'get-state']) {
    assert.equal(isContentType({ type }), false, type);
    assert.equal(parseContentRequest({ type, settings: {}, pattern: 'evil.example', duration: 'forever', module: 'pasteGuard', enabled: false, id: 1, choice: 'resume', json: '{}' }), null, type);
  }
  assert.equal(isContentType(null), false);
});

test('page requests: settings changes are validated', () => {
  assert.deepEqual(parsePageRequest({ type: 'set-module', module: 'aiPaste', enabled: false }), { type: 'set-module', module: 'aiPaste', enabled: false });
  assert.equal(parsePageRequest({ type: 'set-module', module: 'aiPaste', enabled: 'no' }), null);
  assert.equal(parsePageRequest({ type: 'set-module', module: 'constructor', enabled: true }), null);
  assert.deepEqual(parsePageRequest({ type: 'add-trust', pattern: 'example.com', duration: 'day' }), { type: 'add-trust', pattern: 'example.com', duration: 'day' });
  assert.equal(parsePageRequest({ type: 'add-trust', pattern: 5, duration: 'day' }), null);
  assert.deepEqual(parsePageRequest({ type: 'remove-trust', pattern: 'example.com' }), { type: 'remove-trust', pattern: 'example.com' });
  assert.deepEqual(parsePageRequest({ type: 'clear-history' }), { type: 'clear-history' });
  assert.equal(parsePageRequest({ type: 'set-settings', settings: 'x' }), null);
  assert.equal(parsePageRequest({ type: 'import-settings', json: 'x'.repeat(LIMITS.settingsJson + 1) }), null);
  assert.deepEqual(parsePageRequest({ type: 'get-state' }), { type: 'get-state', url: '' });
});

test('page requests: download choices need a real id and a known choice', () => {
  assert.deepEqual(parsePageRequest({ type: 'download-choice', id: 4, choice: 'cancel' }), { type: 'download-choice', id: 4, choice: 'cancel' });
  for (const bad of [{ id: -1, choice: 'cancel' }, { id: 1.5, choice: 'cancel' }, { id: '4', choice: 'cancel' }, { id: 4, choice: 'explode' }, { id: 2 ** 40, choice: 'resume' }]) {
    assert.equal(parsePageRequest({ type: 'download-choice', ...bad }), null, JSON.stringify(bad));
  }
  assert.equal(parsePageRequest({ type: 'download-info', id: NaN }), null);
  assert.equal(parsePageRequest({ type: 'check-clipboard', text: 'x' }), null);
});

const MODEL: WarningModel = {
  kind: 'paste-block',
  layout: 'page',
  module: 'pasteGuard',
  level: 'critical',
  levelLabel: 'Critical risk',
  lang: 'en',
  dir: 'ltr',
  brand: 'SafetyCatch',
  title: 'This page secretly copied a command',
  lead: ['lead'],
  cleared: 'cleared',
  notCleared: 'not cleared',
  sections: [{ title: 'Why', items: ['a', 'b'] }],
  sample: { title: 'What was copied', text: 'echo hi', more: '' },
  buttons: [
    { id: 'keep', label: 'Keep it removed', style: 'primary' },
    { id: 'restore', label: 'Hold to put it back', style: 'hold' },
  ],
  friction: { hint: 'Hold', typeLabel: 'Type allow', word: 'allow', covered: 'covered' },
  ruleIds: ['cmd.a'],
};

test('warning model: a valid model survives validation unchanged', () => {
  assert.deepEqual(parseModel(structuredClone(MODEL)), MODEL);
});

test('warning model: wrong kinds, layouts, levels and empty button lists are refused', () => {
  assert.equal(parseModel(null), null);
  assert.equal(parseModel('model'), null);
  assert.equal(parseModel({ ...MODEL, kind: 'popup-ad' }), null);
  assert.equal(parseModel({ ...MODEL, layout: 'fullscreen' }), null);
  assert.equal(parseModel({ ...MODEL, level: 'apocalyptic' }), null);
  assert.equal(parseModel({ ...MODEL, module: 'x' }), null);
  assert.equal(parseModel({ ...MODEL, buttons: [] }), null);
  assert.equal(parseModel({ ...MODEL, buttons: [{ id: 'self-destruct', label: 'x', style: 'primary' }] }), null);
});

test('warning model: a hold button without friction wording is refused', () => {
  const { friction: _friction, ...rest } = MODEL;
  assert.equal(parseModel(rest), null);
  assert.equal(parseModel({ ...MODEL, friction: { hint: 'h', typeLabel: 't', word: '   ', covered: 'c' } }), null);
});

test('warning model: text is capped and odd values are normalised', () => {
  const m = parseModel({ ...MODEL, title: 'T'.repeat(5000), lead: ['a', 5, 'b', null], dir: 'sideways', lang: '<script>', sections: [{ title: 'x', items: [] }, { title: 'y', items: ['kept'] }, 'nope'], extra: 'dropped' });
  assert.ok(m);
  assert.equal(m.title.length, 200);
  assert.deepEqual(m.lead, ['a', 'b']);
  assert.equal(m.dir, 'ltr');
  assert.equal(m.lang, 'en');
  assert.deepEqual(m.sections, [{ title: 'y', items: ['kept'] }]);
  assert.equal('extra' in m, false);
});

test('downloads: the best known file name', () => {
  assert.equal(baseName('C:\\Users\\me\\Downloads\\Invoice.pdf.js'), 'Invoice.pdf.js');
  assert.equal(baseName('/home/me/Downloads/report.pdf'), 'report.pdf');
  assert.equal(baseName(''), '');
  assert.equal(baseName(undefined), '');
  assert.equal(nameFromUrl('https://files.example/dl/My%20Invoice.pdf.exe?x=1'), 'My Invoice.pdf.exe');
  assert.equal(nameFromUrl('https://files.example/bad%ZZname.txt'), 'bad%ZZname.txt');
  assert.equal(nameFromUrl('blob:https://files.example/1234'), '');
  assert.equal(nameFromUrl('data:text/html,hi'), '');
  assert.equal(downloadName('C:\\dl\\real-name.exe', 'https://files.example/get?id=1'), 'real-name.exe');
  assert.equal(downloadName('', 'https://files.example/setup.msi'), 'setup.msi');
  assert.equal(downloadName('', 'https://files.example/'), '');
  assert.equal(hasExtension('photo.jpg'), true);
  assert.equal(hasExtension('download'), false);
});

test('downloads: only choices that make sense for the state are carried out', () => {
  assert.deepEqual(opsForChoice('resume', false), ['resume']);
  assert.deepEqual(opsForChoice('cancel', false), ['cancel', 'erase']);
  assert.deepEqual(opsForChoice('delete', true), ['removeFile', 'erase']);
  assert.deepEqual(opsForChoice('keep', true), []);
  assert.equal(opsForChoice('resume', true), null);
  assert.equal(opsForChoice('delete', false), null);
  assert.equal(opsForChoice('keep', false), null);
});

test('downloads: the pending table read from storage is validated, aged out and capped', () => {
  const now = 1_800_000_000_000;
  const item = (id: number, t: number): Record<string, unknown> => ({ id, name: `f${id}.exe`, url: 'https://x.example/f', referrer: '', pageUrl: '', finished: false, decided: false, t });
  const raw: Record<string, unknown> = { a: item(1, now), b: item(2, now - 2 * 60 * 60 * 1000), c: 'nope', d: { id: 'x', t: now } };
  assert.deepEqual(Object.keys(sanitizePending(raw, now)), ['1']);
  const many: Record<string, unknown> = {};
  for (let i = 0; i < 60; i++) many[String(i)] = item(i, now - i);
  const kept = sanitizePending(many, now);
  assert.equal(Object.keys(kept).length, MAX_PENDING);
  assert.ok('0' in kept);
  assert.deepEqual(sanitizePending(null, now), {});
});

test('sub-frame relay requests carry a model object and nothing else', () => {
  assert.deepEqual(parseContentRequest({ type: 'ask-top', model: { kind: 'ai-paste' }, extra: 1 }), { type: 'ask-top', model: { kind: 'ai-paste' } });
  assert.deepEqual(parseContentRequest({ type: 'show-top', model: { kind: 'paste-notice' } }), { type: 'show-top', model: { kind: 'paste-notice' } });
  for (const model of [undefined, null, 'text', 3]) assert.equal(parseContentRequest({ type: 'ask-top', model }), null);
});
