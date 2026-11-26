// Copyright 2026 The ActionGuard Authors
// SPDX-License-Identifier: Apache-2.0

/**
 * Wire format of the private channel between the page-world hook script
 * (MAIN world) and the content script (isolated world).
 *
 * Both sides talk with synchronous `CustomEvent`s on `window`. The event
 * names contain a random token that the isolated side creates and hands over
 * during a handshake that completes before any page script can run, so the
 * page can neither listen in nor forge messages (see THREAT_MODEL.md for the
 * limits). Payloads are plain strings: strings cross JavaScript worlds
 * unchanged in every browser, and the page-world side can build and parse them
 * without calling anything the page could have replaced.
 */

export const HELLO_MAIN = 'actionguard:hello-main';
export const HELLO_ISO = 'actionguard:hello-iso';
export const UP_PREFIX = 'ag-u-';
export const DOWN_PREFIX = 'ag-d-';
export const TOKEN_CHARS = 32;

/**
 * Messages from the page world:
 * `w` writeText, `W` write (both wait for an answer), `s` setData,
 * `x` execCommand copy/cut starting, `X` finished, `t` a hook was replaced.
 */
export const UP_KINDS = ['w', 'W', 's', 'x', 'X', 't'] as const;
export type UpKind = (typeof UP_KINDS)[number];

export interface UpMessage {
  kind: UpKind;
  id: number;
  text: string;
}

export function encodeUp(kind: UpKind, id: number, text: string): string {
  return `${kind}\n${id}\n${text}`;
}

export function decodeUp(detail: unknown): UpMessage | null {
  if (typeof detail !== 'string') return null;
  const a = detail.indexOf('\n');
  if (a !== 1) return null;
  const b = detail.indexOf('\n', a + 1);
  if (b < 0) return null;
  const kind = detail.slice(0, a);
  if (!(UP_KINDS as readonly string[]).includes(kind)) return null;
  const idText = detail.slice(a + 1, b);
  if (!/^\d{1,15}$/.test(idText)) return null;
  return { kind: kind as UpKind, id: Number(idText), text: detail.slice(b + 1) };
}

/** Answers and control messages to the page world. */
export type DownMessage = { id: number; allow: boolean } | { control: 'verify' | 'passive' };

export function encodeDown(msg: DownMessage): string {
  if ('control' in msg) return msg.control === 'verify' ? 'v' : 'p';
  return `${msg.id}\n${msg.allow ? 'a' : 'b'}`;
}

export function decodeDown(detail: unknown): DownMessage | null {
  if (typeof detail !== 'string') return null;
  if (detail === 'v') return { control: 'verify' };
  if (detail === 'p') return { control: 'passive' };
  const a = detail.indexOf('\n');
  if (a < 1) return null;
  const idText = detail.slice(0, a);
  const verb = detail.slice(a + 1);
  if (!/^\d{1,15}$/.test(idText) || (verb !== 'a' && verb !== 'b')) return null;
  return { id: Number(idText), allow: verb === 'a' };
}

/** A fresh channel token: 32 hex characters from a cryptographic random source. */
export function makeToken(fill: (bytes: Uint8Array<ArrayBuffer>) => unknown): string {
  const bytes = new Uint8Array(TOKEN_CHARS / 2);
  fill(bytes);
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

export function isToken(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{32}$/.test(value);
}
