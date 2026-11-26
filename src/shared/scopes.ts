// Copyright 2026 The SafetyCatch Authors
// SPDX-License-Identifier: Apache-2.0

/**
 * Groups the permissions ("scopes") an app asks for so the warning can list
 * them in plain language. Risky categories come from the engine
 * (`verdict.meta.scopes`); this module adds two friendly buckets for the rest.
 */

import { isLevel, rank, type RiskLevel } from './levels.ts';

export interface ScopeInfo {
  scope: string;
  category?: string;
  severity?: RiskLevel;
}

export interface ScopeGroup {
  /** An engine category (`mail-send`...), `basic` (name, email, profile) or `other`. */
  category: string;
  scopes: string[];
  severity: RiskLevel;
}

const MAX_SCOPES = 60;

const BASIC_RE =
  /^(?:openid|profile|email|user\.read|user:email|read:user|identify|userinfo\.(?:email|profile)|https:\/\/www\.googleapis\.com\/auth\/userinfo\.(?:email|profile)|account_info\.read|users:read|identity\.basic|identity\.email)$/i;
const CATEGORY_RE = /^[a-z][a-z-]{0,30}$/;

/** Read `meta.scopes` defensively: it crossed a message boundary and is shown to the person. */
export function parseScopes(meta: unknown): ScopeInfo[] {
  if (!Array.isArray(meta)) return [];
  const out: ScopeInfo[] = [];
  for (const item of meta.slice(0, MAX_SCOPES)) {
    if (typeof item !== 'object' || item === null) continue;
    const r = item as Record<string, unknown>;
    if (typeof r['scope'] !== 'string' || r['scope'].length === 0) continue;
    const info: ScopeInfo = { scope: r['scope'].slice(0, 120) };
    if (typeof r['category'] === 'string' && CATEGORY_RE.test(r['category'])) info.category = r['category'];
    if (isLevel(r['severity'])) info.severity = r['severity'];
    out.push(info);
  }
  return out;
}

export function isBasicScope(scope: string): boolean {
  return BASIC_RE.test(scope.trim());
}

/** Group scopes by category, most serious group first; `basic` and `other` come last. */
export function groupScopes(scopes: readonly ScopeInfo[]): ScopeGroup[] {
  const groups = new Map<string, ScopeGroup>();
  for (const s of scopes) {
    const category = s.category ?? (isBasicScope(s.scope) ? 'basic' : 'other');
    const severity: RiskLevel = s.category ? (s.severity ?? 'medium') : category === 'basic' ? 'safe' : 'low';
    const g = groups.get(category) ?? { category, scopes: [], severity: 'safe' };
    if (!g.scopes.includes(s.scope)) g.scopes.push(s.scope);
    if (rank(severity) > rank(g.severity)) g.severity = severity;
    groups.set(category, g);
  }
  const order = (g: ScopeGroup): number => (g.category === 'basic' ? -2 : g.category === 'other' ? -1 : rank(g.severity));
  return [...groups.values()].sort((a, b) => order(b) - order(a));
}
