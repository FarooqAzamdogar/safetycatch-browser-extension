// Copyright 2026 The ActionGuard Authors
// SPDX-License-Identifier: Apache-2.0
//
// The page-world clipboard hooks and their private channel to the content
// script, exercised together on a tiny fake window (see fake-window.ts).

import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { createIsoChannel, type IsoChannel } from '../src/content/channel-iso.ts';
import { installHooks, MAX_TRIES, RETRY_MS } from '../src/content/main-hooks.ts';
import { decodeDown, decodeUp, DOWN_PREFIX, encodeDown, encodeUp, HELLO_ISO, HELLO_MAIN, isToken, makeToken, UP_PREFIX, type UpMessage } from '../src/shared/channel.ts';
import { makeFakeWindow, type FakeWindow } from './fake-window.ts';

let counter = 0;
/** Deterministic "random" bytes: each channel gets a different token. */
const fill = (bytes: Uint8Array): void => {
  counter++;
  bytes.forEach((_, i) => {
    bytes[i] = (counter * 31 + i * 7) & 0xff;
  });
};

interface Rig extends FakeWindow {
  iso: IsoChannel;
  messages: UpMessage[];
  /** What the content script answers to a write request; `null` = answer later by hand. */
  answer: (m: UpMessage) => boolean | null;
}

