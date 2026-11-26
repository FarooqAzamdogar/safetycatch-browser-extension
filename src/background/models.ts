// Copyright 2026 The SafetyCatch Authors
// SPDX-License-Identifier: Apache-2.0

/**
 * Builds the wording of every warning (the "view model") from engine verdicts
 * and the extension's message catalog. Pure functions: given the same verdict
 * and translator they return the same model. Plain language throughout: what
 * happened, why it is risky, what to do next.
 */

import type { Verdict } from 'safetycatch-engine';
import type { PasteSource } from '../shared/decisions.ts';
import type { Translate } from '../shared/i18n.ts';
import { maxOf, rank, type RiskLevel } from '../shared/levels.ts';
import type { ModelSection, WarningModel } from '../shared/model.ts';
import type { ModuleId } from '../shared/modules.ts';
import type { Arrival } from '../shared/navchain.ts';
import { groupScopes, parseScopes } from '../shared/scopes.ts';
import { displaySample } from '../shared/text.ts';

export interface ModelContext {
  t: Translate;
  lang: string;
  dir: 'ltr' | 'rtl';
  /** Translated name of a level ("High risk"). */
  levelLabel(level: RiskLevel): string;
  /** Translated plain-language title of an engine scope category (`mail-send`), if the engine has one. */
  scopeTitle(category: string): string | undefined;
}

const MAX_RULE_IDS = 8;

function ruleIdsOf(...verdicts: Array<Verdict | null | undefined>): string[] {
  const out: string[] = [];
  for (const v of verdicts) for (const f of v?.findings ?? []) if (!out.includes(f.ruleId) && out.length < MAX_RULE_IDS) out.push(f.ruleId);
  return out;
}

/** Top findings as "Headline. What we saw and why it matters." */
function reasons(v: Verdict | null | undefined, max: number, skip: readonly string[] = []): string[] {
  const out: string[] = [];
  for (const f of v?.findings ?? []) {
    if (skip.includes(f.ruleId) || rank(f.severity) < rank('low')) continue;
    const title = f.title.trim();
    out.push(/[.!?]$/.test(title) ? `${title} ${f.detail}` : `${title}. ${f.detail}`);
    if (out.length >= max) break;
  }
  return out;
}

function base(c: ModelContext, module: ModuleId, level: RiskLevel, label?: string): Pick<WarningModel, 'module' | 'level' | 'levelLabel' | 'lang' | 'dir' | 'brand'> {
  return { module, level, levelLabel: label ?? c.levelLabel(level), lang: c.lang, dir: c.dir, brand: c.t('brand') };
}

function friction(c: ModelContext): NonNullable<WarningModel['friction']> {
  const word = c.t('confirm_word');
  return { hint: c.t('hold_hint'), typeLabel: c.t('type_label', { word }), word, covered: c.t('covered_warning') };
}

function sections(...list: Array<ModelSection | null>): ModelSection[] {
  return list.filter((s): s is ModelSection => s !== null && s.items.length > 0);
}

export interface PasteInfo {
  site: string;
  text: string;
  source: PasteSource;
  command: Verdict | null;
  page: Verdict | null;
  /** The engine could not be used; the block rests on the local "looks like a command" check. */
  unchecked: boolean;
}

