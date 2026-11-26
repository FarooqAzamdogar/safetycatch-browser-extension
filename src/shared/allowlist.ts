// Copyright 2026 The SafetyCatch Authors
// SPDX-License-Identifier: Apache-2.0

/** A site the person chose to trust. Warnings are switched off there until `expiresAt`. */
export interface TrustEntry {
  /** Host name (`example.com`) or wildcard (`*.example.com`: the site and all its sub-sites). */
  pattern: string;
  addedAt: number;
  /** Milliseconds since the epoch, or null for "until I remove it". */
  expiresAt: number | null;
}

export const MAX_TRUST_ENTRIES = 200;

/** Choices offered in the UI. `null` means no end date. */
export const TRUST_DURATIONS: Readonly<Record<string, number | null>> = {
  hour: 60 * 60 * 1000,
  day: 24 * 60 * 60 * 1000,
  month: 30 * 24 * 60 * 60 * 1000,
  forever: null,
};

const LABEL_RE = /^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/;

/**
 * Turn user input (a host, or a pasted URL) into a lower-case ASCII host name.
 * Returns null for anything that is not a plain host: no schemes other than
 * http/https, no credentials, no spaces.
 */
export function normalizeHost(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  let s = input.trim().toLowerCase();
  if (s.length === 0 || s.length > 300 || /[\s\\@]/.test(s)) return null;
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//.exec(s);
  if (scheme) {
    if (scheme[1] !== 'http' && scheme[1] !== 'https') return null;
    s = s.slice(scheme[0].length);
  }
  s = s.replace(/[/?#].*$/, '');
  if (s.startsWith('[')) return null; // IPv6 literals are not supported in the allowlist
  s = s.replace(/:\d{1,5}$/, '').replace(/\.$/, '');
  if (s.length === 0 || s.length > 253) return null;
  if (/[^\x00-\x7f]/.test(s)) {
    try {
      s = new URL(`http://${s}/`).hostname;
    } catch {
      return null;
    }
  }
  const labels = s.split('.');
  if (labels.some((l) => !LABEL_RE.test(l))) return null;
  return s;
}

/**
 * Validate an allowlist pattern. `*.example.com` needs at least two labels
 * after the star, and `isShared` (when given) can veto bases such as public
 * suffixes or hosting platforms where every sub-site belongs to someone else.
 */
export function normalizePattern(input: unknown, isShared?: (base: string) => boolean): string | null {
  if (typeof input !== 'string') return null;
  const raw = input.trim().toLowerCase();
  const wildcard = raw.startsWith('*.');
  const host = normalizeHost(wildcard ? raw.slice(2) : raw);
  if (host === null) return null;
  if (!wildcard) return host;
  if (host.split('.').length < 2 || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return null;
  if (isShared?.(host)) return null;
  return `*.${host}`;
}

const stripWww = (h: string): string => (h.startsWith('www.') ? h.slice(4) : h);

/** True when `host` is covered by `pattern`. `www.` is ignored for exact entries. */
export function matchesPattern(host: string, pattern: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  if (pattern.startsWith('*.')) {
    const base = pattern.slice(2);
    return h === base || h.endsWith(`.${base}`);
  }
  return h === pattern || stripWww(h) === stripWww(pattern);
}

export function isExpired(entry: TrustEntry, now: number): boolean {
  return entry.expiresAt !== null && entry.expiresAt <= now;
}

/** The live (not expired) entry that covers `host`, if any. */
export function findTrust(host: string | null | undefined, list: readonly TrustEntry[], now: number): TrustEntry | undefined {
  if (!host) return undefined;
  return list.find((e) => !isExpired(e, now) && matchesPattern(host, e.pattern));
}

export function pruneExpired(list: readonly TrustEntry[], now: number): TrustEntry[] {
  return list.filter((e) => !isExpired(e, now));
}

/** Add or refresh an entry. Expired entries are dropped; the list is capped (oldest removed first). */
export function addTrust(list: readonly TrustEntry[], pattern: string, now: number, durationMs: number | null): TrustEntry[] {
  const entry: TrustEntry = { pattern, addedAt: now, expiresAt: durationMs === null ? null : now + Math.max(0, durationMs) };
  const rest = pruneExpired(list, now).filter((e) => e.pattern !== pattern);
  return [...rest, entry].slice(-MAX_TRUST_ENTRIES);
}

export function removeTrust(list: readonly TrustEntry[], pattern: string): TrustEntry[] {
  return list.filter((e) => e.pattern !== pattern);
}

/** Accept only well-formed entries from storage or an imported file. */
export function sanitizeTrustList(raw: unknown, now: number): TrustEntry[] {
  if (!Array.isArray(raw)) return [];
  const out = new Map<string, TrustEntry>();
  for (const item of raw.slice(0, MAX_TRUST_ENTRIES * 2)) {
    if (typeof item !== 'object' || item === null) continue;
    const r = item as Record<string, unknown>;
    const pattern = normalizePattern(r['pattern']);
    if (pattern === null) continue;
    const addedAt = typeof r['addedAt'] === 'number' && Number.isFinite(r['addedAt']) ? r['addedAt'] : now;
    const exp = r['expiresAt'];
    const expiresAt = exp === null || exp === undefined ? null : typeof exp === 'number' && Number.isFinite(exp) ? exp : now;
    const entry: TrustEntry = { pattern, addedAt, expiresAt };
    if (!isExpired(entry, now)) out.set(pattern, entry);
  }
  return [...out.values()].slice(-MAX_TRUST_ENTRIES);
}