function rig(order: 'main-first' | 'iso-first' = 'main-first'): Rig {
  const fake = makeFakeWindow();
  const r = { ...fake, messages: [] as UpMessage[], answer: (): boolean | null => true } as unknown as Rig;
  const start = (): IsoChannel =>
    createIsoChannel(fake.w, fill, (m) => {
      r.messages.push(m);
      if (m.kind === 'w' || m.kind === 'W') {
        const verdict = r.answer(m);
        if (verdict !== null) r.iso.reply(m.id, verdict);
      }
    });
  if (order === 'main-first') {
    installHooks(fake.w);
    r.iso = start();
  } else {
    r.iso = start();
    installHooks(fake.w);
  }
  return r;
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

test('wire format: messages to the content script round-trip, including newlines in the text', () => {
  const text = 'line one\nline two\n';
  assert.deepEqual(decodeUp(encodeUp('w', 42, text)), { kind: 'w', id: 42, text });
  assert.deepEqual(decodeUp(encodeUp('s', 0, '')), { kind: 's', id: 0, text: '' });
});

test('wire format: malformed messages are rejected', () => {
  for (const bad of ['', 'w', 'w\n1', 'q\n1\nx', 'ww\n1\nx', 'w\nabc\nx', 'w\n-1\nx', 5, null, { kind: 'w' }]) assert.equal(decodeUp(bad), null, String(bad));
});

test('wire format: answers and control messages', () => {
  assert.deepEqual(decodeDown(encodeDown({ id: 7, allow: true })), { id: 7, allow: true });
  assert.deepEqual(decodeDown(encodeDown({ id: 7, allow: false })), { id: 7, allow: false });
  assert.deepEqual(decodeDown(encodeDown({ control: 'verify' })), { control: 'verify' });
  assert.deepEqual(decodeDown(encodeDown({ control: 'passive' })), { control: 'passive' });
  for (const bad of ['', '7', '7\nx', 'x\na', '\na', 7, undefined]) assert.equal(decodeDown(bad), null, String(bad));
});

test('channel tokens are 32 hex characters from the given random source', () => {
  const token = makeToken((b) => b.fill(0xab));
  assert.equal(token, 'ab'.repeat(16));
  assert.equal(isToken(token), true);
  assert.equal(isToken('short'), false);
  assert.equal(isToken(`${'ab'.repeat(15)}zz`), false);
  assert.notEqual(makeToken(fill), makeToken(fill));
});

for (const order of ['main-first', 'iso-first'] as const) {
  test(`handshake completes whichever script starts first (${order})`, () => {
    const r = rig(order);
    assert.equal(r.iso.bound(), true);
    // After the handshake nobody listens for hellos any more: a page cannot ask for the token.
    assert.equal(r.target.listenerCount(HELLO_MAIN), 0);
    let leaked = '';
    r.target.addEventListener(HELLO_ISO, (e) => {
      leaked = (e as CustomEvent<string>).detail;
    });
    r.target.dispatchEvent(new CustomEvent(HELLO_MAIN));
    assert.equal(leaked, '');
  });
}

test('benign copy: approved during the page\'s own call, so nothing is delayed', () => {
  const r = rig();
  const promise = r.clipboard.writeText('Hello there');
  assert.deepEqual(r.written, ['Hello there']);
  assert.ok(promise instanceof Promise);
  assert.deepEqual(r.messages, [{ kind: 'w', id: 1, text: 'Hello there' }]);
});

test('blocked copy: the page sees success, the clipboard is never written', async () => {
  const r = rig();
  r.answer = () => false;
  const result = await r.clipboard.writeText('dangerous');
  assert.equal(result, undefined);
  assert.deepEqual(r.written, []);
});

test('a verdict that arrives later still gates the write', async () => {
  const r = rig();
  r.answer = () => null;
  let settled = false;
  const promise = r.clipboard.writeText('wait for me').then(() => {
    settled = true;
  });
  await tick();
  assert.deepEqual(r.written, []);
  assert.equal(settled, false);
  r.iso.reply(r.messages[0]?.id ?? -1, true);
  await promise;
  assert.deepEqual(r.written, ['wait for me']);
});

test('the text is converted once: what was checked is what gets written', async () => {
  const r = rig();
  let calls = 0;
  const shifty = {
    toString(): string {
      return ++calls === 1 ? 'harmless' : 'malicious';
    },
  };
  await r.clipboard.writeText(shifty);
  assert.equal(calls, 1);
  assert.deepEqual(r.written, ['harmless']);
  assert.equal(r.messages[0]?.text, 'harmless');
});

test('calls the browser would reject are passed through untouched', async () => {
  const r = rig();
  await r.clipboard.writeText();
  assert.deepEqual(r.messages, []);
  assert.deepEqual(r.written, [undefined]);
});

test('clipboard.write: text items are read, checked and the same items are written', async () => {
  const r = rig();
  await r.clipboard.write([r.newItem('copied via write()')]);
  assert.deepEqual(r.messages, [{ kind: 'W', id: 1, text: 'copied via write()' }]);
  assert.deepEqual(r.written, ['copied via write()']);
});

test('clipboard.write: blocked items never reach the clipboard', async () => {
  const r = rig();
  r.answer = () => false;
  await r.clipboard.write([r.newItem('bad stuff')]);
  assert.deepEqual(r.written, []);
});

test('clipboard.write: a list that changes between reads cannot swap in different items', async () => {
  const r = rig();
  let reads = 0;
  const shifty = {
    [Symbol.iterator]: () => [r.newItem(++reads === 1 ? 'first read' : 'second read')][Symbol.iterator](),
  };
  await r.clipboard.write(shifty);
  assert.equal(reads, 1);
  assert.deepEqual(r.written, ['first read']);
  assert.equal(r.messages[0]?.text, 'first read');
});

test('clipboard.write: items without plain text (images) are not held up', async () => {
  const r = rig();
  await r.clipboard.write([r.newItem('<binary>', 'image/png')]);
  assert.deepEqual(r.messages, []);
  assert.deepEqual(r.written, ['<binary>']);
});

test('setData: plain-text formats are reported, others are not, and the call still happens', () => {
  const r = rig();
  const dt = r.newDataTransfer();
  dt.setData('text/plain', 'from a copy handler');
  dt.setData('Text', 'legacy format');
  dt.setData('text/html', '<b>x</b>');
  assert.deepEqual(r.data, [
    ['text/plain', 'from a copy handler'],
    ['Text', 'legacy format'],
    ['text/html', '<b>x</b>'],
  ]);
  assert.deepEqual(
    r.messages.map((m) => [m.kind, m.text]),
    [
      ['s', 'from a copy handler'],
      ['s', 'legacy format'],
    ],
  );
});

test('execCommand copy/cut: start and end are reported with the selected text', () => {
  const r = rig();
  r.document.selected = 'hidden textarea content';
  assert.equal(r.document.execCommand('copy'), true);
  assert.deepEqual(r.messages, [
    { kind: 'x', id: 0, text: '' },
    { kind: 'X', id: 1, text: 'hidden textarea content' },
  ]);
  r.messages.length = 0;
  r.document.execCommand('CUT');
  assert.deepEqual(r.messages, [
    { kind: 'x', id: 0, text: 'hidden textarea content' },
    { kind: 'X', id: 1, text: '' },
  ]);
  assert.deepEqual(r.executed, ['copy', 'cut']);
});

test('execCommand: a refused copy and other commands', () => {
  const r = rig();
  r.document.canCopy = false;
  assert.equal(r.document.execCommand('copy'), false);
  assert.deepEqual(r.messages.map((m) => `${m.kind}${m.id}`), ['x0', 'X0']);
  r.messages.length = 0;
  r.document.execCommand('bold');
  assert.deepEqual(r.messages, []);
});

test('without a content script the hooks stay out of the way', async () => {
  const fake = makeFakeWindow();
  installHooks(fake.w);
  await fake.clipboard.writeText('no extension here');
  assert.deepEqual(fake.written, ['no extension here']);
});

test('after "passive" (extension updated or removed) writes go straight through', async () => {
  const r = rig();
  r.answer = () => false;
  r.iso.passive();
  await r.clipboard.writeText('anything');
  r.document.execCommand('copy');
  assert.deepEqual(r.written, ['anything']);
  assert.deepEqual(r.messages, []);
});

test('"passive" releases writes that were still waiting', async () => {
  const r = rig();
  r.answer = () => null;
  const promise = r.clipboard.writeText('was waiting');
  r.iso.passive();
  await promise;
  assert.deepEqual(r.written, ['was waiting']);
});

test('a page cannot approve its own write without the secret channel name', async () => {
  const r = rig();
  r.answer = () => null;
  let done = false;
  void r.clipboard.writeText('needs approval').then(() => {
    done = true;
  });
  for (const name of [DOWN_PREFIX, `${DOWN_PREFIX}${'0'.repeat(32)}`, `${UP_PREFIX}guess`, 'actionguard:allow']) {
    r.target.dispatchEvent(new CustomEvent(name, { detail: '1\na', cancelable: true }));
  }
  await tick();
  assert.equal(done, false);
  assert.deepEqual(r.written, []);
});

test('a page tampering with built-ins after start-up does not change what the hooks do', async () => {
  // In a browser the content script has its own untouched copies of every built-in; here both sides
  // share one world, so the test only replaces built-ins that the hook side relies on.
  const r = rig();
  r.answer = () => false;
  const saved = { apply: Reflect.apply, create: Object.create, resolve: Promise.resolve, lower: String.prototype.toLowerCase, defineProperty: Reflect.defineProperty };
  const hijacked = (): never => {
    throw new Error('hijacked by the page');
  };
  let result: unknown = 'not run';
  try {
    Reflect.apply = hijacked as typeof Reflect.apply;
    Reflect.defineProperty = hijacked as typeof Reflect.defineProperty;
    Object.create = hijacked as typeof Object.create;
    Promise.resolve = hijacked as typeof Promise.resolve;
    String.prototype.toLowerCase = () => 'paste';
    result = r.clipboard.writeText('still checked');
    r.document.execCommand('copy');
  } finally {
    Reflect.apply = saved.apply;
    Reflect.defineProperty = saved.defineProperty;
    Object.create = saved.create;
    Promise.resolve = saved.resolve;
    String.prototype.toLowerCase = saved.lower;
  }
  assert.equal(await result, undefined);
  assert.deepEqual(r.written, []);
  assert.deepEqual(r.messages.map((m) => m.kind), ['w', 'x', 'X']);
  assert.equal(r.messages[0]?.text, 'still checked');
});

test('re-check on use: a pristine browser function swapped in by the page is replaced by the hook again', async () => {
  const r = rig();
  const proto = r.w.Clipboard.prototype;
  const hook = proto.writeText;
  // What a page gets from a fresh iframe: a native function (bound functions print as native code too).
  proto.writeText = function () {}.bind(null);
  r.iso.verify();
  assert.equal(proto.writeText, hook);
  assert.deepEqual(r.messages, [{ kind: 't', id: 0, text: 'writeText' }]);
});

test('re-check on use: a page-made wrapper around the hook is left alone (it still passes through us)', () => {
  const r = rig();
  const proto = r.w.Clipboard.prototype;
  const hook = proto.writeText;
  const wrapper = function (this: unknown, text: string): unknown {
    return hook.call(this, text);
  };
  proto.writeText = wrapper;
  r.iso.verify();
  assert.equal(proto.writeText, wrapper);
  assert.deepEqual(r.messages, []);
});

test('a world that is already hooked is not wrapped a second time', async () => {
  const r = rig();
  const before = r.w.Clipboard.prototype.writeText;
  installHooks(r.w); // what happens when a frame hooked from its parent later runs its own copy of the script
  assert.equal(r.w.Clipboard.prototype.writeText, before);
  await r.clipboard.writeText('only one check');
  assert.deepEqual(r.messages, [{ kind: 'w', id: 1, text: 'only one check' }]);
  assert.deepEqual(r.written, ['only one check']);
});

test('hooks look like the functions they replace', () => {
  const r = rig();
  assert.equal(r.w.Clipboard.prototype.writeText.name, 'writeText');
  assert.equal(r.w.Clipboard.prototype.writeText.length, 1);
  assert.equal(r.w.Document.prototype.execCommand.name, 'execCommand');
  assert.throws(() => new r.w.Clipboard.prototype.writeText('x'), TypeError);
});

test('document.open() erases listeners: the write waits, the content script re-attaches, the write is checked', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const r = rig();
    r.answer = () => false;
    r.target.eraseListeners();
    let settled = false;
    const promise = r.clipboard.writeText('written right after document.open()').then(() => {
      settled = true;
    });
    assert.equal(r.messages.length, 0);
    mock.timers.tick(RETRY_MS);
    assert.equal(settled, false);
    r.iso.ensure(); // what the content script's observer does when the document is replaced
    mock.timers.tick(RETRY_MS);
    await promise;
    assert.deepEqual(r.messages.map((m) => m.text), ['written right after document.open()']);
    assert.deepEqual(r.written, []);
  } finally {
    mock.timers.reset();
  }
});

