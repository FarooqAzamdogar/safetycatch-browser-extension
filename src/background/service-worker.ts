// Copyright 2026 The ActionGuard Authors
// SPDX-License-Identifier: Apache-2.0

/**
 * Service worker (Chrome, Edge) / background script (Firefox). The detection
 * engine lives here, once, instead of inside every page. This file only wires
 * browser events to background/core.ts.
 *
 * All listeners are registered synchronously at start-up so the browser can
 * wake the worker for them. Nothing is kept only in memory: settings and
 * recent warnings are in `storage.local`, the navigation chain and pending
 * downloads in `storage.session` (memory-backed, never written to disk).
 */

import * as engine from 'actionguard-engine';
import type { DownloadOp } from '../shared/downloads.ts';
import { isContentType, parseContentRequest, parsePageRequest, type PageRequest } from '../shared/protocol.ts';
import { SETTINGS_KEY } from '../shared/settings.ts';
import { isHttpUrl } from '../shared/sites.ts';
import { createCore, type KeyValue } from './core.ts';

const memory = new Map<string, unknown>();

function area(storage: chrome.storage.StorageArea | undefined): KeyValue {
  return {
    get: async (key) => (storage ? (await storage.get(key))[key] : memory.get(key)),
    set: async (key, value) => {
      if (storage) await storage.set({ [key]: value });
      else memory.set(key, value);
    },
  };
}

const core = createCore({
  engine: {
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
  },
  local: area(chrome.storage.local),
  session: area(chrome.storage.session),
  now: () => Date.now(),
  uiLanguage: () => {
    try {
      return chrome.i18n.getUILanguage();
    } catch {
      return typeof navigator !== 'undefined' ? navigator.language : 'en';
    }
  },
  loadMessages: async (folder) => (await fetch(chrome.runtime.getURL(`_locales/${folder}/messages.json`))).json() as Promise<unknown>,
  showInTop: async (tabId, push) => {
    const reply = await chrome.tabs.sendMessage(tabId, push, { frameId: 0 });
    return typeof reply === 'object' && reply !== null && (reply as { ok?: unknown }).ok === true;
  },
  leaveTab: async (tabId) => {
    await chrome.tabs.update(tabId, { url: 'about:blank' });
    return true;
  },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  defer: (job) => {
    setTimeout(job, 0);
  },
  version: chrome.runtime.getManifest().version,
});

// ---------------------------------------------------------------- messages

async function badge(): Promise<void> {
  try {
    const waiting = await core.pendingCount();
    await chrome.action.setBadgeBackgroundColor({ color: '#b91c1c' });
    await chrome.action.setBadgeText({ text: waiting > 0 ? '!' : '' });
  } catch {
    // the badge is only a hint
  }
}

async function runDownloadOps(id: number, ops: readonly DownloadOp[]): Promise<void> {
  for (const op of ops) {
    try {
      if (op === 'resume') await chrome.downloads.resume(id);
      else if (op === 'cancel') await chrome.downloads.cancel(id);
      else if (op === 'removeFile') await chrome.downloads.removeFile(id);
      else await chrome.downloads.erase({ id });
    } catch {
      // the download is already gone
    }
  }
}

async function handlePage(req: PageRequest): Promise<unknown> {
  const reply = await core.handlePage(req);
  if (req.type === 'download-choice') {
    const r = reply as { ok: boolean; ops: DownloadOp[] };
    if (r.ok) await runDownloadOps(req.id, r.ops);
    await badge();
    return { ok: r.ok };
  }
  return reply;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  // Extension pages (popup, options, download prompt) may change settings; content scripts may only ask for checks.
  const fromOwnPage = typeof sender.url === 'string' && sender.url.startsWith(chrome.runtime.getURL(''));
  let job: Promise<unknown> | null = null;
  if (fromOwnPage) {
    const req = parsePageRequest(message);
    if (req) job = handlePage(req);
  } else if (sender.tab && typeof sender.tab.id === 'number' && isContentType(message)) {
    const req = parseContentRequest(message);
    if (req) job = core.handleContent(req, { tabId: sender.tab.id, frameId: sender.frameId ?? 0, tabUrl: sender.tab.url ?? sender.url ?? '' });
  }
  if (!job) return false;
  job.then(
    (reply) => sendResponse(reply ?? null),
    () => sendResponse(null), // the content script treats "no answer" as "could not check"
  );
  return true;
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes[SETTINGS_KEY]) core.invalidate();
});

// ---------------------------------------------------------------- navigation chain

const WEB_ONLY = { url: [{ schemes: ['http', 'https'] }] };

chrome.webNavigation.onBeforeNavigate.addListener((d) => {
  if (d.frameId === 0) void core.navBefore(d.tabId, d.url);
}, WEB_ONLY);

chrome.webNavigation.onCommitted.addListener((d) => {
  if (d.frameId === 0) void core.navCommitted(d.tabId, d.url, d.transitionType, d.transitionQualifiers);
}, WEB_ONLY);

chrome.webNavigation.onCreatedNavigationTarget.addListener((d) => {
  void core.navCreated(d.sourceTabId, d.tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void core.navRemoved(tabId);
});

// ---------------------------------------------------------------- downloads

async function activeTabUrl(): Promise<string> {
  try {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const url = tabs[0]?.url;
    return isHttpUrl(url) ? url : '';
  } catch {
    return '';
  }
}

async function onDownload(item: chrome.downloads.DownloadItem): Promise<void> {
  if (item.byExtensionId !== undefined && item.byExtensionId === chrome.runtime.id) return;
  if (!(await core.downloadSeen(item, await activeTabUrl()))) return;
  let finished = false;
  try {
    await chrome.downloads.pause(item.id);
  } catch {
    // Small files finish before they can be paused.
    try {
      const now = (await chrome.downloads.search({ id: item.id }))[0];
      if (!now || now.state === 'interrupted') return;
      finished = now.state === 'complete';
    } catch {
      return;
    }
  }
  await core.downloadFinished(item.id, finished);
  const url = chrome.runtime.getURL(`download.html?id=${item.id}`);
  try {
    await chrome.windows.create({ url, type: 'popup', width: 580, height: 680, focused: true });
  } catch {
    await chrome.tabs.create({ url }).catch(() => undefined);
  }
  await badge();
}

chrome.downloads.onCreated.addListener((item) => {
  void onDownload(item).catch(() => undefined);
});

// The final file name is often known only after the download has started.
chrome.downloads.onChanged.addListener((delta) => {
  if (!delta.filename?.current) return;
  void chrome.downloads
    .search({ id: delta.id })
    .then((items) => (items[0] ? onDownload(items[0]) : undefined))
    .catch(() => undefined);
});

// Chrome and Edge tell us the name before the file is saved. We never change it.
chrome.downloads.onDeterminingFilename?.addListener((item, suggest) => {
  suggest();
  void onDownload(item).catch(() => undefined);
});
