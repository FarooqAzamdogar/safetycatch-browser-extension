// Copyright 2026 The ActionGuard Authors
// SPDX-License-Identifier: Apache-2.0

import { clip } from './text.ts';

/** A download waiting for the person's decision. Kept in session storage only (memory, never disk). */
export interface PendingDownload {
  id: number;
  name: string;
  url: string;
  referrer: string;
  pageUrl: string;
  /** True when the file had already finished downloading before it could be paused. */
  finished: boolean;
  decided: boolean;
  t: number;
}

export const MAX_PENDING = 20;

/** Last segment of a Windows or POSIX path. */
export function baseName(path: unknown): string {
  if (typeof path !== 'string') return '';
  const parts = path.split(/[\\/]/);
  return clip((parts[parts.length - 1] ?? '').trim(), 300);
}

/** File name taken from the last path segment of an http(s) URL. Empty for `data:` and `blob:` URLs. */
export function nameFromUrl(url: unknown): string {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return '';
  try {
    const segments = new URL(url).pathname.split('/');
    const last = segments[segments.length - 1] ?? '';
    let decoded = last;
    try {
      decoded = decodeURIComponent(last);
    } catch {
      // keep the raw segment
    }
    return baseName(decoded);
  } catch {
    return '';
  }
}

/** Best name known for a download: the name the browser chose, else the one in the address. */
export function downloadName(filename: unknown, url: unknown): string {
  return baseName(filename) || nameFromUrl(url);
}

/** True when the name carries a file extension, so it is worth judging already. */
export function hasExtension(name: string): boolean {
  return /\.[^.\s\\/]{1,12}$/.test(name.trim());
}

export type DownloadChoice = 'resume' | 'cancel' | 'delete' | 'keep';
export type DownloadOp = 'resume' | 'cancel' | 'removeFile' | 'erase';

/**
 * What to do with the browser's download for a choice. A finished file can
 * only be kept or deleted; an unfinished one can only be resumed or cancelled.
 * Anything else is refused (null).
 */
export function opsForChoice(choice: DownloadChoice, finished: boolean): DownloadOp[] | null {
  if (finished) {
    if (choice === 'keep') return [];
    if (choice === 'delete') return ['removeFile', 'erase'];
    return null;
  }
  if (choice === 'resume') return ['resume'];
  if (choice === 'cancel') return ['cancel', 'erase'];
  return null;
}

/** Validate the pending table read from session storage, dropping old entries. */
export function sanitizePending(raw: unknown, now: number, maxAgeMs = 60 * 60 * 1000): Record<string, PendingDownload> {
  const out: Record<string, PendingDownload> = {};
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return out;
  const items: PendingDownload[] = [];
  for (const value of Object.values(raw as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) continue;
    const r = value as Record<string, unknown>;
    if (typeof r['id'] !== 'number' || !Number.isInteger(r['id']) || typeof r['t'] !== 'number' || now - r['t'] > maxAgeMs) continue;
    const str = (v: unknown, max: number): string => (typeof v === 'string' ? clip(v, max) : '');
    items.push({ id: r['id'], name: str(r['name'], 300), url: str(r['url'], 2000), referrer: str(r['referrer'], 2000), pageUrl: str(r['pageUrl'], 2000), finished: r['finished'] === true, decided: r['decided'] === true, t: r['t'] });
  }
  for (const item of items.sort((a, b) => b.t - a.t).slice(0, MAX_PENDING)) out[String(item.id)] = item;
  return out;
}