test('a cut channel fails closed: after the retries the write is refused, not waved through', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const r = rig();
    r.target.eraseListeners();
    const promise = r.clipboard.writeText('nobody is listening');
    for (let i = 0; i <= MAX_TRIES + 1; i++) mock.timers.tick(RETRY_MS);
    assert.equal(await promise, undefined);
    assert.deepEqual(r.written, []);
  } finally {
    mock.timers.reset();
  }
});

test('a content script that never answers also fails closed', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const r = rig();
    r.answer = () => null;
    const promise = r.clipboard.writeText('no verdict');
    for (let i = 0; i <= MAX_TRIES + 1; i++) mock.timers.tick(RETRY_MS);
    await promise;
    assert.deepEqual(r.written, []);
    assert.equal(r.messages.length, 1);
  } finally {
    mock.timers.reset();
  }
});

test('an answer the page world missed is delivered again', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const r = rig();
    r.answer = () => null;
    const promise = r.clipboard.writeText('answer gets lost once');
    const id = r.messages[0]?.id ?? -1;
    r.target.eraseListeners(); // the page erases listeners while the check is running
    r.iso.reply(id, true); // not delivered: nobody is listening
    assert.deepEqual(r.written, []);
    mock.timers.tick(RETRY_MS); // the hook re-attaches its listener...
    mock.timers.tick(100); // ...and the content script retries the answer
    await promise;
    assert.deepEqual(r.written, ['answer gets lost once']);
  } finally {
    mock.timers.reset();
  }
});
