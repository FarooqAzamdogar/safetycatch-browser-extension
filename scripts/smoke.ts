// Copyright 2026 The SafetyCatch Authors
// SPDX-License-Identifier: Apache-2.0
//
// OPTIONAL real-browser smoke test (not part of `npm run check`):
//   npm run build && npm run smoke            functional checks
//   npm run smoke -- --perf                   also measures the added page-load cost
//
// It loads the built extension (dist/chrome) into headless Chrome or Edge with
// a throw-away profile and drives the harmless pages in test/pages/ with real,
// trusted input events over the Chrome DevTools Protocol. No dependencies: the
// protocol is spoken over the browser's debugging pipe.
//
// Recent Chrome ignores --load-extension, so the extension is installed with
// the protocol command Extensions.loadUnpacked (needs --remote-debugging-pipe
// and --enable-unsafe-extension-debugging). Set BROWSER=/path/to/browser to
// choose a browser. Every host name except localhost is made unresolvable, so
// the test cannot reach the internet.

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { type BrowserRun, newBrowserRun, removeLeftovers } from './browser.ts';
import { startPages } from './serve-pages.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const extensionDir = join(root, 'dist', 'chrome');
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const PERF = process.argv.includes('--perf');
const VERBOSE = process.argv.includes('--verbose');
/** Upper limit for the functional checks. */
const LIMIT_MS = 240_000;

/** Host names that stand in for real sign-in and platform sites; all are mapped to the local test server. */
const DEVICE_HOSTS = ['aka.ms', 'microsoft.com'];
const PLATFORM_HOSTS = ['safetycatch-test.weebly.com', 'safetycatch-test.wixsite.com', 'safetycatch-test.blogspot.com'];

function browsers(): string[] {
  const candidates = [
    process.env['BROWSER'] ?? '',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ];
  const chosen = process.env['BROWSER'] ?? '';
  if (chosen !== '') return existsSync(chosen) ? [chosen] : []; // an explicit choice is used alone, without falling back
  return candidates.filter((c, i) => c !== '' && candidates.indexOf(c) === i && existsSync(c));
}

interface Message {
  id?: number;
  method?: string;
  params?: Json;
  result?: Json;
  error?: { message: string };
  sessionId?: string;
}

/** Chrome DevTools Protocol over the debugging pipe: JSON messages separated by a zero byte. */
class Cdp {
  private nextId = 0;
  private readonly pending = new Map<number, { resolve: (v: Json) => void; reject: (e: Error) => void }>();
  readonly problems: string[] = [];
  readonly notes: string[] = [];
  /** How many times an extension service worker started (the browser may stop and restart it). */
  workerStarts = 0;
  extensionId = '';
  private readonly write: (text: string) => void;

  constructor(write: (text: string) => void) {
    this.write = write;
  }

  /** The debugging pipe: JSON messages separated by a zero byte. Needed for Extensions.loadUnpacked. */
  static overPipe(out: Writable, input: Readable): Cdp {
    const zero = String.fromCharCode(0);
    const cdp = new Cdp((text) => out.write(text + zero));
    let buffer: Buffer = Buffer.alloc(0);
    input.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (let end = buffer.indexOf(0); end >= 0; end = buffer.indexOf(0)) {
        const text = buffer.subarray(0, end).toString('utf8');
        buffer = buffer.subarray(end + 1);
        cdp.receive(JSON.parse(text) as Message);
      }
    });
    return cdp;
  }

  /** A WebSocket to the browser's debugging port (fallback for browsers that do not answer on the pipe). */
  static async overSocket(url: string): Promise<Cdp> {
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true });
      ws.addEventListener('error', () => reject(new Error('could not connect to the debugging port')), { once: true });
    });
    const cdp = new Cdp((text) => ws.send(text));
    ws.addEventListener('message', (m) => cdp.receive(JSON.parse(String(m.data)) as Message));
    return cdp;
  }

  private receive(m: Message): void {
    if (m.id !== undefined) {
      const waiting = this.pending.get(m.id);
      this.pending.delete(m.id);
      if (m.error) waiting?.reject(new Error(m.error.message));
      else waiting?.resolve(m.result ?? {});
      return;
    }
    if (m.method === 'Runtime.consoleAPICalled' && (m.params?.type === 'error' || m.params?.type === 'warning')) {
      const where = String(m.params?.stackTrace?.callFrames?.[0]?.url ?? '');
      if (where.startsWith('chrome-extension://')) this.notes.push(`console.${m.params.type}: ${JSON.stringify((m.params.args ?? []).map((a: Json) => a.value ?? a.description)).slice(0, 300)}`);
    }
    if (m.method === 'Target.targetCreated' && m.params?.targetInfo?.type === 'service_worker' && this.extensionId !== '' && String(m.params.targetInfo.url).startsWith(`chrome-extension://${this.extensionId}/`)) this.workerStarts++;
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params?.exceptionDetails;
      const where = String(d?.url ?? d?.stackTrace?.callFrames?.[0]?.url ?? '');
      // Only problems in the extension's own code count.
      if (where.startsWith('chrome-extension://')) this.problems.push(`${d?.exception?.description ?? d?.text} (${where}:${d?.lineNumber})`.slice(0, 400));
    }
  }

  send(method: string, params: Json = {}, sessionId?: string): Promise<Json> {
    const id = ++this.nextId;
    this.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
}

