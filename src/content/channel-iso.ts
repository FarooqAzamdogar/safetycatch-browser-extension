// Copyright 2026 The SafetyCatch Authors
// SPDX-License-Identifier: Apache-2.0

/**
 * Content-script (isolated world) end of the private channel to the
 * page-world hooks. See shared/channel.ts for the wire format.
 */

import { decodeUp, DOWN_PREFIX, encodeDown, HELLO_ISO, HELLO_MAIN, makeToken, UP_PREFIX, type DownMessage, type UpMessage } from '../shared/channel.ts';

export interface IsoChannel {
  /** True once the page-world side has answered the handshake. */
  bound(): boolean;
  /** Answer a pending clipboard write. Retried until the page world confirms it. */
  reply(id: number, allow: boolean): void;
  /** Ask the page world to check that its hooks are still in place. */
  verify(): void;
  /** Tell the page world to stop gating (the extension was updated or removed). */
  passive(): void;
  /** Re-attach our listeners. `document.open()` erases every listener on the window. */
  ensure(): void;
}

const RETRY_MS = 100;
const MAX_RETRIES = 40;

type Target = Pick<Window, 'addEventListener' | 'removeEventListener' | 'dispatchEvent'>;

export function createIsoChannel(w: Target, fillRandom: (bytes: Uint8Array<ArrayBuffer>) => unknown, onMessage: (m: UpMessage) => void): IsoChannel {
  const token = makeToken(fillRandom);
  const up = UP_PREFIX + token;
  const down = DOWN_PREFIX + token;
  let bound = false;
  let queue: Array<{ detail: string; tries: number }> = [];
  let timer: ReturnType<typeof setTimeout> | undefined;

  const hello = (): void => {
    if (bound) return;
    // The page world cancels this event to say "connected". Until then the token is not in use.
    if (!w.dispatchEvent(new CustomEvent(HELLO_ISO, { detail: token, cancelable: true }))) {
      bound = true;
      w.removeEventListener(HELLO_MAIN, onHelloMain, true);
    }
  };
  const onHelloMain = (e: Event): void => {
    e.stopImmediatePropagation();
    hello();
  };
  const onUp = (e: Event): void => {
    e.stopImmediatePropagation();
    e.preventDefault(); // confirms receipt to the page world
    const m = decodeUp((e as CustomEvent<unknown>).detail);
    if (m) onMessage(m);
  };
  const ensure = (): void => {
    w.addEventListener(up, onUp, true);
    if (!bound) w.addEventListener(HELLO_MAIN, onHelloMain, true);
  };
  const push = (detail: string): boolean => !w.dispatchEvent(new CustomEvent(down, { detail, cancelable: true }));
  const flush = (): void => {
    timer = undefined;
    queue = queue.filter((q) => !push(q.detail) && ++q.tries < MAX_RETRIES);
    if (queue.length > 0) timer = setTimeout(flush, RETRY_MS);
  };
  const sendDown = (msg: DownMessage, mustArrive: boolean): void => {
    const detail = encodeDown(msg);
    if (push(detail) || !mustArrive) return;
    queue.push({ detail, tries: 0 });
    if (timer === undefined) timer = setTimeout(flush, RETRY_MS);
  };

  ensure();
  hello();

  return {
    bound: () => bound,
    reply: (id, allow) => sendDown({ id, allow }, true),
    verify: () => sendDown({ control: 'verify' }, false),
    passive: () => sendDown({ control: 'passive' }, bound),
    ensure,
  };
}
