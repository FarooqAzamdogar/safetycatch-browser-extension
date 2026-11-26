// Copyright 2026 The SafetyCatch Authors
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { copyCandidates, MAX_CANDIDATES, newCopyContext } from '../src/shared/copytrack.ts';
import { asAuthFlow, decideAiPaste, decideAuth, decideDownload, decideLogin, decideLure, decidePaste, type PasteInput } from '../src/shared/decisions.ts';
import { LEVELS } from '../src/shared/levels.ts';
import { groupScopes, isBasicScope, parseScopes } from '../src/shared/scopes.ts';

const paste = (over: Partial<PasteInput>): PasteInput => ({ command: 'safe', page: 'safe', source: 'programmatic', runnable: false, ...over });

test('paste: a high or critical command copied by the page is blocked', () => {
  for (const source of ['programmatic', 'hijack'] as const) {
    assert.equal(decidePaste(paste({ command: 'high', source })), 'block');
    assert.equal(decidePaste(paste({ command: 'critical', source })), 'block');
  }
});

test('paste: harmless text copied by the page is allowed', () => {
  assert.equal(decidePaste(paste({ command: 'safe' })), 'allow');
  assert.equal(decidePaste(paste({ command: 'low' })), 'allow');
  assert.equal(decidePaste(paste({ command: 'safe', page: 'medium' })), 'allow');
});

test('paste: a medium command gets a notice, or is blocked when the page also shows a lure', () => {
  assert.equal(decidePaste(paste({ command: 'medium' })), 'notice');
  assert.equal(decidePaste(paste({ command: 'medium', page: 'low' })), 'notice');
  assert.equal(decidePaste(paste({ command: 'medium', page: 'medium' })), 'block');
  assert.equal(decidePaste(paste({ command: 'medium', page: 'critical' })), 'block');
});

test('paste: a page with paste-and-run instructions makes any command-like copy a block', () => {
  assert.equal(decidePaste(paste({ command: 'low', page: 'high' })), 'block');
  assert.equal(decidePaste(paste({ command: 'safe', page: 'high', runnable: true })), 'block');
  assert.equal(decidePaste(paste({ command: 'safe', page: 'high' })), 'allow');
});

test('paste: the person\'s own selection is treated more gently', () => {
  assert.equal(decidePaste(paste({ source: 'selection', command: 'critical' })), 'block');
  assert.equal(decidePaste(paste({ source: 'selection', command: 'high' })), 'notice');
  assert.equal(decidePaste(paste({ source: 'selection', command: 'high', page: 'medium' })), 'block');
  assert.equal(decidePaste(paste({ source: 'selection', command: 'medium' })), 'allow');
  assert.equal(decidePaste(paste({ source: 'selection', command: 'medium', page: 'high' })), 'block');
  assert.equal(decidePaste(paste({ source: 'selection', command: 'low', page: 'critical' })), 'allow');
});

test('paste: when the check fails, the result is never "safe"', () => {
  assert.equal(decidePaste(paste({ command: 'unknown', runnable: true })), 'block');
  assert.equal(decidePaste(paste({ command: 'unknown', runnable: false })), 'unchecked');
  assert.equal(decidePaste(paste({ command: 'unknown', source: 'hijack', runnable: true })), 'block');
  assert.equal(decidePaste(paste({ command: 'unknown', source: 'selection', runnable: true })), 'unchecked');
  // The person's own selection of ordinary-looking text is left alone rather than nagged about.
  assert.equal(decidePaste(paste({ command: 'unknown', source: 'selection', runnable: false })), 'allow');
});

test('paste: an unknown page level never lowers the outcome', () => {
  assert.equal(decidePaste(paste({ command: 'high', page: 'unknown' })), 'block');
  assert.equal(decidePaste(paste({ command: 'medium', page: 'unknown' })), 'notice');
  assert.equal(decidePaste(paste({ command: 'safe', page: 'unknown' })), 'allow');
});

test('paste: a page that removed our hooks is judged strictly', () => {
  assert.equal(decidePaste(paste({ command: 'safe', page: 'high', tampered: true })), 'block');
  assert.equal(decidePaste(paste({ command: 'medium', tampered: true })), 'block');
  assert.equal(decidePaste(paste({ source: 'selection', command: 'high', tampered: true })), 'block');
  assert.equal(decidePaste(paste({ command: 'safe', page: 'safe', tampered: true })), 'allow');
});

test('paste: every combination gives a defined action and worse input never gives a milder action', () => {
  const order = ['allow', 'unchecked', 'notice', 'block'];
  for (const source of ['programmatic', 'hijack', 'selection'] as const) {
    for (const page of LEVELS) {
      let previous = 0;
      for (const command of LEVELS) {
        const action = decidePaste(paste({ source, page, command }));
        assert.ok(order.includes(action));
        assert.ok(order.indexOf(action) >= previous, `${source} page=${page} command=${command} gave ${action}`);
        previous = order.indexOf(action);
      }
    }
  }
});

