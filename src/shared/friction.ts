// Copyright 2026 The SafetyCatch Authors
// SPDX-License-Identifier: Apache-2.0

/**
 * "Escape hatch with friction": risky choices need a deliberate press-and-hold
 * (or typing a word), never a single reflexive click. Pure state machine; the
 * UI feeds it trusted events only.
 */
export const HOLD_MS = 1500;

export interface HoldState {
  /** Time the hold started, or null when nothing is being held. */
  readonly startedAt: number | null;
}

export const HOLD_IDLE: HoldState = { startedAt: null };

/** Start a hold. Synthetic (untrusted) events never start one. */
export function holdStart(now: number, trusted: boolean): HoldState {
  return trusted ? { startedAt: now } : HOLD_IDLE;
}

/** Progress from 0 to 1. */
export function holdProgress(state: HoldState, now: number, holdMs = HOLD_MS): number {
  if (state.startedAt === null) return 0;
  const elapsed = now - state.startedAt;
  if (!(elapsed > 0)) return 0;
  return Math.min(1, elapsed / holdMs);
}

/** True once the control has been held long enough. A clock that runs backwards never confirms. */
export function holdComplete(state: HoldState, now: number, holdMs = HOLD_MS): boolean {
  return state.startedAt !== null && now - state.startedAt >= holdMs;
}

/** Compare a typed confirmation word: case-insensitive, surrounding space ignored, Unicode-normalised. */
export function phraseMatches(typed: string, phrase: string): boolean {
  const norm = (s: string): string => s.normalize('NFKC').trim().toLocaleLowerCase();
  const want = norm(phrase);
  return want.length > 0 && norm(typed) === want;
}
