/**
 * Immutable provider quota-applicability metadata.
 *
 * Every binding has exactly ONE shape: an ordered, non-empty `pools` array.
 * Each pool maps one quota resource the model draws from:
 *
 *  - `quotaPoolId` is a unique, provider-scoped resource id;
 *  - `kind` is either `'quota'` (raw provider usage windows) or `'balance'`
 *    (a mandatory monetary balance resource);
 *  - a `quota` pool lists the raw window ids (`windowId`) that must be present
 *    to cover the model's reset cycles, together with evidence-backed
 *    `resetKind` semantics;
 *  - a `balance` pool carries no windows; its evidence is located on the raw
 *    Forge `balances` array of the same provider row.
 *
 * The raw provider row that supplies a pool is ALWAYS the owner `providerId`:
 * there is no separate quota-provider indirection, and pools never inherit
 * resources from another provider's row.
 *
 * A `quota` pool with no proven raw windows still appears with an empty window
 * list, so its coverage remains incomplete/unknown; consumers must never assume
 * an invented window, balance, reset timestamp or reset kind for it.
 *
 * Reset semantics:
 * - full_cycle:      quota resets on a full cycle boundary.
 * - rolling_partial: quota resets only partially inside a rolling interval.
 * - unproven:        reset semantics not yet established by evidence.
 *
 * `checkedAt` is provenance only: it records when the evidence below was
 * reviewed. It is never consulted at runtime as a freshness signal.
 *
 * This module has zero runtime dependencies and performs no I/O.
 */

import { BUILTIN_PROVIDERS } from './catalog.js';

export type QuotaResetKind = 'full_cycle' | 'rolling_partial' | 'unproven';

export type QuotaEvidenceKind = 'official_docs' | 'provider_parser';

/** A pool is either a raw usage-quota resource or a monetary balance. */
export type QuotaPoolKind = 'quota' | 'balance';

/** One raw usage window required to cover a model's reset cycles. */
export interface ProviderQuotaPoolWindow {
  readonly windowId: string;
  readonly resetKind: QuotaResetKind;
  readonly evidence: QuotaEvidenceKind;
  readonly evidenceRef: string;
  readonly checkedAt: string;
}

/** One quota resource (usage window set or monetary balance) a model draws from. */
export interface ProviderQuotaPool {
  readonly quotaPoolId: string;
  readonly kind: QuotaPoolKind;
  /** Raw usage windows for a `quota` pool; empty when no evidence exists yet. */
  readonly windows: readonly ProviderQuotaPoolWindow[];
  /** Raw Forge balance row id for a `balance` pool. */
  readonly balanceId?: string;
  readonly evidenceRef?: string;
  readonly checkedAt?: string;
}

export interface ProviderQuotaBinding {
  readonly providerId: string;
  readonly modelId: string;
  readonly pools: readonly ProviderQuotaPool[];
}

/** Builds one frozen usage window at module load. */
function quotaWindow(
  windowId: string,
  resetKind: QuotaResetKind,
  evidence: QuotaEvidenceKind,
  evidenceRef: string,
  checkedAt = '2026-09-08',
): ProviderQuotaPoolWindow {
  return Object.freeze({ windowId, resetKind, evidence, evidenceRef, checkedAt });
}

/** Builds one frozen usage-quota pool with a fresh frozen windows array. */
function quotaPool(
  quotaPoolId: string,
  windows: readonly ProviderQuotaPoolWindow[],
): ProviderQuotaPool {
  return Object.freeze({ quotaPoolId, kind: 'quota' as const, windows: Object.freeze(windows.slice()) });
}

/** Builds one frozen mandatory monetary-balance pool at module load. */
function balancePool(
  quotaPoolId: string,
  evidenceRef: string,
  checkedAt = '2026-09-08',
): ProviderQuotaPool {
  return Object.freeze({ quotaPoolId, kind: 'balance' as const, windows: Object.freeze([]), balanceId: quotaPoolId, evidenceRef, checkedAt });
}

/** Builds one frozen binding, guaranteeing a non-empty pools array. */
function binding(
  providerId: string,
  modelId: string,
  pools: readonly ProviderQuotaPool[],
): ProviderQuotaBinding {
  return Object.freeze({ providerId, modelId, pools: Object.freeze(pools.slice()) });
}

