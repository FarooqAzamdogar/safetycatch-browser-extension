// Copyright 2026 The SafetyCatch Authors
// SPDX-License-Identifier: Apache-2.0

/**
 * Clipboard hooks for the page's own JavaScript world (MAIN world).
 *
 * This code shares its world with the page, so it treats the page as hostile:
 *
 * - It runs at `document_start`, before any page script, and immediately takes
 *   private references to every browser function it will ever call
 *   ("primordials"). After that it never looks anything up on a prototype or a
 *   global again, so later tampering by the page (replacing `Promise.then`,
 *   `String.prototype.indexOf`, array iterators, `Object.prototype` getters...)
 *   cannot change what it does. Helper objects are created without a prototype
 *   for the same reason.
 * - It does no analysis. It only forwards the text a page tries to put on the
 *   clipboard to the content script (isolated world) and, for the asynchronous
 *   clipboard API, waits for a yes or no before the real write happens.
 * - If the content script cannot be reached (the page erased our listeners),
 *   asynchronous writes are refused rather than waved through.
 *
 * Known limits are listed in THREAT_MODEL.md ("Hook bypass").
 */

import { DOWN_PREFIX, HELLO_ISO, HELLO_MAIN, TOKEN_CHARS, UP_PREFIX } from '../shared/channel.ts';

/** How often a waiting write re-attaches its listener and retries delivery. */
export const RETRY_MS = 150;
/** After this many retries without an answer (about 6 seconds) the write is refused. */
export const MAX_TRIES = 40;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

