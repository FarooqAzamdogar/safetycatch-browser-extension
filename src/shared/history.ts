// Copyright 2026 The SafetyCatch Authors
// SPDX-License-Identifier: Apache-2.0

import { isLevel, type RiskLevel } from './levels.ts';
import { isModuleId, type ModuleId } from './modules.ts';

/**
 * "Recent warnings" shown in the popup. By design an entry holds only the
 * site name, which protection fired, the rule ids, the level, what happened
 * and the time. Never page content, clipboard text, file names or full URLs.
 */
export interface HistoryEntry {
  /** Time (ms since the epoch). */
  t: number;
  /** Site name (registrable domain or host). */
  d: string;
  m: ModuleId;
  l: RiskLevel;
  /** Rule ids, at most {@link MAX_RULE_IDS}. */
  r: string[];
  a: HistoryAction;
}

export const HISTORY_ACTIONS = ['blocked', 'warned', 'noticed', 'unchecked', 'restored', 'proceeded', 'redacted', 'cancelled'] as const;
export type HistoryAction = (typeof HISTORY_ACTIONS)[number];

export const HISTORY_KEY = 'history';
export const HISTORY_CAP = 50;
export const MAX_RULE_IDS = 8;
const DUPLICATE_WINDOW_MS = 10_000;

const DOMAIN_RE = /^[a-z0-9_]([a-z0-9_.-]{0,251}[a-z0-9_])?$/;
const RULE_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function isHistoryAction(value: unknown): value is HistoryAction {
  return typeof value === 'string' && (HISTORY_ACTIONS as readonly string[]).includes(value);
}

/** Keep only well-formed rule ids. Anything that could carry page content is dropped. */
export function cleanRuleIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const id of raw) {
    if (typeof id === 'string' && RULE_ID_RE.test(id) && !out.includes(id)) out.push(id);
    if (out.length >= MAX_RULE_IDS) break;
  }
  return out;
}

/** Build an entry, or null when the site name is not a plain host name. */
export function makeEntry(domain: unknown, module: unknown, level: unknown, ruleIds: unknown, action: unknown, now: number): HistoryEntry | null {
  if (typeof domain !== 'string') return null;
  const d = domain.trim().toLowerCase();
  if (!DOMAIN_RE.test(d)) return null;
  if (!isModuleId(module) || !isLevel(level) || !isHistoryAction(action)) return null;
  return { t: now, d, m: module, l: level, r: cleanRuleIds(ruleIds), a: action };
}

/** Add an entry (newest first), merge quick repeats, and cap the list. */
export function addEntry(list: readonly HistoryEntry[], entry: HistoryEntry): HistoryEntry[] {
  const head = list[0];
  if (head && head.d === entry.d && head.m === entry.m && head.a === entry.a && entry.t - head.t < DUPLICATE_WINDOW_MS && entry.t >= head.t) {
    return [{ ...entry, r: cleanRuleIds([...head.r, ...entry.r]) }, ...list.slice(1)].slice(0, HISTORY_CAP);
  }
  return [entry, ...list].slice(0, HISTORY_CAP);
}

/** Validate a list read from storage. */
export function sanitizeHistory(raw: unknown): HistoryEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: HistoryEntry[] = [];
  for (const item of raw.slice(0, HISTORY_CAP * 2)) {
    if (typeof item !== 'object' || item === null) continue;
    const r = item as Record<string, unknown>;
    if (typeof r['t'] !== 'number' || !Number.isFinite(r['t'])) continue;
    const entry = makeEntry(r['d'], r['m'], r['l'], r['r'], r['a'], r['t']);
    if (entry) out.push(entry);
    if (out.length >= HISTORY_CAP) break;
  }
  return out;
}
