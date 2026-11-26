// Copyright 2026 The SafetyCatch Authors
// SPDX-License-Identifier: Apache-2.0

/**
 * The suite-wide severity scale. A tiny local copy of the engine's level
 * helpers so that content scripts and extension pages never pull the engine
 * (and its Public Suffix List data) into their bundles.
 */
export type RiskLevel = 'safe' | 'low' | 'medium' | 'high' | 'critical';

export const LEVELS: readonly RiskLevel[] = ['safe', 'low', 'medium', 'high', 'critical'];

/** A level, or `unknown` when the check could not be completed ("could not check", never "safe"). */
export type CheckedLevel = RiskLevel | 'unknown';

export function isLevel(value: unknown): value is RiskLevel {
  return typeof value === 'string' && (LEVELS as readonly string[]).includes(value);
}

/** safe 0, low 1, medium 2, high 3, critical 4. */
export function rank(level: RiskLevel): number {
  return LEVELS.indexOf(level);
}

/** True when `level` is at least `min`. `unknown` is never "at least" anything. */
export function atLeast(level: CheckedLevel, min: RiskLevel): boolean {
  return level !== 'unknown' && rank(level) >= rank(min);
}

export function maxOf(...levels: RiskLevel[]): RiskLevel {
  let best: RiskLevel = 'safe';
  for (const l of levels) if (rank(l) > rank(best)) best = l;
  return best;
}