test('paste: a worse page level never gives a milder action (so checking the two extremes is enough)', () => {
  const order = ['allow', 'unchecked', 'notice', 'block'];
  for (const source of ['programmatic', 'hijack', 'selection'] as const) {
    for (const command of [...LEVELS, 'unknown'] as const) {
      for (const runnable of [false, true]) {
        for (const tampered of [false, true]) {
          let previous = 0;
          for (const page of LEVELS) {
            const rankNow = order.indexOf(decidePaste({ source, command, page, runnable, tampered }));
            assert.ok(rankNow >= previous, `${source} command=${command} page=${page} runnable=${runnable} tampered=${tampered}`);
            previous = rankNow;
          }
          // No page text at all behaves like a harmless page.
          assert.equal(decidePaste({ source, command, page: 'unknown', runnable, tampered }), decidePaste({ source, command, page: 'safe', runnable, tampered }));
        }
      }
    }
  }
});

test('login: typing is intercepted only for a strong single finding', () => {
  assert.equal(decideLogin('critical', 'high'), 'intercept');
  assert.equal(decideLogin('high', 'high'), 'intercept');
  assert.equal(decideLogin('high', 'critical'), 'intercept');
  // Plain http plus an unusual port add up to "high" without any strong finding: banner, not a wall.
  assert.equal(decideLogin('high', 'medium'), 'banner');
  assert.equal(decideLogin('medium', 'medium'), 'banner');
  assert.equal(decideLogin('low', 'low'), 'none');
  assert.equal(decideLogin('safe', 'safe'), 'none');
  assert.equal(decideLogin('unknown', 'high'), 'none');
});

test('auth: device-code page reached directly gets a banner', () => {
  assert.deepEqual(decideAuth('medium', 'device-code', 'typed'), { ui: 'banner', level: 'medium', raised: false });
  assert.deepEqual(decideAuth('medium', 'device-code', 'unknown'), { ui: 'banner', level: 'medium', raised: false });
  assert.deepEqual(decideAuth('medium', 'device-code', 'link'), { ui: 'banner', level: 'medium', raised: false });
});

test('auth: arriving from outside the browser raises medium to high', () => {
  assert.deepEqual(decideAuth('medium', 'device-code', 'external'), { ui: 'interstitial', level: 'high', raised: true });
  assert.deepEqual(decideAuth('medium', 'oauth-consent', 'external'), { ui: 'interstitial', level: 'high', raised: true });
  assert.deepEqual(decideAuth('low', 'oauth-consent', 'external'), { ui: 'none', level: 'low', raised: false });
});

test('auth: high and critical verdicts block until the person decides', () => {
  assert.equal(decideAuth('high', 'device-code', 'link').ui, 'interstitial');
  assert.equal(decideAuth('critical', 'admin-consent', 'typed').ui, 'interstitial');
  assert.equal(decideAuth('critical', 'oauth-consent', 'external').raised, false);
});

test('auth: ordinary "sign in with" consent, non-auth pages and failed checks show nothing', () => {
  assert.equal(decideAuth('low', 'oauth-consent', 'link').ui, 'none');
  assert.equal(decideAuth('safe', 'none', 'link').ui, 'none');
  assert.equal(decideAuth('high', 'none', 'external').ui, 'none');
  assert.equal(decideAuth('high', 'impersonation', 'link').ui, 'none');
  assert.equal(decideAuth('unknown', 'device-code', 'external').ui, 'none');
});

test('auth: flow names from the engine are validated', () => {
  assert.equal(asAuthFlow('device-code'), 'device-code');
  assert.equal(asAuthFlow('admin-consent'), 'admin-consent');
  assert.equal(asAuthFlow('something-else'), 'none');
  assert.equal(asAuthFlow(undefined), 'none');
});

test('lure: a notice only on platforms, and only when instructions are present', () => {
  assert.equal(decideLure(false, 'critical', true), 'none');
  assert.equal(decideLure(true, 'safe', false), 'none');
  assert.equal(decideLure(true, 'low', true), 'notice');
  assert.equal(decideLure(true, 'medium', true), 'notice');
  assert.equal(decideLure(true, 'high', true), 'warn');
  assert.equal(decideLure(true, 'critical', false), 'warn');
  assert.equal(decideLure(true, 'unknown', true), 'notice');
  assert.equal(decideLure(true, 'unknown', false), 'none');
});

test('AI paste: medium and worse stop the paste; low passes; a failed check is "unchecked"', () => {
  assert.equal(decideAiPaste('safe'), 'allow');
  assert.equal(decideAiPaste('low'), 'allow');
  assert.equal(decideAiPaste('medium'), 'prompt');
  assert.equal(decideAiPaste('critical'), 'prompt');
  assert.equal(decideAiPaste('unknown'), 'unchecked');
});