interface UiButton {
  nodeId: number;
  text: string;
  hidden: boolean;
  where: 'banner' | 'modal';
}

interface UiView {
  /** All text inside the warning UI. */
  text: string;
  modalText: string;
  bannerText: string;
  buttons: UiButton[];
  inputs: number[];
}

class Tab {
  readonly cdp: Cdp;
  readonly sessionId: string;
  readonly targetId: string;

  constructor(cdp: Cdp, sessionId: string, targetId: string) {
    this.cdp = cdp;
    this.sessionId = sessionId;
    this.targetId = targetId;
  }

  static async open(cdp: Cdp, url = 'about:blank'): Promise<Tab> {
    const { targetId } = await cdp.send('Target.createTarget', { url });
    return Tab.attach(cdp, targetId);
  }

  static async attach(cdp: Cdp, targetId: string): Promise<Tab> {
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const tab = new Tab(cdp, sessionId, targetId);
    for (const method of ['Page.enable', 'Runtime.enable', 'DOM.enable']) await tab.send(method);
    await tab.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    return tab;
  }

  send(method: string, params: Json = {}): Promise<Json> {
    return this.cdp.send(method, params, this.sessionId);
  }

  async ev<T>(expression: string): Promise<T> {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`page script failed: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value as T;
  }

  /** Navigate and wait until the page has loaded. Returns false when the browser could not load it. */
  async goto(url: string, timeoutMs = 15_000): Promise<boolean> {
    const r = await this.send('Page.navigate', { url, transitionType: 'typed' });
    if (r.errorText) return false;
    const want = url.split('#')[0] as string;
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const state = await this.ev<string>('document.readyState + "|" + location.href').catch(() => '');
      if (state.startsWith('complete|') && state.slice(9).split('#')[0] === want) return true;
      await sleep(80);
    }
    return false;
  }

  async mouse(x: number, y: number, holdMs = 0): Promise<void> {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    if (holdMs > 0) await sleep(holdMs);
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  }

  /** A real (trusted) click on a page element. */
  async click(selector: string): Promise<void> {
    const box = await this.ev<{ x: number; y: number } | null>(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`,
    );
    if (!box) throw new Error(`no element ${selector}`);
    await this.mouse(box.x, box.y);
  }

  /** A real click (or press-and-hold) on a node inside the warning UI's closed shadow root. */
  async clickNode(nodeId: number, holdMs = 0): Promise<void> {
    await this.send('DOM.scrollIntoViewIfNeeded', { nodeId }).catch(() => undefined);
    const { model } = await this.send('DOM.getBoxModel', { nodeId });
    const q = model.content as number[];
    await this.mouse(((q[0] as number) + (q[4] as number)) / 2, ((q[1] as number) + (q[5] as number)) / 2, holdMs);
  }

  async key(key: string, code: string, vk: number, extra: Json = {}): Promise<void> {
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk, ...extra });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, modifiers: extra.modifiers ?? 0 });
  }

  /** Type one printable character with real key events. */
  type(char: string): Promise<void> {
    return this.key(char, `Key${char.toUpperCase()}`, char.toUpperCase().charCodeAt(0), { text: char });
  }

  /** A real paste (Ctrl+V) from the browser clipboard. */
  paste(): Promise<void> {
    return this.key('v', 'KeyV', 86, { modifiers: 2, commands: ['paste'] });
  }

  /** Read the warning UI. It lives in a closed shadow root that page scripts cannot see; the protocol can. */
  async ui(): Promise<UiView> {
    const { root: documentNode } = await this.send('DOM.getDocument', { depth: -1, pierce: true });
    const view: UiView = { text: '', modalText: '', bannerText: '', buttons: [], inputs: [] };
    const attr = (n: Json, name: string): string | undefined => {
      const list = (n.attributes ?? []) as string[];
      const i = list.findIndex((v, index) => index % 2 === 0 && v === name);
      return i >= 0 ? list[i + 1] : undefined;
    };
    const textOf = (n: Json): string => (n.nodeType === 3 ? String(n.nodeValue) : n.nodeName === 'STYLE' ? '' : ((n.children ?? []) as Json[]).map(textOf).join(' '));
    const inside = (n: Json, where: '' | 'banner' | 'modal'): void => {
      const cls = attr(n, 'class') ?? '';
      const here = cls.split(' ').includes('banner') ? 'banner' : cls.split(' ').includes('veil') ? 'modal' : where;
      if (n.nodeType === 3 && here) {
        if (here === 'modal') view.modalText += ` ${n.nodeValue}`;
        else view.bannerText += ` ${n.nodeValue}`;
      }
      if (n.nodeName === 'BUTTON' && here) view.buttons.push({ nodeId: n.nodeId, text: textOf(n).trim(), hidden: attr(n, 'hidden') !== undefined, where: here });
      if (n.nodeName === 'INPUT' && here) view.inputs.push(n.nodeId);
      for (const c of (n.children ?? []) as Json[]) inside(c, here);
    };
    const visit = (n: Json): void => {
      for (const s of (n.shadowRoots ?? []) as Json[]) if (s.shadowRootType === 'closed') inside(s, '');
      for (const c of (n.children ?? []) as Json[]) visit(c);
    };
    visit(documentNode);
    view.text = `${view.bannerText} ${view.modalText}`;
    return view;
  }

  async waitUi(test: (v: UiView) => boolean, what: string, timeoutMs = 15_000): Promise<UiView> {
    const end = Date.now() + timeoutMs;
    let last: UiView | null = null;
    while (Date.now() < end) {
      last = await this.ui().catch(() => null);
      if (last && test(last)) return last;
      await sleep(120);
    }
    throw new Error(`timed out waiting for ${what}; warning UI text was: "${(last?.text ?? '').trim().slice(0, 300)}"`);
  }

  /** Click (or hold) the warning button whose label contains `label`. */
  async press(label: string, holdMs = 0): Promise<void> {
    const view = await this.waitUi((v) => v.buttons.some((b) => !b.hidden && b.text.includes(label)), `button "${label}"`);
    const button = view.buttons.find((b) => !b.hidden && b.text.includes(label)) as UiButton;
    await this.clickNode(button.nodeId, holdMs);
  }
}

