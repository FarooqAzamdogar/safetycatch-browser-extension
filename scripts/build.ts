// Copyright 2026 The ActionGuard Authors
// SPDX-License-Identifier: Apache-2.0
//
// Builds the extension for Chrome/Edge and for Firefox:
//   dist/chrome/, dist/firefox/                     load these as unpacked extensions
//   dist/actionguard-browser-<version>-<target>.zip  store uploads (no source maps inside)
//   dist/sourcemaps/<target>/                        readable source maps, kept out of the zips

import { build } from 'esbuild';
import { cpSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ICON_SIZES, iconPng } from './icons.ts';
import { localeFolders, messagesJson } from './locales.ts';
import { buildManifest, TARGETS, type Target } from './manifest.ts';
import { createZip, type ZipEntry } from './zip.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string; name: string };

/** Size limits in bytes. They catch accidents such as the engine being pulled into a per-page script. */
const BUDGETS: Readonly<Record<string, number>> = { 'content-main.js': 12_000, 'content.js': 80_000, 'popup.js': 40_000, 'options.js': 40_000, 'download.js': 60_000, 'background.js': 700_000 };

const ENTRIES = {
  background: 'src/background/service-worker.ts',
  content: 'src/content/isolated.ts',
  'content-main': 'src/content/main-world.ts',
  popup: 'src/pages/popup.ts',
  options: 'src/pages/options.ts',
  download: 'src/pages/download.ts',
};

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
}

async function buildTarget(target: Target): Promise<Array<[string, number]>> {
  const out = join(dist, target);
  mkdirSync(out, { recursive: true });
  await build({
    absWorkingDir: root,
    entryPoints: ENTRIES,
    outdir: out,
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: target === 'chrome' ? ['chrome120'] : ['firefox128'],
    minify: true,
    sourcemap: 'external',
    legalComments: 'none',
    charset: 'utf8',
    logLevel: 'warning',
  });
  const maps = join(dist, 'sourcemaps', target);
  mkdirSync(maps, { recursive: true });
  for (const file of readdirSync(out)) if (file.endsWith('.map')) renameSync(join(out, file), join(maps, file));

  for (const file of ['popup.html', 'options.html', 'download.html', 'pages.css']) cpSync(join(root, 'src', 'pages', file), join(out, file));
  for (const { folder, locale } of localeFolders()) {
    mkdirSync(join(out, '_locales', folder), { recursive: true });
    writeFileSync(join(out, '_locales', folder, 'messages.json'), `${JSON.stringify(messagesJson(locale), null, 1)}\n`);
  }
  mkdirSync(join(out, 'icons'), { recursive: true });
  for (const size of ICON_SIZES) writeFileSync(join(out, 'icons', `icon-${size}.png`), iconPng(size));
  writeFileSync(join(out, 'manifest.json'), `${JSON.stringify(buildManifest(target, pkg.version), null, 2)}\n`);
  cpSync(join(root, 'LICENSE'), join(out, 'LICENSE.txt'));
  cpSync(join(root, 'NOTICE'), join(out, 'NOTICE.txt'));

  const sizes: Array<[string, number]> = [];
  for (const [file, limit] of Object.entries(BUDGETS)) {
    const size = statSync(join(out, file)).size;
    sizes.push([file, size]);
    if (size > limit) throw new Error(`${target}/${file} is ${size} bytes, over its budget of ${limit}. Did the engine get bundled into a page script?`);
  }

  const entries: ZipEntry[] = walk(out).map((path) => ({ name: relative(out, path).split('\\').join('/'), data: readFileSync(path) }));
  if (entries.some((e) => e.name.endsWith('.map'))) throw new Error('Source maps must not be packaged');
  const zip = createZip(entries);
  const zipName = `${pkg.name}-${pkg.version}-${target}.zip`;
  writeFileSync(join(dist, zipName), zip);
  sizes.push([zipName, zip.length]);
  return sizes;
}

rmSync(dist, { recursive: true, force: true });
for (const target of TARGETS) {
  const sizes = await buildTarget(target);
  console.log(`\n${target}`);
  for (const [file, size] of sizes) console.log(`  ${file.padEnd(44)} ${(size / 1024).toFixed(1).padStart(8)} KB`);
}
console.log(`\nBuilt ${pkg.name} ${pkg.version} into dist/ (unpacked folders and zip files).`);
