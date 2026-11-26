// Makes sure the headless Chrome or Edge of the smoke test goes away again.
// (Same approach as safetycatch-photo-privacy's scripts/browser.ts; this test
// starts the browser itself because it talks to it over a debugging pipe.) The whole browser process tree is closed and its temporary
// profile folder deleted (with retries for Windows file locks) when the test
// passes, fails, throws, or is stopped with Ctrl+C. Browsers and folders left
// behind by an earlier run that was killed outright are removed at the next
// start. (Earlier versions could leave a headless browser running for hours.)
// Never run two smoke tests of the same project at the same time.

import { spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { constants, tmpdir } from 'node:os';
import path from 'node:path';


const sleepSync = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/** Browser processes whose command line contains `marker` (every process of a
 * Chrome/Edge run carries its profile folder on its command line). Only browser
 * executables are matched, never a shell or editor that mentions the folder. */
function browserProcessesWith(marker: string, exeNames: readonly string[]): number[] {
  if (!/^[A-Za-z0-9-]+$/.test(marker)) throw new Error(`unsafe marker ${marker}`);
  if (process.platform === 'win32') {
    const names = [...new Set(exeNames)].filter((n) => /^[A-Za-z0-9._-]+$/.test(n));
    const byName = names.map((n) => `Name='${n}'`).join(' OR ');
    const query = `Get-CimInstance Win32_Process -Filter "(${byName}) AND CommandLine LIKE '%${marker}%'" | ForEach-Object { $_.ProcessId }`;
    const out = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', query], { encoding: 'utf8', windowsHide: true, timeout: 60_000 }).stdout ?? '';
    return out.split(/\s+/).filter((s) => /^\d+$/.test(s)).map(Number);
  }
  const out = spawnSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' }).stdout ?? '';
  const pids: number[] = [];
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\S+)(.*)$/.exec(line);
    if (m && /chrom|edge/i.test(path.basename(m[2]!)) && line.includes(marker)) pids.push(Number(m[1]));
  }
  return pids.filter((pid) => pid !== process.pid);
}

function killTree(pid: number): void {
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 30_000 });
    return;
  }
  for (const target of [-pid, pid]) {
    try {
      process.kill(target, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

/** Kills every browser process that mentions `marker` and deletes `dirs`. Returns what is left. */
function removeAll(marker: string, exeNames: readonly string[], dirs: readonly string[]): string[] {
  let left = browserProcessesWith(marker, exeNames);
  for (let i = 0; i < 3 && left.length > 0; i++) {
    for (const pid of left) killTree(pid);
    sleepSync(500);
    left = browserProcessesWith(marker, exeNames);
  }
  const problems = left.length > 0 ? [`browser processes still running: ${left.join(', ')}`] : [];
  for (const dir of dirs) {
    for (let i = 0; i < 5 && existsSync(dir); i++) {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      } catch {
        sleepSync(1000);
      }
    }
    if (existsSync(dir)) problems.push(`could not delete ${dir}`);
  }
  return problems;
}

const exeNamesOf = (browserPath: string): string[] => [path.basename(browserPath), 'chrome.exe', 'msedge.exe'];

/**
 * Removes browsers and folders left behind by an earlier run that was killed
 * before it could clean up. Call once, before the first browser starts.
 * Returns how many folders were removed; throws when something could not be removed.
 */
export function removeLeftovers(prefix: string, browserPath: string): number {
  const stale = readdirSync(tmpdir()).filter((n) => n.startsWith(prefix));
  const problems = removeAll(prefix, exeNamesOf(browserPath), stale.map((n) => path.join(tmpdir(), n)));
  if (problems.length > 0) throw new Error(`Leftovers of an earlier run could not be removed: ${problems.join('; ')}`);
  return stale.length;
}

export interface BrowserRun {
  /** Fresh temporary folder for this browser; put the profile inside. */
  readonly work: string;
  /** Register the browser process once it is started. */
  started(proc: ChildProcess): void;
  /** Ends every browser process that uses `work` and deletes it. Returns what is left (empty when clean). */
  cleanUp(): string[];
}

/** One browser run: its folder, and a clean-up that also runs on Ctrl+C and on any exit. */
export function newBrowserRun(prefix: string, browserPath: string): BrowserRun {
  const exeNames = exeNamesOf(browserPath);
  const work = mkdtempSync(path.join(tmpdir(), prefix));
  const marker = path.basename(work);
  let proc: ChildProcess | null = null;
  let done = false;
  const cleanUp = (): string[] => {
    if (done) return [];
    done = true;
    if (proc?.pid !== undefined && proc.exitCode === null && proc.signalCode === null) killTree(proc.pid);
    return removeAll(marker, exeNames, [work]);
  };
  const onSignal = (signal: NodeJS.Signals): void => {
    console.error(`\n${signal}: closing the browser and deleting its temporary profile...`);
    const problems = cleanUp();
    if (problems.length > 0) console.error(problems.join('\n'));
    process.exit(130);
  };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'] as const) if (sig in constants.signals) process.once(sig, onSignal);
  process.once('exit', () => {
    cleanUp();
  });
  return {
    work,
    started(p) {
      proc = p;
    },
    cleanUp,
  };
}
