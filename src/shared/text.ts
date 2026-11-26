// Copyright 2026 The ActionGuard Authors
// SPDX-License-Identifier: Apache-2.0

/**
 * Code-point ranges of characters that are invisible or reorder text (control
 * characters, soft hyphen, zero-width and bidi controls, variation selectors,
 * Hangul fillers). They are listed as numbers so this file never contains the
 * characters themselves.
 */
const HIDDEN_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0000, 0x0008],
  [0x000b, 0x000c],
  [0x000e, 0x001f],
  [0x007f, 0x009f],
  [0x00ad, 0x00ad],
  [0x034f, 0x034f],
  [0x061c, 0x061c],
  [0x115f, 0x1160],
  [0x17b4, 0x17b5],
  [0x180b, 0x180e],
  [0x200b, 0x200f],
  [0x2028, 0x202f],
  [0x205f, 0x206f],
  [0x3164, 0x3164],
  [0xfe00, 0xfe0f],
  [0xfeff, 0xfeff],
  [0xffa0, 0xffa0],
  [0xfff9, 0xfffb],
];

const unit = (n: number): string => `\\u${n.toString(16).padStart(4, '0')}`;
const HIDDEN_CLASS = `[${HIDDEN_RANGES.map(([a, b]) => (a === b ? unit(a) : `${unit(a)}-${unit(b)}`)).join('')}]`;
const HIDDEN_ALL = new RegExp(HIDDEN_CLASS, 'g');
const HIDDEN_ONE = new RegExp(HIDDEN_CLASS);

/** Shorten to at most `max` UTF-16 units without splitting a surrogate pair. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = Math.max(0, max);
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

/** Replace invisible and bidi-control characters with a visible `<U+XXXX>` marker, so a warning cannot be spoofed by them. */
export function revealHidden(text: string): string {
  return text.replace(HIDDEN_ALL, (c) => `<U+${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}>`);
}

/** True when the text carries invisible or bidi-control characters. */
export function hasHidden(text: string): boolean {
  return HIDDEN_ONE.test(text);
}

export interface Sample {
  /** Text that is safe to show with `textContent`. */
  text: string;
  /** How many characters of the original are not shown. */
  hiddenChars: number;
}

/**
 * Prepare copied text for display inside a warning: hidden characters become
 * visible, long runs of spaces (used to push the real command out of sight) are
 * collapsed to a marker, and the result is cut to a few lines.
 */
export function displaySample(input: string, maxChars = 600, maxLines = 12): Sample {
  const capped = clip(input, 20_000);
  const clean = revealHidden(capped)
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, '  ')
    .replace(/ {12,}/g, (run) => ` [${run.length} spaces] `)
    .replace(/\n{4,}/g, (run) => `\n[${run.length} blank lines]\n`);
  const lines = clean.split('\n');
  const kept = lines.slice(0, maxLines).join('\n');
  const shown = clip(kept, maxChars);
  const hiddenChars = clean.length - shown.length + (input.length - capped.length);
  return { text: shown, hiddenChars: Math.max(0, hiddenChars) };
}

/** Collapse whitespace for loose comparisons ("is what was copied the same as what was selected?"). */
export function squash(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