/** Install the hooks into the realm of `w` (a `Window`). Never throws into the page. */
export function installHooks(w: Any): void {
  const apply: typeof Reflect.apply = w.Reflect.apply;
  const defineProperty: typeof Reflect.defineProperty = w.Reflect.defineProperty;
  const getDesc: typeof Reflect.getOwnPropertyDescriptor = w.Reflect.getOwnPropertyDescriptor;
  const create: (proto: null) => Any = w.Object.create;
  const CustomEventCtor = w.CustomEvent;
  const PromiseCtor = w.Promise;
  const promiseResolve = PromiseCtor.resolve;
  const promiseThen = PromiseCtor.prototype.then;
  const targetProto = w.EventTarget.prototype;
  const listen = targetProto.addEventListener;
  const dispatch = targetProto.dispatchEvent;
  const stopNow = w.Event.prototype.stopImmediatePropagation;
  const prevent = w.Event.prototype.preventDefault;
  const detailOf = getDesc(CustomEventCtor.prototype, 'detail')?.get as () => unknown;
  const setTimer = w.setTimeout;
  const indexOf = w.String.prototype.indexOf;
  const slice = w.String.prototype.slice;
  const lower = w.String.prototype.toLowerCase;
  const fnString = w.Function.prototype.toString;
  const iteratorKey = w.Symbol.iterator;
  /** Marks our own wrappers, so a frame hooked from its parent is not wrapped a second time by its own copy of this script. */
  const MARK = w.Symbol.for('safetycatch.hook');
  const WeakSetCtor = w.WeakSet;
  const setHas = WeakSetCtor.prototype.has;
  const setAdd = WeakSetCtor.prototype.add;

  const docProto = w.Document && w.Document.prototype;
  const docSelection = docProto && docProto.getSelection;
  const selString = w.Selection && w.Selection.prototype.toString;
  const activeOf = docProto && getDesc(docProto, 'activeElement')?.get;
  const viewOfDoc = docProto && getDesc(docProto, 'defaultView')?.get;
  const itemProto = w.ClipboardItem && w.ClipboardItem.prototype;
  const typesOf = itemProto && getDesc(itemProto, 'types')?.get;
  const getType = itemProto && itemProto.getType;
  const blobText = w.Blob && w.Blob.prototype.text;

  const fieldGetters = (ctor: Any): Any => {
    const p = ctor && ctor.prototype;
    if (!p) return undefined;
    const value = getDesc(p, 'value')?.get;
    const start = getDesc(p, 'selectionStart')?.get;
    const end = getDesc(p, 'selectionEnd')?.get;
    return value && start && end ? [value, start, end] : undefined;
  };
  const areaGetters = fieldGetters(w.HTMLTextAreaElement);
  const inputGetters = fieldGetters(w.HTMLInputElement);

  let up = '';
  let down = '';
  let passive = false;
  let seq = 0;
  const pending = create(null) as Record<number, ((allow: boolean) => void) | undefined>;

  const dataDesc = (value: Any, writable: boolean, enumerable: boolean, configurable: boolean): Any => {
    const d = create(null);
    d.value = value;
    d.writable = writable;
    d.enumerable = enumerable;
    d.configurable = configurable;
    return d;
  };

  /** Send one message to the content script. True when it confirmed receipt. */
  const send = (kind: string, id: number, text: string): boolean => {
    if (up === '') return false;
    try {
      const init = create(null);
      init.cancelable = true;
      init.detail = kind + '\n' + id + '\n' + text;
      return !apply(dispatch, w, [new CustomEventCtor(up, init)]);
    } catch {
      return false;
    }
  };

  const hooks: Any[] = [];

  /** Put our hook back if the page swapped in a pristine browser function (for example one taken from a new iframe). */
  const verify = (): void => {
    for (let i = 0; i < hooks.length; i++) {
      const h = hooks[i];
      try {
        const d = getDesc(h[0], h[1]);
        const current = d && d.value;
        if (current === h[2]) continue;
        // A page-made wrapper around our hook still calls through us. A native function does not.
        if (typeof current === 'function' && (apply(indexOf, apply(fnString, current, []), ['[native code]']) as number) < 0) continue;
        defineProperty(h[0], h[1], dataDesc(h[2], true, h[3], true));
        send('t', 0, h[1]);
      } catch {
        // The page made its replacement permanent; the content script still sees copy events.
      }
    }
  };

  const goPassive = (): void => {
    passive = true;
    for (const id in pending) {
      const settle = pending[id as unknown as number];
      if (settle) settle(true);
    }
  };

  const onDown = (ev: Any): void => {
    apply(stopNow, ev, []);
    apply(prevent, ev, []);
    const d = apply(detailOf, ev, []);
    if (typeof d !== 'string') return;
    if (d === 'v') return verify();
    if (d === 'p') return goPassive();
    const cut = apply(indexOf, d, ['\n']) as number;
    if (cut < 1) return;
    const settle = pending[+(apply(slice, d, [0, cut]) as string)];
    if (settle) settle(apply(slice, d, [cut + 1]) === 'a');
  };

  const onHello = (ev: Any): void => {
    if (up !== '') return; // the first handshake wins
    const token = apply(detailOf, ev, []);
    if (typeof token !== 'string' || token.length !== TOKEN_CHARS) return;
    apply(stopNow, ev, []);
    apply(prevent, ev, []); // tells the content script that we are connected
    up = UP_PREFIX + token;
    down = DOWN_PREFIX + token;
    apply(listen, w, [down, onDown, true]);
  };

  /**
   * Ask the content script before running `run` (the real clipboard write).
   * The answer usually arrives during `send`, in which case nothing is delayed.
   */
  const gate = (kind: string, text: string, run: () => Any): Any => {
    if (passive || up === '') return run();
    const id = ++seq;
    let state = 0; // 0 waiting, 1 allowed, 2 refused
    let wake: (() => void) | undefined;
    pending[id] = (allow: boolean): void => {
      if (state !== 0) return;
      state = allow ? 1 : 2;
      delete pending[id];
      if (wake) wake();
    };
    apply(listen, w, [down, onDown, true]);
    let delivered = send(kind, id, text);
    if (state === 1) return run();
    if (state === 2) return apply(promiseResolve, PromiseCtor, [undefined]);
    return new PromiseCtor((resolve: (v: Any) => void, reject: (e: Any) => void) => {
      wake = (): void => {
        if (state !== 1) return resolve(undefined);
        try {
          resolve(run());
        } catch (e) {
          reject(e);
        }
      };
      let tries = 0;
      const tick = (): void => {
        if (state !== 0) return;
        if (++tries > MAX_TRIES) {
          const settle = pending[id];
          if (settle) settle(false); // nobody answered: refuse rather than guess
          return;
        }
        apply(listen, w, [down, onDown, true]); // document.open() erases listeners; adding again is harmless
        if (!delivered) delivered = send(kind, id, text);
        apply(setTimer, w, [tick, RETRY_MS]);
      };
      apply(setTimer, w, [tick, 0]);
    });
  };

  const then = (p: Any, ok: (v: Any) => Any, bad?: (e: Any) => Any): Any => apply(promiseThen, p, [ok, bad]);

  const makeWriteText = (orig: Any): Any =>
    ({
      writeText(this: Any, data: Any): Any {
        const self = this;
        if (arguments.length === 0) return apply(orig, self, []);
        let text: string;
        try {
          text = '' + data; // convert once; the browser gets exactly what we checked
        } catch {
          return apply(orig, self, [data]);
        }
        return gate('w', text, () => apply(orig, self, [text]));
      },
    }).writeText;

  const makeWrite = (orig: Any): Any =>
    ({
      write(this: Any, data: Any): Any {
        const self = this;
        if (passive || up === '' || !typesOf || !getType || !blobText || data === null || data === undefined) return apply(orig, self, [data]);
        // Read the page's list once into storage it cannot reach, and give the browser that same list.
        const items = create(null) as Record<number, Any>;
        let count = 0;
        let text: Any = apply(promiseResolve, PromiseCtor, ['']);
        try {
          const it = apply(data[iteratorKey], data, []) as Any;
          for (;;) {
            const step = it.next();
            if (step.done || count >= 16) break;
            const item = step.value;
            items[count++] = item;
            const types = apply(typesOf, item, []) as readonly string[];
            for (let i = 0; i < types.length; i++) {
              if (types[i] !== 'text/plain') continue;
              const blob = apply(getType, item, ['text/plain']);
              text = then(text, (acc: string) =>
                then(
                  then(blob, (b: Any) => apply(blobText, b, [])),
                  (t: string) => (acc === '' ? t : acc + '\n' + t),
                ),
              );
            }
          }
        } catch {
          // Not a list of clipboard items: the browser will reject it the same way below.
        }
        const replay = create(null);
        replay[iteratorKey] = (): Any => {
          let i = 0;
          const iter = create(null);
          iter.next = (): Any => {
            const r = create(null);
            r.done = i >= count;
            r.value = r.done ? undefined : items[i++];
            return r;
          };
          return iter;
        };
        const run = (): Any => apply(orig, self, [replay]);
        return then(text, (t: string) => (t === '' ? run() : gate('W', t, run)), run);
      },
    }).write;

  const fieldSelection = (el: Any, g: Any): string => {
    if (!g) return '';
    try {
      const a = apply(g[1], el, []);
      const b = apply(g[2], el, []);
      if (typeof a !== 'number' || typeof b !== 'number' || b <= a) return '';
      return apply(slice, apply(g[0], el, []), [a, b]) as string;
    } catch {
      return '';
    }
  };

  /** The text a copy would take from `doc` right now. */
  const selectedText = (doc: Any): string => {
    let text = '';
    try {
      const sel = apply(docSelection, doc, []);
      if (sel) text = apply(selString, sel, []) as string;
    } catch {
      // not a document
    }
    if (text !== '') return text;
    try {
      const el = apply(activeOf, doc, []);
      if (el) text = fieldSelection(el, areaGetters) || fieldSelection(el, inputGetters);
    } catch {
      // ignore
    }
    return text;
  };

  const makeExec = (orig: Any): Any =>
    ({
      execCommand(this: Any, command: Any, showUi: Any, value: Any): Any {
        const self = this;
        let name = '';
        try {
          name = apply(lower, '' + command, []) as string;
        } catch {
          // the browser reports the problem below
        }
        if ((name !== 'copy' && name !== 'cut') || passive || up === '') return apply(orig, self, arguments as Any);
        send('x', 0, name === 'cut' ? selectedText(self) : '');
        let ok = false;
        try {
          ok = apply(orig, self, [name, showUi, value]) === true;
          return ok;
        } finally {
          send('X', ok ? 1 : 0, ok && name === 'copy' ? selectedText(self) : '');
        }
      },
    }).execCommand;

  const makeSetData = (orig: Any): Any =>
    ({
      setData(this: Any, format: Any, data: Any): Any {
        if (arguments.length < 2 || passive || up === '') return apply(orig, this, arguments as Any);
        let f: string;
        let d: string;
        try {
          f = '' + format;
          d = '' + data;
        } catch {
          return apply(orig, this, arguments as Any);
        }
        const result = apply(orig, this, [f, d]);
        try {
          const kind = apply(lower, f, []);
          if (kind === 'text/plain' || kind === 'text') send('s', 0, d);
        } catch {
          // ignore
        }
        return result;
      },
    }).setData;

  const hook = (proto: Any, name: string, make: (orig: Any) => Any, track: boolean): void => {
    if (!proto) return;
    const d = getDesc(proto, name);
    if (!d || typeof d.value !== 'function') return;
    try {
      // Already ours. A page that forges this mark only skips a hook in a world it already controls.
      if (d.value[MARK] === true) return;
    } catch {
      // a page-made getter: treat as not marked
    }
    const wrapper = make(d.value);
    defineProperty(wrapper, MARK, dataDesc(true, false, false, false));
    defineProperty(wrapper, 'name', dataDesc(name, false, false, true));
    defineProperty(wrapper, 'length', dataDesc(d.value.length, false, false, true));
    if (defineProperty(proto, name, dataDesc(wrapper, true, d.enumerable === true, true)) && track) {
      // Only our own realm is re-checked later; keeping frame prototypes here would keep closed frames alive.
      defineProperty(hooks, hooks.length, dataDesc([proto, name, wrapper, d.enumerable === true], true, true, true));
    }
  };

  const knownRealms = new WeakSetCtor();
  const foreign = new WeakSetCtor();

  /**
   * A frame the page creates starts as an empty same-origin document that the
   * page can reach before the browser has injected this script into it. Hook
   * such frames the moment the page asks for them.
   */
  const adopt = (child: Any): void => {
    if (!child || child === w || apply(setHas, foreign, [child])) return;
    try {
      hookRealm(child);
    } catch {
      // Another origin: reading it is forbidden, and its own copy of this script guards it.
      try {
        apply(setAdd, foreign, [child]);
      } catch {
        // ignore
      }
    }
  };

  const hookGetter = (proto: Any, name: string, isDocument: boolean): void => {
    const d = getDesc(proto, name);
    if (!d || typeof d.get !== 'function') return;
    const get = d.get;
    const nd = create(null);
    nd.get = function (this: Any): Any {
      const value = apply(get, this, []);
      if (value) {
        if (!isDocument) adopt(value);
        else if (viewOfDoc) {
          try {
            adopt(apply(viewOfDoc, value, []));
          } catch {
            // ignore
          }
        }
      }
      return value;
    };
    nd.set = d.set;
    nd.enumerable = d.enumerable === true;
    nd.configurable = true;
    defineProperty(proto, name, nd);
  };

  const hookFrameClass = (ctor: Any): void => {
    const proto = ctor && ctor.prototype;
    if (!proto) return;
    hookGetter(proto, 'contentWindow', false);
    hookGetter(proto, 'contentDocument', true);
  };

  const hookRealm = (r: Any): void => {
    const key = r.Document; // throws for a window of another origin
    if (!key || apply(setHas, knownRealms, [key])) return;
    apply(setAdd, knownRealms, [key]);
    const clipProto = r.Clipboard && r.Clipboard.prototype;
    const own = r === w;
    hook(clipProto, 'writeText', makeWriteText, own);
    hook(clipProto, 'write', makeWrite, own);
    hook(key.prototype, 'execCommand', makeExec, own);
    hook(r.DataTransfer && r.DataTransfer.prototype, 'setData', makeSetData, own);
    hookFrameClass(r.HTMLIFrameElement);
    hookFrameClass(r.HTMLFrameElement);
    hookFrameClass(r.HTMLObjectElement);
    hookFrameClass(r.HTMLEmbedElement);
  };

  hookRealm(w);
  apply(listen, w, [HELLO_ISO, onHello, true]);
  apply(dispatch, w, [new CustomEventCtor(HELLO_MAIN)]);
}
