// Copyright 2026 The ActionGuard Authors
// SPDX-License-Identifier: Apache-2.0

/** The six protections. Each can be switched off on its own. */
export const MODULE_IDS = ['pasteGuard', 'authFlow', 'lookalike', 'platformLure', 'aiPaste', 'downloads'] as const;

export type ModuleId = (typeof MODULE_IDS)[number];

export function isModuleId(value: unknown): value is ModuleId {
  return typeof value === 'string' && (MODULE_IDS as readonly string[]).includes(value);
}
