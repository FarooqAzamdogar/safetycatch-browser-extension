// Copyright 2026 The ActionGuard Authors
// SPDX-License-Identifier: Apache-2.0

import { normalizeHost } from './allowlist.ts';

/** A site on the AI-chat list: a host, optionally limited to a path prefix (`huggingface.co/chat`). */
export interface SitePattern {
  host: string;
  /** Empty, or a path that starts with "/" and has no trailing slash. */
  path: string;
}

/** Parse "chatgpt.com", "https://huggingface.co/chat/" and similar. Returns null for anything else. */
export function parseSitePattern(input: unknown): SitePattern | null {
  if (typeof input !== 'string') return null;
  const raw = input.trim();
  if (raw.length === 0 || raw.length > 300) return null;
  const host = normalizeHost(raw);
  if (host === null) return null;
  const rest = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  const slash = rest.indexOf('/');
  let path = slash < 0 ? '' : rest.slice(slash).replace(/[?#].*$/, '');
  path = path.replace(/\/+$/, '').toLowerCase();
  if (path.length > 200 || /[\s\\]/.test(path)) return null;
  return { host, path };
}

export function formatSitePattern(p: SitePattern): string {
  return p.host + p.path;
}

/** True when the page (host + path) is on the list. Sub-domains of a listed host count too. */
export function matchesSite(hostname: string, pathname: string, patterns: readonly string[]): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, '');
  const p = pathname.toLowerCase();
  for (const raw of patterns) {
    const pat = parseSitePattern(raw);
    if (!pat) continue;
    if (h !== pat.host && !h.endsWith(`.${pat.host}`)) continue;
    if (pat.path === '' || p === pat.path || p.startsWith(`${pat.path}/`)) return true;
  }
  return false;
}

export function isHttpUrl(url: unknown): url is string {
  return typeof url === 'string' && /^https?:\/\//i.test(url);
}

/** Lower-case host of an http(s) URL, or null. */
export function hostOf(url: unknown): string | null {
  if (!isHttpUrl(url)) return null;
  try {
    return new URL(url).hostname.toLowerCase().replace(/\.$/, '') || null;
  } catch {
    return null;
  }
}

/** Origin plus path, without query or fragment: the key used to remember "I chose to continue here". */
export function originPath(url: unknown): string | null {
  if (!isHttpUrl(url)) return null;
  try {
    const u = new URL(url);
    return u.origin + u.pathname;
  } catch {
    return null;
  }
}