/** Temporary folders of this test start with this; leftovers of a killed run are removed at the next start. */
const PREFIX = 'safetycatch-browser-smoke-';

interface Launched {
  proc: ChildProcess;
  cdp: Cdp;
  /** The browser's temporary folder: closing the browser tree and deleting it also happens on Ctrl+C or a crash. */
  run: BrowserRun;
  extensionId: string;
  how: string;
}

/**
 * Find OUR service worker and return the extension id. Browsers ship built-in extensions with
 * service workers of their own (some are also called background.js), so each candidate is asked
 * for its manifest name.
 */
async function waitForExtension(cdp: Cdp): Promise<string> {
  const notOurs = new Set<string>();
  for (let i = 0; i < 80; i++) {
    const { targetInfos } = await cdp.send('Target.getTargets');
    const workers = (targetInfos as Json[]).filter((t) => t.type === 'service_worker' && String(t.url).startsWith('chrome-extension://') && !notOurs.has(String(t.targetId)));
    for (const worker of workers) {
      try {
        const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: worker.targetId, flatten: true });
        const r = await cdp.send('Runtime.evaluate', { expression: 'chrome.runtime.getManifest().short_name', returnByValue: true }, sessionId);
        await cdp.send('Target.detachFromTarget', { sessionId }).catch(() => undefined);
        if (r.result?.value === 'SafetyCatch') return String(worker.url).split('/')[2] as string;
        notOurs.add(String(worker.targetId));
      } catch {
        // the worker went away while we looked; try again on the next round
      }
    }
    await sleep(150);
  }
  return '';
}

async function launch(browser: string, withExtension: boolean): Promise<Launched> {
  const maps = [...DEVICE_HOSTS, ...PLATFORM_HOSTS].map((h) => `MAP ${h} 127.0.0.1`);
  const base = [
    '--headless=new',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-search-engine-choice-screen',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--disable-default-apps',
    '--window-size=1280,900',
    `--host-resolver-rules=${[...maps, 'MAP * ~NOTFOUND', 'EXCLUDE localhost', 'EXCLUDE 127.0.0.1'].join(', ')}`,
  ];
  const sideLoad = ['--load-extension=' + extensionDir, '--disable-features=DisableLoadExtensionCommandLineSwitch'];
  const attempts: Array<{ how: string; pipe: boolean; args: string[] }> = withExtension
    ? [
        { how: 'Extensions.loadUnpacked', pipe: true, args: [...base, '--remote-debugging-pipe', '--enable-unsafe-extension-debugging'] },
        { how: '--load-extension (debugging pipe)', pipe: true, args: [...base, '--remote-debugging-pipe', ...sideLoad] },
        { how: '--load-extension (debugging port)', pipe: false, args: [...base, '--remote-debugging-port=0', ...sideLoad] },
      ]
    : [{ how: 'no extension', pipe: true, args: [...base, '--remote-debugging-pipe'] }];
  let lastError = '';
  for (const attempt of attempts) {
    const run = newBrowserRun(PREFIX, browser);
    const profile = join(run.work, 'profile');
    const proc = spawn(browser, [...attempt.args, `--user-data-dir=${profile}`, 'about:blank'], { stdio: attempt.pipe ? ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] : 'ignore' });
    run.started(proc);
    try {
      const cdp = attempt.pipe ? Cdp.overPipe(proc.stdio[3] as Writable, proc.stdio[4] as Readable) : await Cdp.overSocket(await debuggingAddress(profile));
      await Promise.race([cdp.send('Browser.getVersion'), sleep(20_000).then(() => Promise.reject(new Error('browser did not answer')))]);
      let extensionId = '';
      if (withExtension) {
        if (attempt.how === 'Extensions.loadUnpacked') extensionId = String((await cdp.send('Extensions.loadUnpacked', { path: extensionDir })).id ?? '');
        const seen = await waitForExtension(cdp);
        if (!seen) throw new Error('the extension service worker did not start');
        extensionId = extensionId || seen;
      }
      return { proc, cdp, run, extensionId, how: attempt.how };
    } catch (e) {
      lastError += `${lastError ? '; ' : ''}${attempt.how}: ${(e as Error).message}`;
      proc.kill();
      await endProcess(proc);
      run.cleanUp();
    }
  }
  throw new Error(lastError);
}

