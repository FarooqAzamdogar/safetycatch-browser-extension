// Copyright 2026 The SafetyCatch Authors
// SPDX-License-Identifier: Apache-2.0

/**
 * Cheap local pre-filters. They run in the content script (isolated world) so
 * that ordinary pages never wake the service worker. They are deliberately
 * generous: a "yes" only means "ask the engine", and the engine decides.
 * All patterns are linear-time (no nested unbounded quantifiers) and inputs
 * are capped before matching.
 */

import { clip, hasHidden } from './text.ts';

const MAX_SCAN = 20_000;

const SINGLE_URL_RE = /^https?:\/\/[^\s"'<>`|;&$(){}\\^]{1,2000}$/i;
/** Shell operators, UNC and drive paths, environment variables, option flags. */
const SHELL_CHARS_RE = /[|;`$<>^]|&&|\\\\|\b[a-z]:\\|%[a-z_][a-z0-9_]{1,40}%|\s-{1,2}[a-z]|\s\/[a-z]\b/i;
/** Program names that are rare in ordinary prose. */
const COMMAND_WORD_RE =
  /(?:^|[^a-z0-9])(?:powershell|pwsh|cmd|mshta|rundll32|regsvr32|certutil|bitsadmin|msiexec|wscript|cscript|conhost|forfiles|schtasks|wmic|curl|wget|bash|zsh|osascript|python3?|perl|iex|iwr|irm|invoke-[a-z]{3,20}|start-process|saps|explorer|nslookup|finger|tftp|base64|xattr|chmod|sudo|launchctl)(?:\.exe)?(?![a-z0-9])/i;
const BLOB_RE = /[A-Za-z0-9+/]{80}/;
const PADDING_RE = / {20}/;
const SCHEME_RE = /\b(?:file|search-ms|ms-[a-z]{2,20}|javascript|vbscript|data):/i;

/**
 * Does copied text need a real check? False only for text that is clearly not
 * a command: very short text, a single web link, or plain prose.
 */
export function needsCommandCheck(text: unknown): boolean {
  if (typeof text !== 'string') return false;
  const t = text.trim();
  if (t.length < 8) return false;
  if (t.length > MAX_SCAN) return true;
  if (SINGLE_URL_RE.test(t)) return false;
  return hasHidden(t) || SHELL_CHARS_RE.test(t) || COMMAND_WORD_RE.test(t) || BLOB_RE.test(t) || PADDING_RE.test(t) || SCHEME_RE.test(t);
}

const RUNNER_RE =
  /(?:^|[^a-z0-9])(?:powershell|pwsh|mshta|rundll32|regsvr32|certutil|bitsadmin|msiexec|wscript|cscript|conhost|cmd(?:\.exe)?\s+\/[ck]|curl|wget|iwr|irm|iex|invoke-(?:expression|webrequest|restmethod)|bash|osascript)(?![a-z0-9])/i;
const FETCH_OR_HIDE_RE = /https?:\/\/|\\\\[a-z0-9.-]{1,80}\\|\s-e(?:nc|ncodedcommand)?\s|\s-w(?:indowstyle)?\s+h|\|\s*(?:iex|sh|bash|zsh|cmd)\b|base64/i;

/**
 * Small local heuristic used ONLY when the engine cannot be reached: does the
 * text look like a command that fetches or hides something? It is no
 * replacement for the engine; it stops "make the check fail" from being a bypass.
 */
export function looksRunnable(text: unknown): boolean {
  if (typeof text !== 'string') return false;
  const t = clip(text, MAX_SCAN);
  return RUNNER_RE.test(t) && FETCH_OR_HIDE_RE.test(t);
}

const SECRET_HINT_RE = new RegExp(
  [
    '-----BEGIN [A-Z ]{0,30}PRIVATE KEY',
    '\\bA[KS]IA[0-9A-Z]{12}',
    '\\bgh[pousr]_[A-Za-z0-9]{20}',
    '\\bgithub_pat_',
    '\\bglpat-',
    '\\bsk-[A-Za-z0-9_-]{16}',
    '\\b[sr]k_live_',
    '\\bxox[abeprs]-',
    '\\bSG\\.[A-Za-z0-9_-]{10}',
    '\\bnpm_[A-Za-z0-9]{20}',
    '\\bpypi-',
    '\\bhf_[A-Za-z0-9]{20}',
    '\\bAIza[0-9A-Za-z_-]{20}',
    '\\beyJ[A-Za-z0-9_-]{10,2000}\\.',
    '[a-z][a-z0-9+.-]{1,20}:\\/\\/[^\\s:@/]{1,80}:[^\\s@/]{1,80}@',
    '(?:pass(?:word|wd)?|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret)\\w{0,20}["\']?\\s{0,3}[:=]',
    'AccountKey=',
    '\\b\\d{3}-\\d{2}-\\d{4}\\b',
    '\\b\\d{5}-\\d{7}-\\d\\b',
    '\\b(?:\\d[ -]?){12,19}\\b',
    '\\b[A-Z]{2}\\d{2} ?[A-Z0-9]{4} ?[A-Z0-9 ]{6,30}\\b',
    '\\b\\d{8,10}:[A-Za-z0-9_-]{30}',
    '\\b[MNO][A-Za-z0-9_-]{23,25}\\.[A-Za-z0-9_-]{6}\\.',
  ].join('|'),
  'i',
);
/** Twelve or more short lower-case words in a row: the shape of a wallet recovery phrase. */
const SEED_SHAPE_RE = /(?:\b[a-z]{3,8}\b[ \t\r\n]{1,3}){11}[a-z]{3,8}\b/;

/** Might this pasted text hold a password, key, token or ID number? (The engine decides.) */
export function mightHoldSecret(text: unknown): boolean {
  if (typeof text !== 'string') return false;
  if (text.trim().length < 8) return false;
  if (text.length > 50_000) return true;
  return SECRET_HINT_RE.test(text) || SEED_SHAPE_RE.test(text);
}

const AUTH_HOST_RE =
  /^(?:(?:www\.)?microsoft\.com|aka\.ms|login\.microsoftonline\.com|login\.microsoft\.com|login\.live\.com|github\.com|(?:www\.|accounts\.)?google\.com|device\.sso\.[a-z0-9-]{2,30}\.amazonaws\.com|[a-z0-9-]{1,63}\.awsapps\.com|[a-z0-9-]{1,63}\.okta(?:preview)?\.com|[a-z0-9-]{1,63}(?:\.[a-z]{2})?\.auth0\.com|slack\.com|(?:www\.)?dropbox\.com|discord\.com)$/;
const AUTH_PATH_RE = /devicelogin|^\/link(?:\/|$)|deviceauth|remoteconnect|\/login\/device|^\/device(?:\/|$)|^\/activate|^\/start|oauth|authorize|adminconsent/;

/** Could this address be a device-code or app-approval (OAuth) page? The engine decides. */
export function isAuthUrlCandidate(url: unknown): boolean {
  if (typeof url !== 'string' || url.length > 8000) return false;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  const host = u.hostname.toLowerCase();
  if (!AUTH_HOST_RE.test(host)) return false;
  return host.startsWith('device.sso.') || AUTH_PATH_RE.test(u.pathname.toLowerCase());
}

const INSTRUCTION_HINT_RE =
  /win(?:dows)?\s*(?:key\s*)?\+\s*[rx]\b|ctrl\s*\+\s*v|cmd\s*\+\s*(?:v|space)|⌘|powershell|terminal|command prompt|run (?:dialog|box)|paste|download|install|\bcurl\b|copy (?:the|this|and)|pega[r ]|descarg|télécharg|coller|colar|baix[ae]|tempel|unduh|einfügen|herunterladen|yapıştır|встав|скача|الصق|تحميل|डाउनलोड|पेस्ट/i;

/** Does page text mention pasting, running or downloading at all? Used only on publish-anything platforms. */
export function hasInstructionHint(text: unknown): boolean {
  return typeof text === 'string' && INSTRUCTION_HINT_RE.test(clip(text, MAX_SCAN));
}

const DOWNLOAD_STEP_RE =
  /\b(?:download|install)\b[^.!?\n]{0,120}\b(?:run|open|launch|execute|double[- ]click)\b|\b(?:run|open|launch|execute|double[- ]click)\b[^.!?\n]{0,80}(?:\bdownloaded\b|\binstaller\b|\bsetup file\b|\.exe\b|\.msi\b|\.dmg\b|\.pkg\b|\.apk\b|\.zip\b)/i;

/**
 * "Download this and run it" instructions (English only). The engine's page
 * analyzer covers paste-and-run steps but not download-and-run steps, so the
 * trusted-platform notice uses this small extra check.
 */
export function hasDownloadStep(text: unknown): boolean {
  return typeof text === 'string' && DOWNLOAD_STEP_RE.test(clip(text, MAX_SCAN));
}
