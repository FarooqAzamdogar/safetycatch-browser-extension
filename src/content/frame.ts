// Copyright 2026 The SafetyCatch Authors
// SPDX-License-Identifier: Apache-2.0

/**
 * Entry point of content-frame.js (isolated world, document_start, every
 * frame): the copy, paste and AI-paste guards without the warning UI and the
 * top-frame checks. Its warnings are shown by the top frame (ui-relay.ts). It
 * is also injected into the top frame, where it stays idle (see isolated.ts).
 */

import './isolated.ts';
