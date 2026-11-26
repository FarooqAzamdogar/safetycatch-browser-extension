// Copyright 2026 The SafetyCatch Authors
// SPDX-License-Identifier: Apache-2.0
//
// Toolbar popup: status for the current site, protection switches, "trust this
// site" (press-and-hold, with an end date) and the list of recent warnings.

import { TRUST_DURATIONS } from '../shared/allowlist.ts';
import { MODULE_IDS } from '../shared/modules.ts';
import { applyI18n, el, formatTime, holdButton, loadState, send, type Loaded } from './common.ts';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const RECENT_SHOWN = 8;

async function currentUrl(): Promise<string> {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs[0]?.url ?? '';
  } catch {
    return '';
  }
}

function render(loaded: Loaded, url: string): void {
  const { state, t } = loaded;
  applyI18n(document, t, state.locale, state.dir);
  const refresh = async (): Promise<void> => {
    const next = await loadState(url);
    if (next) render(next, url);
  };

  const status = $('status');
  const site = state.site;
  if (!site.canRun) status.textContent = t('popup_cannot');
  else if (site.trust) status.textContent = site.trust.expiresAt === null ? t('popup_trusted_forever', { site: site.host }) : t('popup_trusted', { site: site.host, date: formatTime(site.trust.expiresAt, state.locale) });
  else status.textContent = t('popup_on', { site: site.host });
  status.className = site.canRun && !site.trust ? 'status on' : 'status off';

  const modules = $('modules');
  modules.replaceChildren();
  for (const id of MODULE_IDS) {
    const label = el('label', undefined, 'switch');
    const box = el('input');
    box.type = 'checkbox';
    box.checked = state.settings.modules[id];
    box.addEventListener('change', () => {
      void send({ type: 'set-module', module: id, enabled: box.checked }).then(refresh);
    });
    label.append(box, el('span', t(`mod_${id}`)));
    modules.append(label);
  }

  const trust = $('trust');
  trust.replaceChildren();
  trust.hidden = !site.canRun;
  if (site.canRun) {
    trust.append(el('h2', t('trust_title')));
    if (site.trust) {
      const pattern = site.trust.pattern;
      const stop = el('button', t('trust_remove'));
      stop.type = 'button';
      stop.addEventListener('click', () => {
        void send({ type: 'remove-trust', pattern }).then(refresh);
      });
      trust.append(stop);
    } else {
      trust.append(el('p', t('trust_warn'), 'hint'));
      const pick = el('label', t('trust_for'));
      const select = el('select');
      for (const key of Object.keys(TRUST_DURATIONS)) {
        const option = el('option', t(`dur_${key}`));
        option.value = key;
        option.selected = key === 'day';
        select.append(option);
      }
      pick.append(' ', select);
      const hold = el('button');
      hold.type = 'button';
      hold.append(el('span', t('trust_hold', { site: site.host }), 'lbl'));
      holdButton(hold, () => {
        void send({ type: 'add-trust', pattern: site.host, duration: select.value }).then(refresh);
      });
      trust.append(pick, hold, el('p', t('hold_hint'), 'hint'));
    }
  }

  const recent = $('recent');
  recent.replaceChildren();
  const entries = state.history.slice(0, RECENT_SHOWN);
  if (entries.length === 0) recent.append(el('li', t('recent_none'), 'hint'));
  for (const e of entries) {
    const item = el('li');
    item.append(el('strong', e.d), el('span', ` · ${t(`mod_${e.m}`)} · ${state.levels[e.l]}`), el('time', formatTime(e.t, state.locale)));
    recent.append(item);
  }
  $('clear').hidden = entries.length === 0;
  $('version').textContent = t('opt_version', { version: state.version, engine: state.engineVersion });
}

async function main(): Promise<void> {
  const url = await currentUrl();
  const loaded = await loadState(url);
  if (!loaded) {
    // Fail safe: say that protection may be limited, never "all good".
    const status = $('status');
    status.textContent = chrome.i18n.getMessage('status_error');
    status.className = 'status off';
    return;
  }
  $('clear').addEventListener('click', () => {
    void send({ type: 'clear-history' }).then(async () => {
      const next = await loadState(url);
      if (next) render(next, url);
    });
  });
  $('options').addEventListener('click', () => {
    void chrome.runtime.openOptionsPage();
  });
  render(loaded, url);
}

void main();