/** Full-page warning after a copied command was neutralised. */
export function pasteBlockModel(c: ModelContext, info: PasteInfo): WarningModel {
  const noText = info.text === '';
  const level = info.unchecked ? 'medium' : maxOf('high', info.command?.level ?? 'safe', info.page?.level ?? 'safe');
  const title = info.unchecked ? 'paste_unchecked_title' : noText ? 'paste_tamper_title' : info.source === 'selection' ? 'paste_title_selection' : 'paste_title_hidden';
  const lead = info.unchecked ? 'paste_unchecked_lead' : noText ? 'paste_tamper_lead' : info.source === 'selection' ? 'paste_lead_selection' : 'paste_lead_hidden';
  const sample = displaySample(info.text);
  const advice = [...(info.command?.advice ?? []), ...(info.page?.advice ?? [])].filter((a, i, all) => all.indexOf(a) === i).slice(0, 4);
  const model: WarningModel = {
    ...base(c, 'pasteGuard', level, info.unchecked ? c.t('level_unknown') : undefined),
    kind: 'paste-block',
    layout: 'page',
    title: c.t(title),
    lead: [c.t(lead, { site: info.site })],
    cleared: c.t('paste_cleared'),
    notCleared: c.t('paste_not_cleared'),
    sections: sections(
      { title: c.t('why_title'), items: [c.t('paste_never'), ...reasons(info.command, 3), ...reasons(info.page, 2, ['page.ugc-host'])].slice(0, 5) },
      { title: c.t('what_to_do'), items: advice },
    ),
    buttons: [
      { id: 'keep', label: c.t('paste_keep'), style: 'primary' },
      { id: 'clear', label: c.t('paste_clear_now'), style: 'secondary' },
    ],
    ruleIds: ruleIdsOf(info.command, info.page),
  };
  if (!noText) {
    model.sample = { title: c.t('paste_sample_title'), text: sample.text, more: sample.hiddenChars > 0 ? c.t('paste_more_chars', { count: sample.hiddenChars }) : '' };
    model.buttons.push({ id: 'restore', label: c.t('paste_restore_hold'), style: 'hold' });
    model.friction = friction(c);
  }
  return model;
}

/** Banner for a risky command the person copied themselves on a page without other warning signs. */
export function pasteNoticeModel(c: ModelContext, info: PasteInfo): WarningModel {
  return {
    ...base(c, 'pasteGuard', info.command?.level ?? 'medium'),
    kind: 'paste-notice',
    layout: 'banner',
    title: c.t('paste_notice_title'),
    lead: [c.t('paste_notice_text', { site: info.site })],
    sections: sections({ title: '', items: reasons(info.command, 2) }),
    buttons: [{ id: 'ok', label: c.t('btn_got_it'), style: 'primary' }],
    ruleIds: ruleIdsOf(info.command),
  };
}

/** Neutral "could not check" banner. Never says "safe". */
export function uncheckedModel(c: ModelContext): WarningModel {
  return {
    ...base(c, 'pasteGuard', 'medium', c.t('level_unknown')),
    kind: 'unchecked',
    layout: 'banner',
    title: c.t('unchecked_title'),
    lead: [c.t('unchecked_text')],
    sections: [],
    buttons: [{ id: 'ok', label: c.t('btn_got_it'), style: 'primary' }],
    ruleIds: [],
  };
}

export interface LoginInfo {
  site: string;
  verdict: Verdict;
  brand: string | undefined;
  /** The brand's real address, when known. */
  official: string | undefined;
}

function loginLead(c: ModelContext, info: LoginInfo): string[] {
  const lead = [info.brand ? c.t('login_lead_brand', { brand: info.brand, site: info.site }) : c.t('login_lead', { site: info.site })];
  if (info.brand && info.official) lead.push(c.t('login_real', { brand: info.brand, official: info.official }));
  return lead;
}

/** Full-page warning shown when the person goes to type a password on a look-alike page. */
export function loginModel(c: ModelContext, info: LoginInfo): WarningModel {
  return {
    ...base(c, 'lookalike', maxOf('high', info.verdict.level)),
    kind: 'login',
    layout: 'page',
    title: info.brand ? c.t('login_title_brand', { brand: info.brand }) : c.t('login_title'),
    lead: [...loginLead(c, info), c.t('login_never')],
    sections: sections({ title: c.t('why_title'), items: reasons(info.verdict, 3) }, { title: c.t('what_to_do'), items: info.verdict.advice.slice(0, 4) }),
    buttons: [
      { id: 'leave', label: c.t('btn_leave'), style: 'primary' },
      { id: 'stay', label: c.t('login_stay_hold'), style: 'hold' },
    ],
    friction: friction(c),
    ruleIds: ruleIdsOf(info.verdict),
  };
}