const CURSOR_DOCS = 'https://cursor.com/docs/models-and-pricing';
const CURSOR_PARSER = 'runtime/forge/internal/usage/quota/cursor.go';
const KIMI_DOCS = 'https://www.kimi.com/code/docs/en/kimi-code/membership.html';
const ZHIPU_DOCS = 'https://docs.bigmodel.cn/cn/coding-plan/overview';
const CODEX_PARSER = 'runtime/forge/internal/usage/quota/codex.go';
const DEEPSEEK_PARSER = 'runtime/forge/internal/usage/quota/deepseek.go';

const CURSOR_POOL = quotaPool('cursor/cursor', [
  quotaWindow('Cursor', 'full_cycle', 'official_docs', CURSOR_DOCS),
]);
const CURSOR_OTHER_POOL = quotaPool('cursor/other', [
  quotaWindow('Other', 'full_cycle', 'provider_parser', CURSOR_PARSER, '2026-09-10'),
]);
const CURSOR_CLAUDE_POOL = quotaPool('cursor/claude', [
  quotaWindow('Claude', 'full_cycle', 'provider_parser', CURSOR_PARSER, '2026-09-10'),
]);

const KIMI_5H_POOL = quotaPool('kimi-coding/5h', [
  quotaWindow('5h', 'rolling_partial', 'official_docs', KIMI_DOCS),
]);
const KIMI_7D_POOL = quotaPool('kimi-coding/7d', [
  quotaWindow('7d', 'full_cycle', 'official_docs', KIMI_DOCS),
]);

const ZHIPU_5H_POOL = quotaPool('zhipu-coding/5h', [
  quotaWindow('5h', 'rolling_partial', 'official_docs', ZHIPU_DOCS, '2026-09-09'),
]);
const ZHIPU_7D_POOL = quotaPool('zhipu-coding/7d', [
  quotaWindow('7d', 'full_cycle', 'official_docs', ZHIPU_DOCS, '2026-09-09'),
]);

const CHATGPT_5H_POOL = quotaPool('chatgpt/5h', [
  quotaWindow('5h', 'full_cycle', 'provider_parser', CODEX_PARSER, '2026-09-09'),
]);
const CHATGPT_7D_POOL = quotaPool('chatgpt/7d', [
  quotaWindow('7d', 'full_cycle', 'provider_parser', CODEX_PARSER, '2026-09-09'),
]);
const CHATGPT_SPARK_5H_POOL = quotaPool('chatgpt/spark-5h', [
  quotaWindow('spark-5h', 'full_cycle', 'provider_parser', CODEX_PARSER, '2026-09-09'),
]);
const CHATGPT_SPARK_7D_POOL = quotaPool('chatgpt/spark-7d', [
  quotaWindow('spark-7d', 'full_cycle', 'provider_parser', CODEX_PARSER, '2026-09-09'),
]);

/** Spark models consume the Spark-only pools; every other model the standard pools. */
const CHATGPT_SPARK_MODEL_ID = 'gpt-5.3-codex-spark';

const explicitBindings: ProviderQuotaBinding[] = [
  binding('cursor', 'cursor-grok-4.6-high', [CURSOR_POOL]),
  // K3 consumes the Other allowance, independently of the Cursor model pool.
  binding('cursor', 'kimi-k3', [CURSOR_OTHER_POOL]),
  binding('cursor', 'composer-2.5', [CURSOR_POOL]),
  binding('cursor', 'claude-opus-5', [CURSOR_CLAUDE_POOL]),
  binding('kimi-coding', 'k3', [KIMI_5H_POOL, KIMI_7D_POOL]),
  // HY models draw jointly on the HY family allowance and the account monthly allowance.
  // No raw window evidence has been reviewed: both pools stay empty/unknown.
  binding('codebuddy', 'hy3', [quotaPool('codebuddy/hy-family', []), quotaPool('codebuddy/monthly', [])]),
  binding('codebuddy', 'hy4-preview', [quotaPool('codebuddy/hy-family', []), quotaPool('codebuddy/monthly', [])]),
  // Remaining CodeBuddy models use the account monthly allowance only.
  ...BUILTIN_PROVIDERS.filter((provider) => provider.id === 'codebuddy').flatMap((provider) =>
    provider.models
      .filter((modelDefinition) => modelDefinition.id !== 'hy3' && modelDefinition.id !== 'hy4-preview')
      .map((modelDefinition) => binding('codebuddy', modelDefinition.id, [quotaPool('codebuddy/monthly', [])])),
  ),
  // Zhipu coding preserves the proven 5h rolling / 7d full-cycle resets.
  binding('zhipu-coding', 'glm-5.3', [ZHIPU_5H_POOL, ZHIPU_7D_POOL]),
  binding('zhipu-coding', 'glm-5.3-flash', [ZHIPU_5H_POOL, ZHIPU_7D_POOL]),
  // Official deepseek/deepseek-flash: no registered official provider exists in
  // the public catalog yet, so this explicit model binding carries ONLY a
  // mandatory monetary balance resource (`deepseek` raw row). It deliberately
  // inherits NO CodeBuddy or TokenHub balance: a missing/stale/unknown amount
  // keeps coverage incomplete rather than fabricating a balance.
  binding('deepseek', 'deepseek-flash', [balancePool('deepseek/balance', DEEPSEEK_PARSER)]),
];

