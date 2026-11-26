// Copyright 2026 The SafetyCatch Authors
// SPDX-License-Identifier: Apache-2.0

/**
 * Cheap pre-filter for "is this a site where anyone can publish?". It only
 * decides whether a content script should ask the service worker; the engine
 * (`analyzeUrl(...).meta.platform`) stays the authority. The host and path
 * list is generated from the engine's own `PLATFORMS` table
 * (scripts/engine-tables.ts), so the two cannot drift apart.
 */

import { PLATFORM_HINTS as HINTS } from './engine-tables.ts';

/** True when the page might be user-published content on a well-known platform. */
export function isPlatformHint(hostname: string, pathname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, '');
  const p = pathname.toLowerCase();
  for (const [host, ...paths] of HINTS) {
    if (h !== host && !h.endsWith(`.${host}`)) continue;
    if (paths.length === 0 || paths.some((prefix) => p.startsWith(prefix))) return true;
  }
  return false;
}
