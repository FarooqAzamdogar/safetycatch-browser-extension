// Copyright 2026 The SafetyCatch Authors
// SPDX-License-Identifier: Apache-2.0
//
// Constants that scripts/build.ts replaces at build time (esbuild `define`).

/**
 * True in content.js (injected into the top frame only), false in
 * content-frame.js (injected into every frame, does its work in sub-frames).
 * Code behind `if (__TOP_FRAME__)` is left out of the sub-frame script.
 */
declare const __TOP_FRAME__: boolean;