/** Banner shown as soon as a suspicious sign-in page is recognised. */
export function loginBannerModel(c: ModelContext, info: LoginInfo, strong: boolean): WarningModel {
  return {
    ...base(c, 'lookalike', strong ? maxOf('high', info.verdict.level) : info.verdict.level),
    kind: 'login-banner',
    layout: 'banner',
    title: strong ? (info.brand ? c.t('login_title_brand', { brand: info.brand }) : c.t('login_title')) : c.t('login_medium_title'),
    lead: strong ? [...loginLead(c, info), c.t('login_banner_text')] : [c.t('login_banner_text')],
    sections: strong ? [] : sections({ title: '', items: reasons(info.verdict, 2) }),
    buttons: [{ id: 'ok', label: c.t('btn_got_it'), style: 'primary' }],
    ruleIds: ruleIdsOf(info.verdict),
  };
}

export interface AuthInfo {
  verdict: Verdict;
  flow: 'device-code' | 'oauth-consent' | 'admin-consent';
  provider: string;
  /** Level to show (may be raised by how the person arrived). */
  level: RiskLevel;
  blocking: boolean;
  arrival: Arrival;
  raised: boolean;
  /** Host of the page that sent the person here, when it made the verdict worse. */
  from: string;
}

/** Plain-language list of what an app asks for. */
export function scopeLines(c: ModelContext, meta: unknown): string[] {
  const lines: string[] = [];
  for (const g of groupScopes(parseScopes(meta))) {
    const names = g.scopes.slice(0, 6).join(', ');
    if (g.category === 'basic') lines.push(`${c.t('scope_basic')} (${names})`);
    else if (g.category === 'other') lines.push(c.t('scope_other', { scopes: names }));
    else lines.push(`${c.scopeTitle(g.category) ?? c.t('scope_other', { scopes: names })} (${names})`);
    if (lines.length >= 8) break;
  }
  return lines;
}

/** Device-code and app-approval (OAuth consent) pages: banner at medium, full page at high and above. */
export function authModel(c: ModelContext, info: AuthInfo): WarningModel {
  const device = info.flow === 'device-code';
  const lead = [device ? c.t('device_lead', { provider: info.provider }) : c.t('oauth_lead')];
  if (info.from) lead.push(c.t('arrival_site', { site: info.from }));
  else if (info.raised || info.arrival === 'external') lead.push(c.t('arrival_external'));
  const skip = ['auth.device-code', 'auth.oauth.consent'];
  const asks = device ? [] : scopeLines(c, info.verdict.meta?.['scopes']);
  const advice = info.verdict.advice.slice(0, 3);
  const model: WarningModel = {
    ...base(c, 'authFlow', info.level),
    kind: info.blocking ? 'auth' : 'auth-banner',
    layout: info.blocking ? 'page' : 'banner',
    title: device ? c.t('device_title') : c.t('oauth_title', { provider: info.provider }),
    lead,
    sections: info.blocking
      ? sections(
          asks.length > 0 ? { title: c.t('oauth_asks'), items: asks } : null,
          { title: c.t('what_to_do'), items: device ? [c.t('device_rule'), ...advice].slice(0, 4) : advice },
          { title: c.t('why_title'), items: reasons(info.verdict, 3, skip) },
        )
      : sections({ title: '', items: device ? [c.t('device_rule')] : asks.slice(0, 4) }),
    buttons: info.blocking
      ? [
          { id: 'leave', label: c.t('btn_leave'), style: 'primary' },
          { id: 'continue', label: c.t(device ? 'device_continue_hold' : 'oauth_continue_hold'), style: 'hold' },
        ]
      : [{ id: 'ok', label: c.t('btn_got_it'), style: 'primary' }],
    ruleIds: ruleIdsOf(info.verdict),
  };
  if (info.blocking) model.friction = friction(c);
  return model;
}

