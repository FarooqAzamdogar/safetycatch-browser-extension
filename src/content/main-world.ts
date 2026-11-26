// Copyright 2026 The SafetyCatch Authors
// SPDX-License-Identifier: Apache-2.0
//
// Entry point of the MAIN-world content script (document_start, all frames).

import { installHooks } from './main-hooks.ts';

try {
  installHooks(window);
} catch {
  // Never break a page. Without hooks the content script still watches copy events.
}