/** With --remote-debugging-port=0 the browser writes the port it chose into its profile folder. */
async function debuggingAddress(profile: string): Promise<string> {
  const file = join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 100; i++) {
    if (existsSync(file)) {
      const parts = readFileSync(file, 'utf8').split(String.fromCharCode(10)).map((x) => x.trim());
      if (parts[0] && parts[1]) return 'ws://127.0.0.1:' + parts[0] + parts[1];
    }
    await sleep(200);
  }
  throw new Error('the browser did not open a debugging port');
}

/** End the browser we started (and only that one) and wait until it is really gone. */
async function endProcess(proc: ChildProcess): Promise<void> {
  const gone = new Promise<void>((resolve) => (proc.exitCode !== null ? resolve() : proc.once('exit', () => resolve())));
  await Promise.race([gone, sleep(4000)]);
  if (proc.exitCode === null && proc.pid !== undefined) {
    // On Windows a plain kill can leave the browser's child processes behind: end the whole tree.
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
    else proc.kill('SIGKILL');
    await Promise.race([gone, sleep(4000)]);
  }
}

async function stop(l: Launched): Promise<void> {
  await Promise.race([l.cdp.send('Browser.close').catch(() => undefined), sleep(3000)]);
  await endProcess(l.proc);
  // Ends any browser process still using the folder (the whole tree), then deletes the folder.
  const left = l.run.cleanUp();
  if (left.length > 0) console.error(`Cleanup problem: ${left.join('; ')}`);
}

const median = (list: number[]): number => {
  const s = [...list].sort((a, b) => a - b);
  return s.length === 0 ? 0 : (s[Math.floor(s.length / 2)] as number);
};

/** Median page-load timings (ms) of the performance page over `runs` loads. */
async function measure(l: Launched, port: number, runs: number): Promise<{ dcl: number; load: number }> {
  const tab = await Tab.open(l.cdp);
  const dcl: number[] = [];
  const load: number[] = [];
  for (let i = 0; i < runs + 3; i++) {
    await tab.goto(`http://localhost:${port}/perf.html?run=${i}`);
    await sleep(60);
    const t = await tab.ev<{ dcl: number; load: number }>(`(() => { const n = performance.getEntriesByType('navigation')[0]; return { dcl: n.domContentLoadedEventEnd, load: n.loadEventEnd }; })()`);
    if (i >= 3) {
      dcl.push(t.dcl);
      load.push(t.load);
    }
  }
  return { dcl: median(dcl), load: median(load) };
}

