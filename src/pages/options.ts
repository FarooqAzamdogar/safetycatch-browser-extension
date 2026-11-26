// Copyright 2026 The SafetyCatch Authors
// SPDX-License-Identifier: Apache-2.0
//
// Options page: protection switches, AI-chat site list, trusted sites,
// language, export/import and a plain "what is stored" section.

import { TRUST_DURATIONS } from '../shared/allowlist.ts';
import { HISTORY_CAP } from '../shared/history.ts';
import { MODULE_IDS } from '../shared/modules.ts';
import { DEFAULT_AI_SITES, exportSettings, LANGUAGE_CHOICES, MAX_IMPORT_CHARS, type Settings } from '../shared/settings.ts';
import { applyI18n, el, formatTime, loadState, send, type Loaded } from './common.ts';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const LANGUAGE_NAMES: Readonly<Record<string, string>> = { en: 'English', es: 'Español', fr: 'Français', pt: 'Português', ar: 'العربية', hi: 'हिन्दी', ur: 'اردو', id: 'Bahasa Indonesia' };

let wired = false;
let current: Settings | null = null;

function flash(id: string, text: string): void {
  const node = $(id);
  node.textContent = text;
  setTimeout(() => {
    if (node.textContent === text) node.textContent = '';
  }, 4000);
}

async function refresh(): Promise<void> {
  const loaded = await loadState();
  if (loaded) render(loaded);
}

function render(loaded: Loaded): void {
  const { state, t } = loaded;
  current = state.settings;
  applyI18n(document, t, state.locale, state.dir);
  document.title = t('opt_title');

  const modules = $('modules');
  modules.replaceChildren();
  for (const id of MODULE_IDS) {
    const row = el('label', undefined, 'switch');
    const box = el('input');
    box.type = 'checkbox';
    box.checked = state.settings.modules[id];
    box.addEventListener('change', () => {
      void send({ type: 'set-module', module: id, enabled: box.checked }).then(refresh);
    });
    const text = el('span');
    text.append(el('strong', t(`mod_${id}`)), el('small', t(`mod_${id}_desc`)));
    row.append(box, text);
    modules.append(row);
  }

  const ai = $<HTMLTextAreaElement>('ai-sites');
  if (document.activeElement !== ai) ai.value = state.settings.aiSites.join('\n');

  const list = $('trust-list');
  list.replaceChildren();
  if (state.settings.allowlist.length === 0) list.append(el('li', t('opt_trust_none'), 'hint'));
  for (const entry of state.settings.allowlist) {
    const item = el('li');
    const remove = el('button', t('btn_remove'));
    remove.type = 'button';
    remove.setAttribute('aria-label', `${t('btn_remove')}: ${entry.pattern}`);
    remove.addEventListener('click', () => {
      void send({ type: 'remove-trust', pattern: entry.pattern }).then(refresh);
    });
    const until = entry.expiresAt === null ? t('opt_trust_forever') : t('opt_trust_expires', { date: formatTime(entry.expiresAt, state.locale) });
    item.append(el('code', entry.pattern), el('span', ` — ${until} `), remove);
    list.append(item);
  }
  const duration = $<HTMLSelectElement>('trust-duration');
  if (duration.options.length === 0) {
    for (const key of Object.keys(TRUST_DURATIONS)) {
      const option = el('option');
      option.value = key;
      option.selected = key === 'month';
      duration.append(option);
    }
  }
  for (const option of duration.options) option.textContent = t(`dur_${option.value}`);

  const language = $<HTMLSelectElement>('language');
  language.replaceChildren();
  for (const code of LANGUAGE_CHOICES) {
    const option = el('option', code === 'auto' ? t('lang_auto') : (LANGUAGE_NAMES[code] ?? code));
    option.value = code;
    option.selected = state.settings.language === code;
    language.append(option);
  }
  $('mt-note').hidden = state.locale === 'en';
  $('stored-2').textContent = t('opt_stored_2', { count: HISTORY_CAP });
  $('version').textContent = t('opt_version', { version: state.version, engine: state.engineVersion });

  if (wired) return;
  wired = true;

  $('ai-save').addEventListener('click', () => {
    if (!current) return;
    const aiSites = ai.value.split(/[\n,]+/).map((line) => line.trim()).filter((line) => line !== '');
    void send({ type: 'set-settings', settings: { ...current, aiSites } }).then(async (r) => {
      ai.blur();
      await refresh();
      if (r) flash('ai-status', t('opt_saved'));
    });
  });
  $('ai-reset').addEventListener('click', () => {
    if (!current) return;
    void send({ type: 'set-settings', settings: { ...current, aiSites: [...DEFAULT_AI_SITES] } }).then(async () => {
      ai.blur();
      await refresh();
      flash('ai-status', t('opt_saved'));
    });
  });
  $<HTMLFormElement>('trust-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $<HTMLInputElement>('trust-input');
    void send<{ ok: boolean }>({ type: 'add-trust', pattern: input.value, duration: duration.value }).then(async (r) => {
      if (r && r.ok) {
        input.value = '';
        await refresh();
      } else {
        flash('trust-status', t('opt_trust_invalid'));
      }
    });
  });
  language.addEventListener('change', () => {
    if (!current) return;
    void send({ type: 'set-settings', settings: { ...current, language: language.value } }).then(refresh);
  });
  $('export').addEventListener('click', () => {
    if (!current) return;
    const blob = new Blob([exportSettings(current, Date.now())], { type: 'application/json' });
    const link = el('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'safetycatch-settings.json';
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
  });
  $<HTMLInputElement>('import').addEventListener('change', (e) => {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    if (file.size > MAX_IMPORT_CHARS) return flash('data-status', t('opt_import_bad'));
    void file
      .text()
      .then((json) => send<{ ok: boolean }>({ type: 'import-settings', json }))
      .then(async (r) => {
        if (r && r.ok) await refresh();
        flash('data-status', t(r && r.ok ? 'opt_import_ok' : 'opt_import_bad'));
      });
  });
}

async function main(): Promise<void> {
  const loaded = await loadState();
  if (!loaded) {
    $('load-error').textContent = chrome.i18n.getMessage('status_error');
    $('load-error').hidden = false;
    return;
  }
  render(loaded);
}

void main();
