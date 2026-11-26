// Copyright 2026 The SafetyCatch Authors
// SPDX-License-Identifier: Apache-2.0

/**
 * How did this tab reach the page it shows? A small pure state machine fed by
 * `webNavigation` events in the service worker. It keeps the last few
 * top-level addresses per tab (in memory-only session storage) so a sign-in
 * page reached "from another site" or "from a link outside the browser" can be
 * treated as riskier than one the person typed.
 */

export type NavHow = 'typed' | 'link' | 'redirect' | 'form' | 'reload' | 'other';

interface NavEntry {
  url: string;
  t: number;
  how: NavHow;
}

interface TabNav {
  entries: NavEntry[];
  /** Address of the page that opened this tab (link in a new tab, window.open). */
  opener?: string;
  /** First address requested by the navigation in progress (before any redirect). */
  pending?: string;
  /** Last time anything happened in this tab. */
  seen: number;
}

export type NavState = Record<string, TabNav>;

export const MAX_ENTRIES = 6;
export const MAX_TABS = 200;
export const MAX_URL_CHARS = 600;
const MAX_AGE_MS = 30 * 60 * 1000;

export type Arrival = 'typed' | 'link' | 'external' | 'unknown';

const cut = (url: string): string => (url.length > MAX_URL_CHARS ? url.slice(0, MAX_URL_CHARS) : url);
const isWeb = (url: unknown): url is string => typeof url === 'string' && /^https?:\/\//i.test(url);

/** Map the browser's transition type and qualifiers to our small vocabulary. */
export function classify(transitionType: string | undefined, qualifiers: readonly string[] | undefined): NavHow {
  const q = qualifiers ?? [];
  if (q.includes('forward_back')) return 'reload';
  if (q.includes('from_address_bar')) return 'typed';
  switch (transitionType) {
    case 'typed':
    case 'auto_bookmark':
    case 'generated':
    case 'keyword':
    case 'keyword_generated':
    case 'start_page':
      return 'typed';
    case 'reload':
      return 'reload';
    case 'form_submit':
      return 'form';
    case 'link':
      return q.includes('server_redirect') || q.includes('client_redirect') ? 'redirect' : 'link';
    default:
      return 'other';
  }
}

function tabOf(state: NavState, tabId: number, t: number): TabNav {
  const old = state[String(tabId)];
  return old ? { ...old, entries: [...old.entries], seen: t } : { entries: [], seen: t };
}

/** A top-level navigation is starting: remember the address that was asked for. */
export function beforeNavigate(state: NavState, tabId: number, url: string, t: number): NavState {
  if (!isWeb(url)) return state;
  const tab = tabOf(state, tabId, t);
  tab.pending = cut(url);
  return { ...state, [String(tabId)]: tab };
}

/** A top-level navigation committed. */
export function committed(state: NavState, tabId: number, url: string, transitionType: string | undefined, qualifiers: readonly string[] | undefined, t: number): NavState {
  const tab = tabOf(state, tabId, t);
  const pending = tab.pending;
  delete tab.pending;
  if (!isWeb(url)) {
    // Browser pages (new tab, settings) break the chain: what follows was started by the person.
    tab.entries = [];
    delete tab.opener;
    return { ...state, [String(tabId)]: tab };
  }
  const how = classify(transitionType, qualifiers);
  const last = tab.entries[tab.entries.length - 1];
  const here = cut(url);
  if (how === 'reload' && last && last.url === here) {
    last.t = t;
  } else {
    const redirected = pending !== undefined && pending !== here && (qualifiers ?? []).includes('server_redirect');
    if (redirected) {
      const base = classify(transitionType, (qualifiers ?? []).filter((x) => x !== 'server_redirect' && x !== 'client_redirect'));
      if (!last || last.url !== pending) tab.entries.push({ url: pending, t, how: base });
      tab.entries.push({ url: here, t, how: 'redirect' });
    } else {
      tab.entries.push({ url: here, t, how });
    }
  }
  if (tab.entries.length > MAX_ENTRIES) tab.entries = tab.entries.slice(-MAX_ENTRIES);
  return { ...state, [String(tabId)]: tab };
}

