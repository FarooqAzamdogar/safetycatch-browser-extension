// Copyright 2026 The ActionGuard Authors
// SPDX-License-Identifier: Apache-2.0
//
// The small part of the WebExtensions API this project uses, declared by hand
// so that no third-party typings package is needed. Promise style only (works
// in Chrome 120+, Edge and Firefox 128+ with Manifest V3).

declare namespace chrome {
  interface Event<F extends (...args: never[]) => unknown> {
    addListener(callback: F, filter?: unknown): void;
    removeListener(callback: F): void;
  }

  namespace runtime {
    interface MessageSender {
      id?: string;
      url?: string;
      origin?: string;
      frameId?: number;
      tab?: { id?: number; url?: string; windowId?: number };
    }
    const id: string | undefined;
    function getURL(path: string): string;
    function getManifest(): { version: string; name: string };
    function sendMessage(message: unknown): Promise<unknown>;
    function openOptionsPage(): Promise<void>;
    const onMessage: Event<(message: unknown, sender: MessageSender, sendResponse: (response: unknown) => void) => boolean | undefined | void>;
    const onInstalled: Event<(details: { reason: string }) => void>;
    const onStartup: Event<() => void>;
  }

  namespace i18n {
    function getMessage(name: string, substitutions?: string | string[]): string;
    function getUILanguage(): string;
  }

  namespace storage {
    interface StorageArea {
      get(keys?: string | string[] | null): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
      remove(keys: string | string[]): Promise<void>;
    }
    const local: StorageArea;
    const session: StorageArea | undefined;
    const onChanged: Event<(changes: Record<string, { oldValue?: unknown; newValue?: unknown }>, area: string) => void>;
  }

  namespace tabs {
    interface Tab {
      id?: number;
      url?: string;
      windowId?: number;
      active?: boolean;
    }
    function query(info: { active?: boolean; currentWindow?: boolean; lastFocusedWindow?: boolean }): Promise<Tab[]>;
    function sendMessage(tabId: number, message: unknown, options?: { frameId?: number }): Promise<unknown>;
    function update(tabId: number, props: { url?: string }): Promise<Tab | undefined>;
    function create(props: { url: string }): Promise<Tab>;
    const onRemoved: Event<(tabId: number) => void>;
  }

  namespace windows {
    function create(data: { url: string; type?: 'popup' | 'normal'; width?: number; height?: number; focused?: boolean }): Promise<{ id?: number } | undefined>;
  }

  namespace action {
    function setBadgeText(details: { text: string; tabId?: number }): Promise<void>;
    function setBadgeBackgroundColor(details: { color: string }): Promise<void>;
  }

  namespace webNavigation {
    interface NavigationDetails {
      tabId: number;
      frameId: number;
      url: string;
      timeStamp: number;
      transitionType?: string;
      transitionQualifiers?: string[];
    }
    interface TargetDetails {
      sourceTabId: number;
      tabId: number;
      url: string;
      timeStamp: number;
    }
    const onBeforeNavigate: Event<(details: NavigationDetails) => void>;
    const onCommitted: Event<(details: NavigationDetails) => void>;
    const onCreatedNavigationTarget: Event<(details: TargetDetails) => void>;
  }

  namespace downloads {
    interface DownloadItem {
      id: number;
      url: string;
      finalUrl?: string;
      referrer?: string;
      filename: string;
      state: 'in_progress' | 'interrupted' | 'complete';
      paused?: boolean;
      exists?: boolean;
      byExtensionId?: string;
    }
    interface DownloadDelta {
      id: number;
      filename?: { previous?: string; current?: string };
      state?: { previous?: string; current?: string };
    }
    function pause(id: number): Promise<void>;
    function resume(id: number): Promise<void>;
    function cancel(id: number): Promise<void>;
    function removeFile(id: number): Promise<void>;
    function erase(query: { id: number }): Promise<number[]>;
    function search(query: { id: number }): Promise<DownloadItem[]>;
    const onCreated: Event<(item: DownloadItem) => void>;
    const onChanged: Event<(delta: DownloadDelta) => void>;
    const onDeterminingFilename: Event<(item: DownloadItem, suggest: (suggestion?: { filename: string }) => void) => boolean | void> | undefined;
  }
}
