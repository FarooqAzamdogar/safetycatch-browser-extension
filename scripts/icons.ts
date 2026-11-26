// Copyright 2026 The SafetyCatch Authors
// SPDX-License-Identifier: Apache-2.0
//
// Draws the extension icon (a shield with a tick) in code, so the repository
// holds no binary artwork and the build needs no image tools.

import { deflateSync } from 'node:zlib';
import { crc32 } from './zip.ts';

function distanceToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** 0 = outside, 1 = shield body, 2 = tick. Coordinates run from 0 to 1. */
function sample(x: number, y: number): 0 | 1 | 2 {
  if (y < 0.07 || y > 0.95) return 0;
  const half = y < 0.5 ? 0.38 : 0.38 * (1 - ((y - 0.5) / 0.45) ** 1.7);
  if (Math.abs(x - 0.5) > half) return 0;
  const tick = Math.min(distanceToSegment(x, y, 0.3, 0.47, 0.45, 0.62), distanceToSegment(x, y, 0.45, 0.62, 0.71, 0.31));
  return tick < 0.055 ? 2 : 1;
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(body));
  return Buffer.concat([head, body, tail]);
}

/** A square RGBA PNG of the icon, anti-aliased by 4x4 supersampling. */
export function iconPng(size: number): Uint8Array {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const sub = 4;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let body = 0;
      let tick = 0;
      for (let sy = 0; sy < sub; sy++) {
        for (let sx = 0; sx < sub; sx++) {
          const s = sample((px + (sx + 0.5) / sub) / size, (py + (sy + 0.5) / sub) / size);
          if (s === 1) body++;
          else if (s === 2) tick++;
        }
      }
      const covered = body + tick;
      const at = py * (size * 4 + 1) + 1 + px * 4;
      if (covered === 0) continue;
      const white = tick / covered;
      raw[at] = Math.round(0x1d + (0xff - 0x1d) * white);
      raw[at + 1] = Math.round(0x4e + (0xff - 0x4e) * white);
      raw[at + 2] = Math.round(0xd8 + (0xff - 0xd8) * white);
      raw[at + 3] = Math.round((covered / (sub * sub)) * 255);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  return new Uint8Array(
    Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]),
  );
}

export const ICON_SIZES = [16, 32, 48, 128] as const;
