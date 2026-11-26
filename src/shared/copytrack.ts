// Copyright 2026 The SafetyCatch Authors
// SPDX-License-Identifier: Apache-2.0

/**
 * Works out what ended up on the clipboard after a `copy` or `cut` event.
 * These events are synchronous, so the guard cannot stop them first; it
 * collects what it could observe and checks the possible results afterwards
 * ("detect, then neutralise").
 */

import type { PasteSource } from './decisions.ts';
import { clip, squash } from './text.ts';

export interface CopyContext {
  /** The page started the copy itself (execCommand), or nothing suggests the person pressed copy. */
  programmatic: boolean;
  /** Text passed to `clipboardData.setData('text/plain', ...)` during the event, in order. */
  setData: string[];
  /** Selected text read at different moments of the event, in order. */
  selections: string[];
  /** `clipboardData.getData('text/plain')` read at the end of the event, when we got that far. */
  finalData: string | null;
  /** Whether the page cancelled the default copy; null when the page hid the event from us. */
  defaultPrevented: boolean | null;
}

export interface Candidate {
  text: string;
  source: PasteSource;
}

export const MAX_CANDIDATES = 3;
export const MAX_CANDIDATE_CHARS = 100_000;

export function newCopyContext(programmatic: boolean): CopyContext {
  return { programmatic, setData: [], selections: [], finalData: null, defaultPrevented: null };
}

function sourceOf(ctx: CopyContext, text: string, fromSetData: boolean): PasteSource {
  if (ctx.programmatic) return 'programmatic';
  if (!fromSetData) return 'selection';
  const t = squash(text);
  return ctx.selections.some((s) => squash(s) === t) ? 'selection' : 'hijack';
}

/** The texts that may now be on the clipboard, most likely first. */
export function copyCandidates(ctx: CopyContext): Candidate[] {
  const out: Candidate[] = [];
  const seen = new Set<string>();
  const add = (text: string | null | undefined, fromSetData: boolean): void => {
    if (typeof text !== 'string' || out.length >= MAX_CANDIDATES) return;
    const key = squash(text);
    if (key.length === 0 || seen.has(key)) return;
    seen.add(key);
    out.push({ text: clip(text, MAX_CANDIDATE_CHARS), source: sourceOf(ctx, text, fromSetData) });
  };
  const lastSet = ctx.setData[ctx.setData.length - 1];
  const selections = [...ctx.selections].reverse();
  if (ctx.defaultPrevented === true) {
    // The page supplied the clipboard content itself.
    add(ctx.finalData, true);
    add(lastSet, true);
  } else if (ctx.defaultPrevented === false) {
    // The browser copied the selection.
    for (const s of selections) add(s, false);
  } else {
    // The page stopped the event before we saw its end: consider both.
    add(lastSet, true);
    for (const s of selections) add(s, false);
  }
  return out;
}
