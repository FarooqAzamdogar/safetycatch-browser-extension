// Copyright 2026 The SafetyCatch Authors
// SPDX-License-Identifier: Apache-2.0
//
// A very small stand-in for a browser window, just enough to run the clipboard
// hooks (src/content/main-hooks.ts) and the content-script end of their
// channel under `node --test`.
//
// Why a shim at all: the hooks are the security-critical piece that shares a
// JavaScript world with hostile pages. Their logic (handshake, gating a write
// until it is approved, refusing when the channel is cut, restoring removed
// hooks) is worth unit-testing without a browser. No DOM library is used: the
// shim is about a hundred lines of plain classes. Events are Node's own
// `Event`/`CustomEvent`; only the event target is custom, so tests can erase
// all listeners the way `document.open()` does.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

type Listener = (e: Event) => void;

class FakeTarget {
  private listeners = new Map<string, Listener[]>();
  /** What `document.open()` does to a window: every listener is gone. */
  eraseListeners(): void {
    this.listeners.clear();
  }
  listenerCount(type: string): number {
    return this.listeners.get(type)?.length ?? 0;
  }
  addEventListener(type: string, fn: Listener): void {
    const list = this.listeners.get(type) ?? [];
    if (!list.includes(fn)) list.push(fn);
    this.listeners.set(type, list);
  }
  removeEventListener(type: string, fn: Listener): void {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((l) => l !== fn));
  }
  dispatchEvent(e: Event): boolean {
    for (const fn of [...(this.listeners.get(e.type) ?? [])]) fn(e);
    return !e.defaultPrevented;
  }
}

export interface FakeWindow {
  w: Any;
  /** Text that reached the "real" clipboard. */
  written: string[];
  /** execCommand calls that reached the "real" browser. */
  executed: string[];
  /** setData calls that reached the "real" browser. */
  data: Array<[string, string]>;
  document: Any;
  clipboard: Any;
  newItem(text: string, type?: string): Any;
  newDataTransfer(): Any;
  target: FakeTarget;
}

export function makeFakeWindow(): FakeWindow {
  const target = new FakeTarget();
  const w = target as Any;
  const written: string[] = [];
  const executed: string[] = [];
  const data: Array<[string, string]> = [];

  class ClipboardItem {
    readonly #text: string;
    readonly #type: string;
    constructor(text: string, type: string) {
      this.#text = text;
      this.#type = type;
    }
    get types(): string[] {
      return [this.#type];
    }
    getType(): Promise<Blob> {
      return Promise.resolve(new Blob([this.#text]));
    }
    /** Test-only view of the content, as the "browser" would see it. */
    peek(): string {
      return this.#text;
    }
  }
  class Clipboard {
    writeText(text: string): Promise<void> {
      written.push(text);
      return Promise.resolve();
    }
    write(items: Iterable<ClipboardItem>): Promise<void> {
      for (const item of items) written.push(item.peek());
      return Promise.resolve();
    }
  }
  class Selection {
    readonly #text: string;
    constructor(text: string) {
      this.#text = text;
    }
    toString(): string {
      return this.#text;
    }
  }
  class Document {
    selected = '';
    canCopy = true;
    execCommand(command: string): boolean {
      executed.push(command);
      return this.canCopy;
    }
    getSelection(): Selection {
      return new Selection(this.selected);
    }
    get activeElement(): null {
      return null;
    }
    get defaultView(): Any {
      return w;
    }
  }
  class DataTransfer {
    setData(format: string, value: string): void {
      data.push([format, value]);
    }
  }

  Object.assign(w, { Reflect, Object, CustomEvent, Event, EventTarget: FakeTarget, Promise, setTimeout, String, Function, Symbol, WeakSet, Blob, Clipboard, ClipboardItem, Document, Selection, DataTransfer });
  const clipboard = new Clipboard();
  const document = new Document();
  w.navigator = { clipboard };
  w.document = document;
  return { w, written, executed, data, document, clipboard, newItem: (text, type = 'text/plain') => new ClipboardItem(text, type), newDataTransfer: () => new DataTransfer(), target };
}