test('downloads: only high and critical ask', () => {
  assert.equal(decideDownload('medium'), 'none');
  assert.equal(decideDownload('high'), 'ask');
  assert.equal(decideDownload('critical'), 'ask');
  assert.equal(decideDownload('unknown'), 'none');
});

test('copy tracking: the page supplied the data (default prevented)', () => {
  const c = newCopyContext(true);
  c.defaultPrevented = true;
  c.finalData = 'evil command';
  c.setData = ['evil command'];
  c.selections = ['', ''];
  assert.deepEqual(copyCandidates(c), [{ text: 'evil command', source: 'programmatic' }]);
});

test('copy tracking: a person\'s copy replaced by the page is a hijack', () => {
  const c = newCopyContext(false);
  c.defaultPrevented = true;
  c.finalData = 'evil command';
  c.selections = ['the harmless text I selected'];
  assert.deepEqual(copyCandidates(c), [{ text: 'evil command', source: 'hijack' }]);
});

test('copy tracking: a site that re-sets the same text the person selected is not a hijack', () => {
  const c = newCopyContext(false);
  c.defaultPrevented = true;
  c.finalData = 'npm  install\nexpress';
  c.selections = ['npm install express'];
  assert.deepEqual(copyCandidates(c), [{ text: 'npm  install\nexpress', source: 'selection' }]);
});

test('copy tracking: the browser copied the selection (default not prevented)', () => {
  const c = newCopyContext(false);
  c.defaultPrevented = false;
  c.setData = ['ignored because the page did not cancel the copy'];
  c.selections = ['first read', 'swapped by the page', 'first read'];
  assert.deepEqual(copyCandidates(c), [
    { text: 'first read', source: 'selection' },
    { text: 'swapped by the page', source: 'selection' },
  ]);
});

test('copy tracking: when the page hides the event, both possibilities are checked', () => {
  const c = newCopyContext(false);
  c.setData = ['from setData'];
  c.selections = ['from selection'];
  assert.deepEqual(copyCandidates(c), [
    { text: 'from setData', source: 'hijack' },
    { text: 'from selection', source: 'selection' },
  ]);
});

test('copy tracking: empty results, duplicates and floods are handled', () => {
  assert.deepEqual(copyCandidates(newCopyContext(true)), []);
  const c = newCopyContext(true);
  c.selections = ['a', 'a ', 'b', 'c', 'd', 'e'];
  assert.equal(copyCandidates(c).length, MAX_CANDIDATES);
  const big = newCopyContext(true);
  big.selections = ['x'.repeat(300_000)];
  assert.equal(copyCandidates(big)[0]?.text.length, 100_000);
});

test('scopes: engine data is read defensively', () => {
  const parsed = parseScopes([{ scope: 'Mail.Send', category: 'mail-send', severity: 'high' }, { scope: 'openid' }, { scope: '' }, { category: 'x' }, 'nope', null, { scope: 'weird', category: 'Not A Category!', severity: 'extreme' }]);
  assert.deepEqual(parsed, [{ scope: 'Mail.Send', category: 'mail-send', severity: 'high' }, { scope: 'openid' }, { scope: 'weird' }]);
  assert.deepEqual(parseScopes(undefined), []);
  assert.equal(parseScopes(Array.from({ length: 500 }, (_, i) => ({ scope: `s${i}` }))).length, 60);
  assert.equal(parseScopes([{ scope: 'x'.repeat(500) }])[0]?.scope.length, 120);
});

test('scopes: grouped by category, most serious first, basic sign-in scopes last', () => {
  const groups = groupScopes([
    { scope: 'openid' },
    { scope: 'offline_access', category: 'offline', severity: 'low' },
    { scope: 'Mail.Send', category: 'mail-send', severity: 'high' },
    { scope: 'Mail.Send.Shared', category: 'mail-send', severity: 'high' },
    { scope: 'full_access_as_user', category: 'mail-full', severity: 'critical' },
    { scope: 'Custom.Thing' },
    { scope: 'email' },
  ]);
  assert.deepEqual(
    groups.map((g) => g.category),
    ['mail-full', 'mail-send', 'offline', 'other', 'basic'],
  );
  assert.deepEqual(groups[1]?.scopes, ['Mail.Send', 'Mail.Send.Shared']);
  assert.deepEqual(groups[4]?.scopes, ['openid', 'email']);
});

test('scopes: basic sign-in scopes are recognised', () => {
  for (const s of ['openid', 'email', 'profile', 'User.Read', 'https://www.googleapis.com/auth/userinfo.email', 'read:user', 'identify']) assert.equal(isBasicScope(s), true, s);
  for (const s of ['Mail.Read', 'repo', 'https://mail.google.com/', 'Files.ReadWrite.All']) assert.equal(isBasicScope(s), false, s);
});
