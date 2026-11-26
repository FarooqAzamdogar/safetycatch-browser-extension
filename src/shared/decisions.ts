// Copyright 2026 The SafetyCatch Authors
// SPDX-License-Identifier: Apache-2.0

/**
 * Decision logic: turns engine levels plus context into what the extension
 * does. Pure functions so every branch is unit-tested. `unknown` always means
 * "the check could not be completed" and never results in a "safe" claim.
 */

import { atLeast, type CheckedLevel, type RiskLevel } from './levels.ts';
import type { Arrival } from './navchain.ts';

/**
 * Where copied text came from:
 * - `programmatic`: the page chose the text itself (clipboard API, execCommand);
 * - `hijack`: the person pressed copy, but the page swapped in different text;
 * - `selection`: the person copied their own visible selection.
 */
export type PasteSource = 'programmatic' | 'hijack' | 'selection';

export const PASTE_SOURCES: readonly PasteSource[] = ['programmatic', 'hijack', 'selection'];

/** `unchecked` = let it through but show a neutral "could not check" notice. */
export type PasteAction = 'allow' | 'notice' | 'block' | 'unchecked';

export interface PasteInput {
  /** Level from `analyzeCommand` for the copied text. */
  command: CheckedLevel;
  /** Level from `analyzePageText` for the page that copied it. */
  page: CheckedLevel;
  source: PasteSource;
  /** Local heuristic: the text looks like a command that fetches or hides something. */
  runnable: boolean;
  /** The page replaced our clipboard hooks with pristine browser functions. */
  tampered?: boolean;
}

export function decidePaste(i: PasteInput): PasteAction {
  const strict = i.source !== 'selection' || i.tampered === true;
  const c = i.command;
  const p = i.page;
  if (c === 'unknown') {
    if (i.runnable) return strict ? 'block' : 'unchecked';
    return strict ? 'unchecked' : 'allow';
  }
  if (strict) {
    if (atLeast(c, 'high')) return 'block';
    if (atLeast(p, 'high') && (atLeast(c, 'low') || i.runnable || i.tampered === true)) return 'block';
    if (c === 'medium') return atLeast(p, 'medium') || i.tampered === true ? 'block' : 'notice';
    return 'allow';
  }
  // The person copied their own selection: be gentler unless the page also shows a lure.
  if (c === 'critical') return 'block';
  if (c === 'high') return atLeast(p, 'medium') ? 'block' : 'notice';
  if (c === 'medium' && atLeast(p, 'high')) return 'block';
  return 'allow';
}

export type LoginUi = 'none' | 'banner' | 'intercept';

/**
 * Password page. Typing is intercepted only when the verdict is high AND at
 * least one single finding is high on its own (a brand look-alike, a sign-in
 * form on free hosting...). Several small signals that merely add up (plain
 * http plus an unusual port) get a banner, not a wall.
 */
export function decideLogin(level: CheckedLevel, topFinding: RiskLevel): LoginUi {
  if (level === 'unknown') return 'none';
  if (atLeast(level, 'high') && atLeast(topFinding, 'high')) return 'intercept';
  if (atLeast(level, 'medium')) return 'banner';
  return 'none';
}

export type AuthFlow = 'device-code' | 'oauth-consent' | 'admin-consent' | 'impersonation' | 'none';

export function asAuthFlow(value: unknown): AuthFlow {
  return value === 'device-code' || value === 'oauth-consent' || value === 'admin-consent' || value === 'impersonation' ? value : 'none';
}

export interface AuthDecision {
  ui: 'none' | 'banner' | 'interstitial';
  /** Level shown to the person (may be raised above the engine's). */
  level: RiskLevel;
  /** True when the level was raised because of how the person arrived. */
  raised: boolean;
}

/**
 * Device-code and app-approval pages. Reaching one from a link outside the
 * browser (an email or chat app) raises a medium verdict to high: that is how
 * device-code phishing is delivered. Look-alike identity-provider pages
 * (`impersonation`) are left to the look-alike sign-in protection.
 */
export function decideAuth(level: CheckedLevel, flow: AuthFlow, arrival: Arrival): AuthDecision {
  if (level === 'unknown' || flow === 'none' || flow === 'impersonation') return { ui: 'none', level: 'safe', raised: false };
  let shown: RiskLevel = level;
  let raised = false;
  if (arrival === 'external' && level === 'medium') {
    shown = 'high';
    raised = true;
  }
  if (atLeast(shown, 'high')) return { ui: 'interstitial', level: shown, raised };
  if (shown === 'medium') return { ui: 'banner', level: shown, raised };
  return { ui: 'none', level: shown, raised };
}

export type LureUi = 'none' | 'notice' | 'warn';

/** Notice on publish-anything platforms: calm when instructions are present, stronger when they are a known lure. */
export function decideLure(isPlatform: boolean, page: CheckedLevel, hasInstructions: boolean): LureUi {
  if (!isPlatform) return 'none';
  if (atLeast(page, 'high')) return 'warn';
  return hasInstructions ? 'notice' : 'none';
}

export type AiPasteAction = 'allow' | 'prompt' | 'unchecked';

/** Pasting into an AI chat: stop for medium or worse (keys, passwords, card and ID numbers), not for low (emails, phones). */
export function decideAiPaste(level: CheckedLevel): AiPasteAction {
  if (level === 'unknown') return 'unchecked';
  return atLeast(level, 'medium') ? 'prompt' : 'allow';
}

export type DownloadAction = 'none' | 'ask';

export function decideDownload(level: CheckedLevel): DownloadAction {
  return atLeast(level, 'high') ? 'ask' : 'none';
}
