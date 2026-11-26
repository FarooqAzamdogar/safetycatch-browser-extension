// Copyright 2026 The ActionGuard Authors
// SPDX-License-Identifier: Apache-2.0
//
// The extension manifest, generated per browser. Kept in code so tests can
// assert the security-relevant parts (permissions, CSP, script worlds).

import { ICON_SIZES } from './icons.ts';

export type Target = 'chrome' | 'firefox';
export const TARGETS: readonly Target[] = ['chrome', 'firefox'];

/** Every permission is justified in docs/PERMISSIONS.md. Do not add one without updating it. */
export const PERMISSIONS = ['storage', 'webNavigation', 'downloads', 'clipboardWrite'] as const;

/** Web pages only: no file://, ftp:// or browser pages. */
export const HOST_PERMISSIONS = ['http://*/*', 'https://*/*'] as const;

/** Extension pages may load only their own packaged files. No remote code, no inline script, no eval. */
export const EXTENSION_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/** Placeholder add-on id for Firefox; the owner replaces it before a store submission. */
export const FIREFOX_ID = 'actionguard-browser@actionguard.example';

export const MIN_CHROME = '120';
export const MIN_FIREFOX = '128.0';

export function buildManifest(target: Target, version: string): Record<string, unknown> {
  const icons = Object.fromEntries(ICON_SIZES.map((s) => [String(s), `icons/icon-${s}.png`]));
  const everyFrame = {
    matches: [...HOST_PERMISSIONS],
    run_at: 'document_start',
    all_frames: true,
    match_about_blank: true,
    match_origin_as_fallback: true,
  };
  const manifest: Record<string, unknown> = {
    manifest_version: 3,
    name: '__MSG_extName__',
    short_name: 'ActionGuard',
    description: '__MSG_extDescription__',
    version,
    default_locale: 'en',
    icons,
    action: { default_title: 'ActionGuard', default_popup: 'popup.html', default_icon: icons },
    options_ui: { page: 'options.html', open_in_tab: true },
    permissions: [...PERMISSIONS],
    host_permissions: [...HOST_PERMISSIONS],
    content_scripts: [
      // Page-world clipboard hooks first, then the content script that owns the logic and the UI.
      { ...everyFrame, js: ['content-main.js'], world: 'MAIN' },
      { ...everyFrame, js: ['content.js'] },
    ],
    content_security_policy: { extension_pages: EXTENSION_CSP },
  };
  if (target === 'chrome') {
    manifest['minimum_chrome_version'] = MIN_CHROME;
    manifest['background'] = { service_worker: 'background.js' };
  } else {
    // Firefox runs Manifest V3 background code as an event page, not a service worker.
    manifest['background'] = { scripts: ['background.js'] };
    manifest['browser_specific_settings'] = {
      gecko: { id: FIREFOX_ID, strict_min_version: MIN_FIREFOX, data_collection_permissions: { required: ['none'] } },
    };
  }
  return manifest;
}
