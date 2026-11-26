// Copyright 2026 The SafetyCatch Authors
// SPDX-License-Identifier: Apache-2.0
//
// Download prompt window: "this download looks risky". The default is to
// cancel (or delete); continuing needs press-and-hold. Reuses the warning UI
// that is shown inside web pages.

import { createUi } from '../content/ui.ts';
import { parseModel } from '../shared/model.ts';
import type { DownloadChoice } from '../shared/protocol.ts';
import { send } from './common.ts';

interface Info {
  ok: boolean;
  model?: unknown;
  messages?: Record<string, string>;
  dir?: string;
  lang?: string;
}

const CHOICES: Readonly<Record<string, DownloadChoice>> = { cancel: 'cancel', resume: 'resume', delete: 'delete', keep: 'keep' };
const DONE: Readonly<Record<DownloadChoice, string>> = { cancel: 'cancelled', resume: 'resumed', delete: 'deleted', keep: 'kept' };

function finish(text: string): void {
  const done = document.getElementById('done') as HTMLElement;
  done.textContent = text;
  done.hidden = false;
  const close = document.getElementById('close') as HTMLButtonElement;
  close.hidden = false;
  close.focus();
}

async function main(): Promise<void> {
  const close = document.getElementById('close') as HTMLButtonElement;
  close.textContent = chrome.i18n.getMessage('btn_close') || 'Close';
  close.addEventListener('click', () => window.close());
  const id = Number(new URLSearchParams(location.search).get('id'));
  const info = Number.isInteger(id) ? await send<Info>({ type: 'download-info', id }) : null;
  const messages = info?.messages ?? {};
  if (info?.lang) document.documentElement.lang = info.lang;
  if (info?.dir === 'rtl') document.documentElement.dir = 'rtl';
  if (messages['title']) document.title = messages['title'];
  const model = info && info.ok ? parseModel(info.model) : null;
  if (!info || !model) return finish(messages['gone'] ?? chrome.i18n.getMessage('dl_gone'));
  const ui = createUi(window, document);
  ui.modal(model, (button, handle) => {
    const choice = CHOICES[button];
    if (!choice) return;
    void send<{ ok: boolean }>({ type: 'download-choice', id, choice }).then((r) => {
      handle.close();
      finish(r && r.ok ? (messages[DONE[choice]] ?? '') : (messages['gone'] ?? ''));
    });
  });
}

void main();
