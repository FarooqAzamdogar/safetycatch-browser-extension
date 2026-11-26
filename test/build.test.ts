// Copyright 2026 The ActionGuard Authors
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { inflateSync } from 'node:zlib';
import { ICON_SIZES, iconPng } from '../scripts/icons.ts';
import { buildManifest, EXTENSION_CSP, FIREFOX_ID, HOST_PERMISSIONS, PERMISSIONS, TARGETS } from '../scripts/manifest.ts';
import { crc32, createZip, readZip } from '../scripts/zip.ts';

const text = (s: string): Uint8Array => new TextEncoder().encode(s);

test('zip: CRC-32 matches the standard check value', () => {
  assert.equal(crc32(text('123456789')), 0xcbf43926);
  assert.equal(crc32(new Uint8Array()), 0);
});

test('zip: files round-trip, including sub-folders, non-ASCII names and empty files', () => {
  const entries = [
    { name: 'manifest.json', data: text('{"name":"x"}') },
    { name: '_locales/ur/messages.json', data: text('اردو متن '.repeat(200)) },
    { name: 'icons/ïcon.bin', data: new Uint8Array([0, 255, 1, 254, 2, 253]) },
    { name: 'empty.txt', data: new Uint8Array() },
  ];
  const back = readZip(createZip(entries));
  assert.deepEqual(back.map((e) => e.name), ['_locales/ur/messages.json', 'empty.txt', 'icons/ïcon.bin', 'manifest.json']);
  for (const e of entries) assert.deepEqual(back.find((b) => b.name === e.name)?.data, e.data, e.name);
});

test('zip: compressible data is deflated, incompressible data is stored, and the result is reproducible', () => {
  const zeros = new Uint8Array(50_000);
  const noise = new Uint8Array(4096).map((_, i) => (i * 2654435761) >>> 24);
  const zip = createZip([{ name: 'zeros', data: zeros }, { name: 'noise', data: noise }]);
  assert.ok(zip.length < 6000, `zip is ${zip.length} bytes`);
  assert.deepEqual(readZip(zip).find((e) => e.name === 'zeros')?.data, zeros);
  assert.deepEqual(createZip([{ name: 'noise', data: noise }, { name: 'zeros', data: zeros }]), zip);
});

test('zip: unsafe or duplicate names are refused', () => {
  for (const name of ['../evil.txt', '/abs.txt', 'a\\b.txt', '', 'a/../../b']) assert.throws(() => createZip([{ name, data: text('x') }]), /Bad zip entry name/, name);
  assert.throws(() => createZip([{ name: 'a', data: text('1') }, { name: 'a', data: text('2') }]), /Duplicate/);
  assert.throws(() => readZip(text('this is not a zip file')), /Not a zip/);
});

test('icons: valid square RGBA PNGs with a transparent corner and a solid centre', () => {
  for (const size of ICON_SIZES) {
    const png = Buffer.from(iconPng(size));
    assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    assert.equal(png.readUInt32BE(16), size);
    assert.equal(png.readUInt32BE(20), size);
    assert.equal(png[24], 8);
    assert.equal(png[25], 6);
    const idatLength = png.readUInt32BE(33);
    const raw = inflateSync(png.subarray(41, 41 + idatLength));
    assert.equal(raw.length, (size * 4 + 1) * size);
    const alphaAt = (x: number, y: number): number => raw[y * (size * 4 + 1) + 1 + x * 4 + 3] as number;
    assert.equal(alphaAt(0, 0), 0);
    assert.equal(alphaAt(Math.floor(size / 2), Math.floor(size / 2)), 255);
  }
});