/** Provider defaults also cover dynamically discovered models. */
function defaultPoolsFor(providerId: string, modelId = '*'): readonly ProviderQuotaPool[] {
  if (providerId === 'chatgpt') return modelId === CHATGPT_SPARK_MODEL_ID
    ? [CHATGPT_SPARK_5H_POOL, CHATGPT_SPARK_7D_POOL]
    : [CHATGPT_5H_POOL, CHATGPT_7D_POOL];
  if (providerId === 'kimi-coding') return [KIMI_5H_POOL, KIMI_7D_POOL];
  if (providerId === 'zhipu-coding') return [ZHIPU_5H_POOL, ZHIPU_7D_POOL];
  if (providerId === 'codebuddy') return [quotaPool('codebuddy/monthly', [])];
  if (['deepseek', 'anthropic-api', 'minimax', 'moonshot', 'openai', 'qwen', 'tokenhub', 'volcengine', 'zhipu'].includes(providerId)) {
    return [balancePool(`${providerId}/balance`, providerId === 'deepseek' ? DEEPSEEK_PARSER : '')];
  }
  return [quotaPool(`${providerId}/usage`, [])];
}

const catalogBindings = BUILTIN_PROVIDERS.flatMap((provider) => provider.models.map((model) =>
  explicitBindings.find((entry) => entry.providerId === provider.id && entry.modelId === model.id)
    ?? binding(provider.id, model.id, defaultPoolsFor(provider.id, model.id)),
));

/**
 * Provider-default bindings so a registered provider's model (including
 * discovered models not listed in the catalog) always resolves to at least one
 * own-provider pool. Never inherits another provider's resources.
 */
const providerDefaultBindings: ProviderQuotaBinding[] = BUILTIN_PROVIDERS.map((provider) =>
  binding(provider.id, '*', defaultPoolsFor(provider.id)),
);

export const PROVIDER_QUOTA_BINDINGS: readonly ProviderQuotaBinding[] = Object.freeze([
  ...catalogBindings,
  ...explicitBindings.filter((entry) => !catalogBindings.some((item) => item.providerId === entry.providerId && item.modelId === entry.modelId)),
  ...providerDefaultBindings,
]);

/** The exact binding for one provider+model pair, or undefined. */
function exactBinding(providerId: string, modelId: string): ProviderQuotaBinding | undefined {
  return PROVIDER_QUOTA_BINDINGS.find(
    (entry) => entry.providerId === providerId && entry.modelId === modelId,
  );
}

/** The provider-default binding for a provider, or undefined. */
function defaultBinding(providerId: string): ProviderQuotaBinding | undefined {
  return providerDefaultBindings.find((entry) => entry.providerId === providerId);
}

/**
 * Returns the quota binding for a provider model, or undefined when the
 * provider itself is unknown. A registered provider always gets a non-empty
 * binding: an exact catalog binding when one exists, otherwise that provider's
 * own-default pool.
 */
export function findProviderQuotaBinding(
  providerId: string,
  modelId: string,
): ProviderQuotaBinding | undefined {
  return exactBinding(providerId, modelId) ?? defaultBinding(providerId);
}