/** Notice on a publish-anything platform that shows paste or download instructions. */
export function lureModel(c: ModelContext, platform: string, page: Verdict | null, strong: boolean): WarningModel {
  return {
    ...base(c, 'platformLure', strong ? maxOf('high', page?.level ?? 'high') : 'low'),
    kind: 'lure',
    layout: 'banner',
    title: c.t(strong ? 'lure_title_strong' : 'lure_title'),
    lead: [c.t('lure_text'), c.t('lure_where', { platform })],
    sections: strong ? sections({ title: '', items: reasons(page, 2, ['page.ugc-host']) }) : [],
    buttons: [{ id: 'ok', label: c.t('btn_got_it'), style: 'primary' }],
    ruleIds: ruleIdsOf(page),
  };
}

/** Dialog shown before text with secrets goes into an AI chat. Shows masked evidence only, never the secret. */
export function aiPasteModel(c: ModelContext, verdict: Verdict): WarningModel {
  const counts = (typeof verdict.meta?.['counts'] === 'object' && verdict.meta['counts'] !== null ? verdict.meta['counts'] : {}) as Record<string, unknown>;
  const total = Object.values(counts).reduce<number>((n, v) => n + (typeof v === 'number' ? v : 0), 0);
  const items = verdict.findings.slice(0, 6).map((f) => (f.evidence ? `${f.title}: ${f.evidence}` : f.title));
  return {
    ...base(c, 'aiPaste', verdict.level),
    kind: 'ai-paste',
    layout: 'dialog',
    title: c.t('ai_title'),
    lead: [c.t('ai_lead', { count: total > 0 ? total : verdict.findings.length }), c.t('ai_note')],
    sections: sections({ title: c.t('ai_found'), items }),
    buttons: [
      { id: 'redact', label: c.t('ai_redact'), style: 'primary' },
      { id: 'cancel', label: c.t('btn_cancel'), style: 'secondary' },
      { id: 'anyway', label: c.t('ai_anyway_hold'), style: 'hold' },
    ],
    friction: friction(c),
    ruleIds: ruleIdsOf(verdict),
  };
}

export function aiUncheckedModel(c: ModelContext): WarningModel {
  return {
    ...base(c, 'aiPaste', 'medium', c.t('level_unknown')),
    kind: 'ai-unchecked',
    layout: 'dialog',
    title: c.t('ai_unchecked_title'),
    lead: [c.t('ai_unchecked_text')],
    sections: [],
    buttons: [
      { id: 'cancel', label: c.t('btn_cancel'), style: 'primary' },
      { id: 'paste', label: c.t('ai_paste'), style: 'secondary' },
    ],
    ruleIds: [],
  };
}

/** The question shown in the download prompt window. */
export function downloadModel(c: ModelContext, name: string, site: string, verdict: Verdict, finished: boolean): WarningModel {
  const shown = displaySample(name, 120, 1).text;
  return {
    ...base(c, 'downloads', maxOf('high', verdict.level)),
    kind: 'download',
    layout: 'page',
    title: c.t('dl_title'),
    lead: [c.t('dl_lead', { file: shown, site: site || '?' }), c.t(finished ? 'dl_finished' : 'dl_paused')],
    sections: sections({ title: c.t('why_title'), items: reasons(verdict, 4) }, { title: c.t('what_to_do'), items: verdict.advice.slice(0, 3) }),
    buttons: finished
      ? [
          { id: 'delete', label: c.t('dl_delete'), style: 'primary' },
          { id: 'keep', label: c.t('dl_keep_hold'), style: 'hold' },
        ]
      : [
          { id: 'cancel', label: c.t('dl_cancel'), style: 'primary' },
          { id: 'resume', label: c.t('dl_resume_hold'), style: 'hold' },
        ],
    friction: friction(c),
    ruleIds: ruleIdsOf(verdict),
  };
}