for (const target of TARGETS) {
  test(`manifest (${target}): least privilege`, () => {
    const m = buildManifest(target, '1.2.3');
    assert.equal(m['manifest_version'], 3);
    assert.equal(m['version'], '1.2.3');
    assert.deepEqual(m['permissions'], ['storage', 'webNavigation', 'downloads', 'clipboardWrite']);
    assert.deepEqual(m['host_permissions'], ['http://*/*', 'https://*/*']);
    for (const banned of ['tabs', 'scripting', 'notifications', 'clipboardRead', 'history', 'cookies', 'webRequest', 'nativeMessaging', 'activeTab', 'offscreen', '<all_urls>']) {
      assert.equal(JSON.stringify(m).includes(`"${banned}"`), false, banned);
    }
    for (const absent of ['optional_permissions', 'externally_connectable', 'web_accessible_resources', 'content_security_policy_sandbox', 'update_url']) assert.equal(absent in m, false, absent);
  });

  test(`manifest (${target}): strict CSP, no remote code`, () => {
    const m = buildManifest(target, '0.1.0');
    const csp = (m['content_security_policy'] as { extension_pages: string }).extension_pages;
    assert.equal(csp, EXTENSION_CSP);
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /script-src 'self'(;|$)/);
    for (const banned of ['unsafe-inline', 'unsafe-eval', 'wasm-unsafe-eval', 'http:', 'https:', '*', 'blob:', 'data:']) assert.equal(csp.includes(banned), false, banned);
  });

  test(`manifest (${target}): hooks run first, in every frame, before page scripts`, () => {
    const scripts = buildManifest(target, '0.1.0')['content_scripts'] as Array<Record<string, unknown>>;
    assert.equal(scripts.length, 2);
    assert.deepEqual(scripts[0]?.['js'], ['content-main.js']);
    assert.equal(scripts[0]?.['world'], 'MAIN');
    assert.deepEqual(scripts[1]?.['js'], ['content.js']);
    assert.equal('world' in (scripts[1] ?? {}), false);
    for (const s of scripts) {
      assert.equal(s['run_at'], 'document_start');
      assert.equal(s['all_frames'], true);
      assert.equal(s['match_about_blank'], true);
      assert.equal(s['match_origin_as_fallback'], true);
      assert.deepEqual(s['matches'], [...HOST_PERMISSIONS]);
    }
  });
}

test('manifest: Chrome uses a service worker, Firefox an event page with an add-on id and no data collection', () => {
  const chrome = buildManifest('chrome', '0.1.0');
  const firefox = buildManifest('firefox', '0.1.0');
  assert.deepEqual(chrome['background'], { service_worker: 'background.js' });
  assert.equal(chrome['minimum_chrome_version'], '120');
  assert.equal('browser_specific_settings' in chrome, false);
  assert.deepEqual(firefox['background'], { scripts: ['background.js'] });
  assert.equal('minimum_chrome_version' in firefox, false);
  assert.deepEqual(firefox['browser_specific_settings'], { gecko: { id: FIREFOX_ID, strict_min_version: '128.0', data_collection_permissions: { required: ['none'] } } });
});

test('manifest: name and description come from the message catalogs; icons and pages are declared', () => {
  const m = buildManifest('chrome', '0.1.0');
  assert.equal(m['name'], '__MSG_extName__');
  assert.equal(m['description'], '__MSG_extDescription__');
  assert.equal(m['default_locale'], 'en');
  assert.deepEqual(Object.keys(m['icons'] as object), ['16', '32', '48', '128']);
  assert.deepEqual(m['options_ui'], { page: 'options.html', open_in_tab: true });
  assert.equal((m['action'] as { default_popup: string }).default_popup, 'popup.html');
  assert.equal(PERMISSIONS.length, 4);
});

test('source hygiene: no eval, no innerHTML, no document.write, no remote URLs in shipped code', () => {
  const walk = (dir: URL): URL[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(new URL(`${e.name}/`, dir)) : [new URL(e.name, dir)]));
  const banned: Array<[RegExp, string]> = [
    [/\beval\s*\(/, 'eval('],
    [/new Function\s*\(/, 'new Function('],
    [/\.innerHTML\b/, 'innerHTML'],
    [/\.outerHTML\b/, 'outerHTML'],
    [/insertAdjacentHTML/, 'insertAdjacentHTML'],
    [/document\.write\s*\(/, 'document.write('],
    [/\bfetch\s*\(\s*['"`]https?:/, 'fetch of a remote URL'],
    [/XMLHttpRequest|WebSocket\s*\(|sendBeacon|importScripts/, 'network API'],
    [/<script[^>]+src=["']https?:/, 'remote script tag'],
    [/console\.(log|info|debug)\s*\(/, 'console logging'],
  ];
  for (const file of walk(new URL('../src/', import.meta.url))) {
    if (!/\.(ts|html|css)$/.test(file.pathname)) continue;
    const source = readFileSync(file, 'utf8');
    for (const [pattern, name] of banned) assert.equal(pattern.test(source), false, `${name} in ${file.pathname}`);
  }
});

test('source hygiene: the extension pages load only packaged scripts and styles', () => {
  for (const page of ['popup.html', 'options.html', 'download.html']) {
    const html = readFileSync(new URL(`../src/pages/${page}`, import.meta.url), 'utf8');
    assert.equal(/\son[a-z]+\s*=/.test(html), false, `${page} has an inline event handler`);
    assert.equal(/<script(?![^>]*\ssrc=)/.test(html), false, `${page} has an inline script`);
    assert.equal(/style\s*=/.test(html), false, `${page} has an inline style`);
    for (const m of html.matchAll(/(?:src|href)="([^"]+)"/g)) assert.equal(/^[a-z]+:/i.test(m[1] as string), false, `${page} references ${m[1]}`);
  }
});
