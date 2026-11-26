// Copyright 2026 The ActionGuard Authors
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HOLD_IDLE, HOLD_MS, holdComplete, holdProgress, holdStart, phraseMatches } from '../src/shared/friction.ts';
import { atLeast, isLevel, LEVELS, maxOf, rank } from '../src/shared/levels.ts';
import { isModuleId, MODULE_IDS } from '../src/shared/modules.ts';
import { clip, displaySample, hasHidden, revealHidden, squash } from '../src/shared/text.ts';

const ch = (cp: number): string => String.fromCodePoint(cp);

test('levels: order runs from safe to critical', () => {
  assert.deepEqual([...LEVELS], ['safe', 'low', 'medium', 'high', 'critical']);
  assert.equal(rank('safe'), 0);
  assert.equal(rank('critical'), 4);
});

test('levels: atLeast compares levels and never accepts "unknown"', () => {
  assert.equal(atLeast('high', 'high'), true);
  assert.equal(atLeast('critical', 'high'), true);
  assert.equal(atLeast('medium', 'high'), false);
  assert.equal(atLeast('unknown', 'safe'), false);
});

test('levels: maxOf picks the most severe and defaults to safe', () => {
  assert.equal(maxOf('low', 'critical', 'medium'), 'critical');
  assert.equal(maxOf(), 'safe');
});

test('levels: isLevel rejects other values', () => {
  assert.equal(isLevel('high'), true);
  for (const bad of ['HIGH', 'unknown', '', 3, null, undefined]) assert.equal(isLevel(bad), false);
});

test('modules: six protections with stable ids', () => {
  assert.deepEqual([...MODULE_IDS], ['pasteGuard', 'authFlow', 'lookalike', 'platformLure', 'aiPaste', 'downloads']);
  assert.equal(isModuleId('aiPaste'), true);
  assert.equal(isModuleId('toString'), false);
});

test('text: clip shortens without splitting a surrogate pair', () => {
  assert.equal(clip('hello', 10), 'hello');
  assert.equal(clip('hello', 3), 'hel');
  const emoji = ch(0x1f600);
  assert.equal(clip(`ab${emoji}`, 3), 'ab');
  assert.equal(clip('abc', 0), '');
});

test('text: invisible and bidi characters are made visible', () => {
  const hidden = `safe${ch(0x202e)}exe.txt${ch(0x200b)}`;
  assert.equal(hasHidden(hidden), true);
  assert.equal(hasHidden('plain text\nwith a tab\t'), false);
  assert.equal(revealHidden(hidden), 'safe<U+202E>exe.txt<U+200B>');
});

test('text: hasHidden gives the same answer when called repeatedly', () => {
  const s = `a${ch(0x200d)}b`;
  assert.equal(hasHidden(s), true);
  assert.equal(hasHidden(s), true);
  assert.equal(hasHidden('ab'), false);
});

test('text: displaySample collapses the space padding used to hide a command', () => {
  const sample = displaySample(`run-this${' '.repeat(90)}# C:\\Users\\Public\\Policy.docx`);
  assert.match(sample.text, /run-this \[90 spaces\] # C:/);
});

test('text: displaySample limits lines and characters and reports what is hidden', () => {
  const long = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n');
  const byLines = displaySample(long, 600, 5);
  assert.equal(byLines.text.split('\n').length, 5);
  assert.ok(byLines.hiddenChars > 0);
  const byChars = displaySample('x'.repeat(5000), 100);
  assert.equal(byChars.text.length, 100);
  assert.equal(byChars.hiddenChars, 4900);
  assert.equal(displaySample('short').hiddenChars, 0);
});

test('text: displaySample normalises line endings and shows blank-line padding', () => {
  assert.equal(displaySample('a\r\nb\rc').text, 'a\nb\nc');
  assert.match(displaySample(`a${'\n'.repeat(30)}b`).text, /\[30 blank lines\]/);
});

test('text: squash collapses whitespace', () => {
  assert.equal(squash('  a \n\t b  '), 'a b');
});

test('friction: a hold must last the full time', () => {
  const s = holdStart(1000, true);
  assert.equal(holdComplete(s, 1000 + HOLD_MS - 1), false);
  assert.equal(holdComplete(s, 1000 + HOLD_MS), true);
});

test('friction: synthetic (untrusted) input never starts a hold', () => {
  const s = holdStart(1000, false);
  assert.deepEqual(s, HOLD_IDLE);
  assert.equal(holdComplete(s, 1_000_000), false);
});

test('friction: progress runs from 0 to 1 and is 0 when idle or when the clock goes backwards', () => {
  const s = holdStart(1000, true);
  assert.equal(holdProgress(s, 1000), 0);
  assert.equal(holdProgress(s, 1000 + HOLD_MS / 2), 0.5);
  assert.equal(holdProgress(s, 1000 + HOLD_MS * 3), 1);
  assert.equal(holdProgress(s, 500), 0);
  assert.equal(holdProgress(HOLD_IDLE, 5000), 0);
  assert.equal(holdComplete(s, 500), false);
});

test('friction: the typed word is compared loosely but must be the right word', () => {
  assert.equal(phraseMatches('  Allow ', 'allow'), true);
  assert.equal(phraseMatches('ALLOW', 'allow'), true);
  assert.equal(phraseMatches('allo', 'allow'), false);
  assert.equal(phraseMatches('', 'allow'), false);
  assert.equal(phraseMatches('anything', ''), false);
});