/** A tab was opened from another tab (link opened in a new tab, pop-up). */
export function createdTarget(state: NavState, sourceTabId: number, tabId: number, t: number): NavState {
  const source = state[String(sourceTabId)];
  const from = source?.entries[source.entries.length - 1]?.url;
  const tab = tabOf(state, tabId, t);
  if (from) tab.opener = from;
  return { ...state, [String(tabId)]: tab };
}

export function tabRemoved(state: NavState, tabId: number): NavState {
  if (!(String(tabId) in state)) return state;
  const next = { ...state };
  delete next[String(tabId)];
  return next;
}

/** Drop tabs that have been quiet for a long time and keep the table small. */
export function prune(state: NavState, now: number): NavState {
  let ids = Object.keys(state).filter((id) => now - (state[id]?.seen ?? 0) <= MAX_AGE_MS);
  if (ids.length > MAX_TABS) {
    ids = ids.sort((a, b) => (state[b]?.seen ?? 0) - (state[a]?.seen ?? 0)).slice(0, MAX_TABS);
  }
  if (ids.length === Object.keys(state).length) return state;
  const next: NavState = {};
  for (const id of ids) next[id] = state[id] as TabNav;
  return next;
}

/** How the page now shown in the tab was reached. */
export function arrival(state: NavState, tabId: number): Arrival {
  const tab = state[String(tabId)];
  if (!tab || tab.entries.length === 0) return 'unknown';
  let i = tab.entries.length - 1;
  while (i > 0 && (tab.entries[i]?.how === 'redirect' || tab.entries[i]?.how === 'reload')) i--;
  const how = tab.entries[i]?.how;
  if (how === 'typed') return 'typed';
  if (how === 'reload' || how === 'other') return 'unknown';
  if (i > 0 || tab.opener) return 'link';
  return 'external';
}

/**
 * Addresses that may have sent the person to the current page, most recent
 * first: earlier pages in this tab (including redirect hops) and the page that
 * opened the tab. Pages on the same host as the current one are skipped.
 */
export function referrerCandidates(state: NavState, tabId: number, currentUrl: string, max = 5): string[] {
  const tab = state[String(tabId)];
  if (!tab) return [];
  let currentHost = '';
  try {
    currentHost = new URL(currentUrl).hostname;
  } catch {
    // keep empty
  }
  const out: string[] = [];
  const add = (url: string | undefined): void => {
    if (!url || out.includes(url) || out.length >= max) return;
    try {
      if (new URL(url).hostname === currentHost) return;
    } catch {
      return;
    }
    out.push(url);
  };
  // Walk back along the links, form posts and redirects that led here. An address the person typed
  // (or a reload, or a back/forward step) starts a new chain: pages before it did not send them here.
  let i = tab.entries.length - 1;
  for (; i >= 0; i--) {
    const how = tab.entries[i]?.how;
    if (how !== 'link' && how !== 'redirect' && how !== 'form') break;
    if (i > 0) add(tab.entries[i - 1]?.url);
  }
  if (i < 0) add(tab.opener);
  return out;
}

/** Validate a state object read back from session storage. */
export function sanitizeNavState(raw: unknown): NavState {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  const out: NavState = {};
  for (const [id, value] of Object.entries(raw as Record<string, unknown>).slice(0, MAX_TABS * 2)) {
    if (!/^\d{1,12}$/.test(id) || typeof value !== 'object' || value === null) continue;
    const v = value as Record<string, unknown>;
    const entries: NavEntry[] = [];
    if (Array.isArray(v['entries'])) {
      for (const e of v['entries'].slice(-MAX_ENTRIES)) {
        if (typeof e !== 'object' || e === null) continue;
        const r = e as Record<string, unknown>;
        if (isWeb(r['url']) && typeof r['t'] === 'number' && typeof r['how'] === 'string' && ['typed', 'link', 'redirect', 'form', 'reload', 'other'].includes(r['how'])) {
          entries.push({ url: cut(r['url']), t: r['t'], how: r['how'] as NavHow });
        }
      }
    }
    const tab: TabNav = { entries, seen: typeof v['seen'] === 'number' ? v['seen'] : 0 };
    if (isWeb(v['opener'])) tab.opener = cut(v['opener']);
    if (isWeb(v['pending'])) tab.pending = cut(v['pending']);
    out[id] = tab;
  }
  return out;
}
