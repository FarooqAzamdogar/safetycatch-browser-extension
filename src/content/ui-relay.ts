// Copyright 2026 The SafetyCatch Authors
// SPDX-License-Identifier: Apache-2.0

/**
 * The warning "UI" of the sub-frame script. A sub-frame draws nothing itself:
 * it asks the service worker to show the warning in the top frame of the tab,
 * where there is room for it and where the full UI code is already loaded, and
 * gets back the button the person pressed. This keeps the script that runs in
 * every frame (ad and widget frames included) small.
 *
 * If the top frame cannot be reached (for example the top page is not a web
 * page) or gives no answer, the warning counts as dismissed: the guarded action
 * does not happen (a held-back paste is not inserted).
 */

import { BUTTON_IDS, type ButtonId, type WarningModel } from '../shared/model.ts';
import type { ModalHandle, Ui } from './ui.ts';

export function createRelayUi(askTop: (model: WarningModel) => Promise<unknown>, showTop: (model: WarningModel) => void): Ui {
  return {
    owns: () => false,
    modal(model, onButton) {
      let open = true;
      const handle: ModalHandle = {
        setCleared: () => undefined,
        close: () => {
          open = false;
        },
        isOpen: () => open,
      };
      void askTop(model).then((id) => {
        if (!open) return;
        onButton((BUTTON_IDS as readonly unknown[]).includes(id) ? (id as ButtonId) : 'cancel', handle);
      });
      return handle;
    },
    banner(model) {
      showTop(model);
    },
    modalOpen: () => false,
    reattach: () => undefined,
  };
}