async function main(): Promise<void> {
  if (!existsSync(join(extensionDir, 'manifest.json'))) throw new Error('Run `npm run build` first');
  const found = browsers();
  if (found.length === 0) throw new Error('No Chrome or Edge found. Set BROWSER=/path/to/browser');
  const removed = removeLeftovers(PREFIX, found[0] as string);
  if (removed > 0) console.log(`Removed ${removed} leftover smoke-test folder(s) from an earlier run.`);
  const pages = await startPages(0);
  const port = pages.port;
  const site = `http://localhost:${port}`;
  const results: string[] = [];
  let failed = 0;
  const check = (name: string, ok: boolean, detail = ''): void => {
    results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n        ${detail}`}`);
    if (!ok) failed++;
    if (VERBOSE) console.log(results[results.length - 1]);
  };
  /** When a group fails, ask the service worker directly so the report says whether it was reachable. */
  let diagnose: () => Promise<string> = async () => '';
  /** Run one group of checks; an exception fails the group but lets the others run. */
  const group = async (name: string, body: () => Promise<void>): Promise<void> => {
    const started = Date.now();
    try {
      await body();
    } catch (e) {
      check(`${name}: completed`, false, `${(e as Error).message}
        ${await diagnose().catch((d) => `diagnosis failed: ${(d as Error).message}`)}`);
    }
    if (VERBOSE) console.log(`      (${name}: ${Date.now() - started} ms)`);
  };

  let launched: Launched | null = null;
  let launchError = '';
  for (const browser of found) {
    try {
      launched = await launch(browser, true);
      results.push(`INFO  browser: ${browser}`);
      break;
    } catch (e) {
      launchError += `\n  ${browser}: ${(e as Error).message}`;
      results.push(`INFO  could not use ${browser}: ${(e as Error).message}`);
    }
  }
  if (!launched) {
    await pages.close();
    throw new Error(`Could not load the extension into any browser:${launchError}`);
  }
  const l = launched;
  const { cdp } = l;
  // Never hang: if the browser stops answering (for example on a machine that is out of memory),
  // report what was done so far, close the browser and fail.
  const watchdog = setTimeout(() => {
    for (const line of results) console.log(line);
    console.log(`Smoke test FAILED: no result after ${LIMIT_MS / 1000} seconds (the browser stopped answering).`);
    void endProcess(l.proc).then(() => process.exit(1));
    l.proc.kill();
  }, LIMIT_MS);
  const version = await cdp.send('Browser.getVersion');
  results.push(`INFO  ${version.product}, extension loaded with ${l.how}, id ${l.extensionId}`);

  try {
    // Watch the service worker for uncaught errors.
    const { targetInfos } = await cdp.send('Target.getTargets');
    const worker = (targetInfos as Json[]).find((t) => t.type === 'service_worker' && String(t.url).includes(l.extensionId));
    if (worker) {
      const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: worker.targetId, flatten: true });
      await cdp.send('Runtime.enable', {}, sessionId);
    }
    cdp.extensionId = l.extensionId;
    await cdp.send('Target.setDiscoverTargets', { discover: true });
    check('extension loads and its service worker starts', l.extensionId.length === 32);

    const tab = await Tab.open(cdp);
    const NOTE = 'SafetyCatch removed a risky command';
    /** Ask the service worker for its state from an extension page; reports how long the answer took. */
    const probeWorker = async (): Promise<string> => {
      const probe = await Tab.open(cdp);
      try {
        const opened = await probe.goto(`chrome-extension://${l.extensionId}/options.html`, 8000);
        const where = await probe.ev<string>('location.href + " | runtime: " + (typeof chrome !== "undefined" && !!chrome.runtime && !!chrome.runtime.sendMessage)');
        if (!opened || !where.endsWith('true')) return `could not open the options page (loaded: ${opened}, at ${where})`;
        const t0 = Date.now();
        const answer = await probe.ev<string>(`Promise.race([chrome.runtime.sendMessage({ type: 'get-state', url: '' }).then((r) => 'answered ' + (r && r.ok), (e) => 'rejected: ' + e.message), new Promise((done) => setTimeout(() => done('NO ANSWER in 10 s'), 10000))])`);
        return `${answer} after ${Date.now() - t0} ms`;
      } finally {
        await cdp.send('Target.closeTarget', { targetId: probe.targetId }).catch(() => undefined);
      }
    };
    diagnose = async (): Promise<string> => `service worker probe: ${await probeWorker()}; extension console: ${cdp.notes.slice(-3).join(' | ') || 'nothing'}`;
    // Warm-up: make sure the service worker has started (and loaded its language file) before timing-sensitive checks.
    results.push(`INFO  service worker warm-up: ${await probeWorker()}`);
    const noUi = async (): Promise<boolean> => (await tab.ui()).text.trim() === '';
    // The clipboard is read back the way a person would use it: a real paste into a text box in another tab.
    const clipTab = await Tab.open(cdp);
    if (!(await clipTab.goto(`http://127.0.0.1:${port}/clip.html`))) throw new Error('could not open the clipboard helper page');
    const readClipboard = async (): Promise<string> => {
      await clipTab.ev('(() => { const a = document.getElementById("a"); a.value = ""; a.focus(); return true; })()');
      await clipTab.paste();
      await sleep(150);
      return clipTab.ev<string>('document.getElementById("a").value');
    };

    await group('paste guard', async () => {
      await tab.goto(`${site}/fake-captcha.html`);
      const command = await tab.ev<string>('window.testCommand()');
      await tab.click('#verify');
      const view = await tab.waitUi((v) => v.modalText.includes('secretly copied'), 'the paste warning');
      const clip = await readClipboard();
      check('fake CAPTCHA (clipboard API): clipboard is replaced by a harmless note', clip.startsWith(NOTE) && !clip.includes('Write-Output'), `clipboard: ${clip.slice(0, 120)}`);
      check('fake CAPTCHA: full-page warning explains what happened', view.modalText.includes('localhost') && view.modalText.includes('Real websites never ask'), view.modalText.slice(0, 200));
      check('fake CAPTCHA: the copied command is shown as text in the warning', view.modalText.includes("Write-Output 'SafetyCatch test"), view.modalText.slice(0, 400));
      check('fake CAPTCHA: the page was told the copy worked (no retry signal)', (await tab.ev<string>('document.getElementById("status").textContent')).includes('copied'));
      // A hostile page tries to dismiss the warning with synthetic events.
      await tab.ev(`(() => { const host = document.documentElement.lastElementChild; for (const type of ['click', 'pointerdown', 'pointerup', 'keydown']) host.dispatchEvent(new MouseEvent(type, { bubbles: true, composed: true, clientX: 300, clientY: 300 })); host.click(); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true; })()`);
      await sleep(200);
      check('synthetic events from the page cannot dismiss the warning', (await tab.ui()).modalText.includes('secretly copied'));
      await tab.ev('document.documentElement.lastElementChild.remove(), true');
      await sleep(700);
      check('the warning comes back if the page removes it', (await tab.ui()).modalText.includes('secretly copied'));
      await tab.press('Keep it removed');
      await sleep(250);
      check('"Keep it removed" closes the warning and leaves the note', (await noUi()) && (await readClipboard()).startsWith(NOTE));

      await tab.click('#verify');
      await tab.waitUi((v) => v.modalText.includes('secretly copied'), 'the paste warning (second time)');
      await tab.press('Hold to put the command back', 300);
      await sleep(300);
      check('a short press on the hold button does nothing', (await readClipboard()).startsWith(NOTE) && (await tab.ui()).modalText.includes('secretly copied'));
      await tab.press('Hold to put the command back', 1900);
      await sleep(400);
      check('press-and-hold restores the command and closes the warning', (await readClipboard()) === command && (await noUi()), `clipboard: ${(await readClipboard()).slice(0, 80)}`);

      for (const via of ['exec', 'event', 'frame']) {
        await tab.goto(`${site}/fake-captcha.html?via=${via}`);
        await tab.click('#verify');
        await tab.waitUi((v) => v.modalText.includes('secretly copied'), `the paste warning (${via})`);
        const now = await readClipboard();
        check(`fake CAPTCHA (${via === 'exec' ? 'execCommand' : via === 'event' ? 'copy-event handler' : 'fresh iframe'}): neutralised and warned`, now.startsWith(NOTE), `clipboard: ${now.slice(0, 120)}`);
        await tab.press('Keep it removed');
        await sleep(150);
      }
    });

    await group('paste guard on a plain-http page', async () => {
      // Without https there is no navigator.clipboard: the page must use execCommand, and so must our harmless note.
      let opened = false;
      for (const host of DEVICE_HOSTS) {
        if ((await tab.goto(`http://${host}:${port}/fake-captcha.html?via=exec`, 6000)) && (await tab.ev<boolean>('window.isSecureContext === false && !navigator.clipboard'))) {
          opened = true;
          break;
        }
      }
      if (!opened) {
        results.push('SKIP  paste guard on a plain-http page: the browser forces https for every stand-in host name');
        return;
      }
      await tab.click('#verify');
      await tab.waitUi((v) => v.modalText.includes('secretly copied'), 'the paste warning (plain http)');
      const now = await readClipboard();
      check('fake CAPTCHA on a plain-http page (no clipboard API): neutralised with execCommand and warned', now.startsWith(NOTE), `clipboard: ${now.slice(0, 120)}`);
      await tab.press('Keep it removed');
    });

    await group('benign copy', async () => {
      await tab.goto(`${site}/fake-captcha.html`);
      await tab.click('#benign');
      await sleep(500);
      check('benign copy (plain sentence) is untouched and shows no warning', (await readClipboard()) === 'Hello from the SafetyCatch test page.' && (await noUi()));
      await tab.click('#link');
      await sleep(500);
      check('benign copy (a link) is untouched and shows no warning', (await readClipboard()) === 'https://example.com/some/page?x=1' && (await noUi()));
    });

    await group('look-alike sign-in', async () => {
      await tab.goto(`${site}/lookalike-login.html`);
      const banner = await tab.waitUi((v) => v.bannerText.includes('fake PayPal'), 'the look-alike banner');
      check('look-alike page: banner names the brand and the real address', banner.bannerText.includes('paypal.com') && banner.bannerText.includes('localhost'), banner.bannerText.slice(0, 300));
      await tab.click('#password');
      const modal = await tab.waitUi((v) => v.modalText.includes('fake PayPal'), 'the look-alike warning');
      check('look-alike page: focusing the password field shows a full-page warning', modal.modalText.includes('The real PayPal address is paypal.com'), modal.modalText.slice(0, 300));
      await tab.press('Hold to stay and type anyway', 1900);
      await sleep(300);
      await tab.click('#password');
      await tab.type('a');
      await sleep(150);
      check('look-alike page: after a deliberate hold, typing works', (await tab.ev<string>('document.getElementById("password").value')) === 'a');
      // A fresh visit in a new tab (no earlier decision for that tab): typing is stopped first.
      const other = await Tab.open(cdp);
      await other.goto(`${site}/lookalike-login.html`);
      await other.waitUi((v) => v.bannerText.includes('fake PayPal'), 'the look-alike banner (new tab)');
      await other.ev('document.getElementById("password").focus(), true');
      await sleep(300);
      await other.type('z');
      await sleep(200);
      check('look-alike page: typing a password is stopped until the person decides', (await other.ev<string>('document.getElementById("password").value')) === '' && (await other.ui()).modalText.includes('fake PayPal'));
      await cdp.send('Target.closeTarget', { targetId: other.targetId });
    });

    await group('AI-chat paste guard', async () => {
      // Add localhost to the AI chat sites through the real options page.
      await tab.goto(`chrome-extension://${l.extensionId}/options.html`);
      await tab.ev(`new Promise((done) => { const wait = () => document.getElementById('ai-sites').value.includes('chatgpt.com') ? done(true) : setTimeout(wait, 50); wait(); })`);
      await tab.ev(`(() => { const a = document.getElementById('ai-sites'); a.value += '\\nlocalhost'; document.getElementById('ai-save').click(); return true; })()`);
      let sites: string[] = [];
      for (let i = 0; i < 40 && !sites.includes('localhost'); i++) {
        await sleep(150);
        sites = await tab.ev<string[]>('chrome.storage.local.get("settings").then((s) => (s.settings ? s.settings.aiSites : []))');
      }
      check('options page: AI chat site list can be edited and saved', sites.includes('localhost') && sites.includes('chatgpt.com'), JSON.stringify(sites));
      check('options page: lists what is stored', (await tab.ev<string>('document.body.innerText')).includes('Never stored'));

      await tab.goto(`${site}/ai-chat.html`);
      await tab.click('#fake');
      await sleep(300);
      for (const [selector, read, name] of [
        ['#rich', 'document.getElementById("rich").textContent', 'rich editor'],
        ['#plain', 'document.getElementById("plain").textContent', 'plain contenteditable'],
        ['#area', 'document.getElementById("area").value', 'text area'],
      ] as const) {
        await tab.click(selector);
        await tab.paste();
        const view = await tab.waitUi((v) => v.modalText.includes('seems to contain secrets'), `the secrets dialog (${name})`);
        if (selector === '#rich') check('AI chat: the dialog names the kind of secret without showing it', view.modalText.includes('GitHub token') && !view.modalText.includes('A1b2C3d4E5f6G7h8I9j0'), view.modalText.slice(0, 300));
        await tab.press('Paste with secrets hidden');
        await sleep(350);
        const value = await tab.ev<string>(read);
        check(`AI chat (${name}): the secret is redacted in what gets pasted`, value.includes('[REDACTED:github-token]') && !value.includes('ghp_') && value.includes('Please debug this config'), value.slice(0, 160));
      }
      await tab.ev('document.getElementById("area").value = "", true');
      await tab.click('#area');
      await tab.paste();
      await tab.waitUi((v) => v.modalText.includes('seems to contain secrets'), 'the secrets dialog (cancel)');
      await tab.press('Cancel');
      await sleep(250);
      check('AI chat: "Cancel" pastes nothing', (await tab.ev<string>('document.getElementById("area").value')) === '' && (await noUi()));
      await tab.click('#clean');
      await sleep(300);
      await tab.click('#area');
      await tab.paste();
      await sleep(500);
      check('AI chat: text without secrets pastes normally, no dialog', (await tab.ev<string>('document.getElementById("area").value')).includes('summarise the plot') && (await noUi()));
    });

    await group('risky download', async () => {
      const downloads = mkdtempSync(join(tmpdir(), 'safetycatch-browser-dl-'));
      await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads, eventsEnabled: true });
      await tab.goto(`${site}/download.html`);
      await tab.click('#plain');
      await sleep(1200);
      const before = ((await cdp.send('Target.getTargets')).targetInfos as Json[]).filter((t) => String(t.url).includes('/download.html?id='));
      check('ordinary download (notes.txt): no question asked', before.length === 0);
      await tab.click('#risky');
      let prompt: Json = null;
      for (let i = 0; i < 100 && !prompt; i++) {
        await sleep(150);
        prompt = ((await cdp.send('Target.getTargets')).targetInfos as Json[]).find((t) => t.type === 'page' && String(t.url).includes(`${l.extensionId}/download.html?id=`)) ?? null;
      }
      let seen = '';
      if (!prompt) {
        // Say what the browser did instead (for example blocked the file itself before any extension saw it).
        const targets = ((await cdp.send('Target.getTargets')).targetInfos as Json[]).filter((t) => String(t.url).includes(l.extensionId)).map((t) => `${t.type} ${String(t.url).split('/').slice(3).join('/')}`);
        const probe = await Tab.open(cdp);
        await probe.goto(`chrome-extension://${l.extensionId}/options.html`, 8000);
        const items = await probe.ev<string>('chrome.storage.session.get("downloads").then((s) => JSON.stringify(Object.values(s.downloads || {}).map((d) => ({ name: d.name, finished: d.finished, decided: d.decided }))))').catch((e) => `unreadable: ${(e as Error).message}`);
        await cdp.send('Target.closeTarget', { targetId: probe.targetId }).catch(() => undefined);
        seen = `extension targets: ${targets.join(', ') || 'none'}; downloads the extension is asking about: ${items}`;
      }
      check('risky download (Invoice_2026.pdf.js): a prompt window opens', prompt !== null, seen);
      if (prompt) {
        const win = await Tab.attach(cdp, prompt.targetId);
        const view = await win.waitUi((v) => v.modalText.includes('This download looks risky'), 'the download prompt');
        check('risky download: the prompt names the file and why', view.modalText.includes('Invoice_2026.pdf.js') && view.modalText.includes('Why this is risky'), view.modalText.slice(0, 300));
        // A file this small can finish before it is paused; the prompt then offers to delete it instead.
        const finished = view.modalText.includes('already finished');
        const safeChoice = finished ? 'Delete the file' : 'Cancel the download';
        await win.press(safeChoice);
        let said = '';
        for (let i = 0; i < 40 && said === ''; i++) {
          await sleep(150);
          said = await win.ev<string>('document.getElementById("done").hidden ? "" : document.getElementById("done").textContent');
        }
        check(`risky download: the safe choice ("${safeChoice}") is carried out and confirmed`, said.includes(finished ? 'The file was deleted' : 'The download was cancelled'), said);
        await cdp.send('Target.closeTarget', { targetId: prompt.targetId }).catch(() => undefined);
      }
      rmSync(downloads, { recursive: true, force: true });
    });

    await group('device-code page', async () => {
      let deviceUrl = '';
      for (const host of DEVICE_HOSTS) {
        const url = `http://${host}:${port}/devicelogin`;
        if ((await tab.goto(url, 6000)) && (await tab.ev<string>('document.title')) === 'Enter code') {
          deviceUrl = url;
          break;
        }
      }
      if (!deviceUrl) {
        results.push('SKIP  device-code page: the browser forces https for every stand-in host name (see docs/MANUAL_TEST.md)');
        return;
      }
      const banner = await tab.waitUi((v) => v.bannerText.includes('Only enter a code here if you started this yourself'), 'the device-code banner');
      check('device-code page opened directly: calm banner, page stays usable', banner.modalText.trim() === '' && banner.bannerText.includes('Microsoft'), banner.bannerText.slice(0, 200));
      await tab.goto(`${site}/from-message.html?to=${encodeURIComponent(deviceUrl)}`);
      await tab.click('#go');
      const wall = await tab.waitUi((v) => v.modalText.includes('Only enter a code here if you started this yourself'), 'the device-code interstitial');
      check('device-code page reached from another site: full-page warning that says where you came from', wall.modalText.includes('You came here from localhost'), wall.modalText.slice(0, 300));
      await tab.press('Hold: I started this on my own device', 1900);
      await sleep(300);
      check('device-code interstitial: a deliberate hold lets the person continue', (await tab.ui()).modalText.trim() === '');
    });

    await group('platform lure', async () => {
      let ok = false;
      for (const host of PLATFORM_HOSTS) {
        if ((await tab.goto(`http://${host}:${port}/help/fix-update`, 6000)) && (await tab.ev<string>('document.title')).includes('fix the update')) {
          ok = true;
          break;
        }
      }
      if (!ok) {
        results.push('SKIP  platform lure: the browser forces https for every stand-in host name (see docs/MANUAL_TEST.md)');
        return;
      }
      // The test page is a fake 'fix' that also says to choose 'Run anyway': since engine 0.1.1 that is a real lure,
      // so it gets the strong warning (plain download steps on such platforms get the calm notice; see test/core.test.ts).
      const view = await tab.waitUi((v) => (v.modalText + v.bannerText).includes('Do not follow the steps on this page'), 'the platform lure warning');
      check('publish-anything platform with a fake fix plus Run anyway: strong warning', (view.modalText + view.bannerText).includes('Anyone can publish a page on this service'), (view.modalText + view.bannerText).slice(0, 160));
    });

    await group('popup and storage', async () => {
      await tab.goto(`chrome-extension://${l.extensionId}/popup.html`);
      let text = '';
      for (let i = 0; i < 60 && !text.includes('Recent warnings'); i++) {
        await sleep(150);
        text = await tab.ev<string>('document.body.innerText');
      }
      check('popup: shows protections and recent warnings', text.includes('Protections') && text.includes('Recent warnings') && text.includes('localhost'), text.slice(0, 300));
      const stored = await tab.ev<string>('chrome.storage.local.get(null).then((all) => JSON.stringify(all))');
      const parsed = JSON.parse(stored) as { history?: Array<Record<string, unknown>> };
      const keysOk = (parsed.history ?? []).every((e) => Object.keys(e).sort().join(',') === 'a,d,l,m,r,t');
      check('stored history holds only site, protection, level, rule ids, action and time', (parsed.history ?? []).length > 0 && keysOk && !stored.includes('Write-Output') && !stored.includes('ghp_') && !stored.includes('Invoice_2026'), stored.slice(0, 300));
    });

    check('no uncaught errors in the extension', cdp.problems.length === 0, cdp.problems.join(' | '));
    results.push(`INFO  the browser restarted the service worker ${Math.max(0, cdp.workerStarts - 1)} time(s) during the run`);
  } catch (e) {
    failed++;
    results.push(`ERROR ${(e as Error).stack ?? (e as Error).message}`);
  } finally {
    clearTimeout(watchdog);
    await stop(l);
  }

  if (PERF) {
    const browser = found[0] as string;
    const runs = 15;
    const without = await launch(browser, false);
    const a = await measure(without, port, runs);
    await stop(without);
    const withExt = await launch(browser, true);
    const b = await measure(withExt, port, runs);
    await stop(withExt);
    results.push(
      `PERF  page with 1,500 paragraphs and 3 iframes, median of ${runs} loads:`,
      `        DOMContentLoaded  without ${a.dcl.toFixed(1)} ms   with ${b.dcl.toFixed(1)} ms   added ${(b.dcl - a.dcl).toFixed(1)} ms`,
      `        load              without ${a.load.toFixed(1)} ms   with ${b.load.toFixed(1)} ms   added ${(b.load - a.load).toFixed(1)} ms`,
    );
  }

  await pages.close();
  console.log(results.join('\n'));
  const count = results.filter((r) => r.startsWith('PASS')).length;
  console.log(failed === 0 ? `\nSmoke test passed (${count} checks).` : `\nSmoke test FAILED (${failed} problems, ${count} checks passed).`);
  process.exit(failed === 0 ? 0 : 1);
}

await main();
