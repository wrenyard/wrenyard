/** Projects current daemon route metadata; a defective row never breaks the list. */
import { REASONING_EFFORTS, isMainstreamModelId } from '@wrenyard/models';
import type { WrenyardGatewayModel } from '@wrenyard/control';
import type { ProviderListResult, ProviderQuotaBalance, ProviderQuotaSnapshot } from '@wrenyard/protocol/provider';
import { selectChatGptFundingSource } from '@wrenyard/providers/chatgpt';
import { selectSessionProtocol } from '@wrenyard/session/model-metadata';
import { floorQuotaPercentage } from '../pet/shared/quota-percentage.js';
import { floorDecimalInteger, twoDecimalAmount } from '../main/projections/quota-service.js';
import type { SessionBridgeModelEntry } from './preload.js';

/** Short label for one balance row: a unit row keeps its unit (e.g. Credits). */
function balanceSummary(balance: ProviderQuotaBalance): string | undefined {
  const unit = balance.unit ?? balance.currency;
  if (unit === undefined) return undefined;
  if (balance.unlimited === true) return `不限量 ${unit}`;
  const amount = balance.amount;
  // Unknown Credits render as unknown, never as a fabricated paid amount.
  if (amount === null) return `${unit}未知`;
  if (balance.unit !== undefined) return `${floorDecimalInteger(amount)} ${unit}`;
  // Human-facing USD/CNY amounts show exactly two decimals (zero-padded,
  // ordinarily rounded); other currencies keep the provider's precision.
  const displayAmount = unit === 'USD' || unit === 'CNY' ? twoDecimalAmount(amount) : amount;
  return `${displayAmount} ${unit}`;
}

/**
 * One provider group's quota summary. ChatGPT applies the shared
 * subscription-first funding rule: any confirmed-exhausted applicable
 * subscription window hands the compact summary to a fresh positive/unlimited
 * Credits balance, while an unknown balance renders as unknown (never paid)
 * and stale or missing subscription evidence alone never selects Credits.
 * Other providers keep their historical balance-first order. A failed or
 * unavailable read is unknown, never a zero balance.
 */
function providerQuotaSummary(row: ProviderQuotaSnapshot | undefined): string | undefined {
  if (row === undefined) return undefined;
  if (row.status === 'error' || row.status === 'unavailable') return '用量未知';
  const balance = row.balances?.[0];
  const windows = row.windows ?? [];
  if (row.provider === 'chatgpt' && windows.length > 0) {
    const notApplicable = new Set(row.not_applicable_windows ?? []);
    // Stale observations never confirm exhaustion: unknown/stale subscription
    // data alone keeps the subscription summary rather than switching to paid.
    const applicable = row.stale === true ? [] : windows.filter((window) => !notApplicable.has(window.name));
    const subscriptionExhausted = applicable.some((window) => 100 - window.pct <= 0);
    const balanceKnown = row.stale !== true
      && balance !== undefined && (balance.unlimited === true || balance.amount !== null);
    const credits = !balanceKnown ? 'unknown' as const
      : balance!.unlimited === true || (balance!.amount !== null && /[1-9]/.test(balance!.amount))
        ? 'available' as const
        : 'empty' as const;
    const source = selectChatGptFundingSource({ subscriptionExhausted, credits });
    if (source === 'credits') return balanceSummary(balance!);
    if (source === 'unresolved') return '用量未知';
    const remaining = windows.map((window) => 100 - window.pct);
    return `${floorQuotaPercentage(Math.min(...remaining))}%`;
  }
  if (balance !== undefined) return balanceSummary(balance) ?? '用量未知';
  if (windows.length > 0) {
    const tightest = Math.min(...windows.map((window) => 100 - window.pct));
    return `${floorQuotaPercentage(tightest)}%`;
  }
  return '用量未知';
}

export function toModelEntries(
  result: ProviderListResult,
  gatewayModels: readonly WrenyardGatewayModel[],
  warn: (message: string) => void = console.warn,
  quotaRows?: readonly ProviderQuotaSnapshot[],
): SessionBridgeModelEntry[] {
  // Index the Gateway directory by both the public id and `provider/model`, so
  // the model's protocols come from the Gateway model row, never the Provider.
  const gatewayByPublicId = new Map<string, WrenyardGatewayModel>();
  for (const model of gatewayModels) {
    gatewayByPublicId.set(model.publicId, model);
    gatewayByPublicId.set(`${model.provider}/${model.id}`, model);
  }
  const quotaByProvider = new Map<string, ProviderQuotaSnapshot>();
  for (const row of quotaRows ?? []) quotaByProvider.set(row.provider, row);
  const entries = new Map<string, SessionBridgeModelEntry>();
  for (const provider of result.providers) {
    if (!provider.configured) continue;
    const quotaProvider = provider.quotaProvider ?? provider.id;
    const summary = providerQuotaSummary(
      quotaByProvider.get(quotaProvider) ?? quotaByProvider.get(provider.id),
    );
    for (const model of provider.models) {
      const publicId = `${provider.id}/${model.id}`;
      // Session inference uses the credential-backed Gateway, not Task client admission.
      if (model.taskOnly === true
        || (model.supportedClients?.length ?? 0) > 0 || entries.has(publicId)) continue;
      // Admission is universal: the picker shows exactly the mainstream
      // registered identities. There is no provider-specific exception and no
      // unknown-intelligence fallback — SWE-2 appears only because its
      // registered identity is mainstream.
      if (!isMainstreamModelId(model.id)) continue;
      const gatewayModel = gatewayByPublicId.get(publicId);
      if (gatewayModel === undefined) continue;
      const runtime = selectSessionProtocol(gatewayModel.protocols);
      if (!runtime) continue;
      // A route that declares no ladder — a CodeBuddy endpoint row naming no
      // registered model — has UNKNOWN efforts, not invalid ones, so it is still
      // selectable and is emitted with no effort levels. Only a ladder that is
      // present but malformed is treated as a defect and dropped.
      const efforts = Array.isArray(model.reasoningEfforts) ? model.reasoningEfforts : [];
      if (efforts.some(effort => !REASONING_EFFORTS.includes(effort))
        || new Set(efforts).size !== efforts.length) {
        warn(`Catalog model has invalid reasoning efforts: ${publicId}`);
        continue;
      }
      entries.set(publicId, {
        publicId,
        provider: provider.id,
        providerDisplayName: provider.displayName,
        model: model.id,
        displayName: model.displayName,
        runtime,
        reasoningEfforts: [...efforts],
        ...(gatewayModel.capabilities === undefined ? {} : { capabilities: gatewayModel.capabilities }),
        quotaProvider: provider.quotaProvider ?? provider.id,
        ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
        ...(model.maxTokens === undefined ? {} : { maxOutputTokens: model.maxTokens }),
        ...(model.free === undefined ? {} : { free: model.free }),
        ...(model.effectiveTps === undefined ? {} : { effectiveTps: model.effectiveTps }),
        ...(model.quotaState === undefined ? {} : { quotaState: model.quotaState }),
        ...(model.quotaEvidence === undefined ? {} : { quotaEvidence: model.quotaEvidence }),
        ...(summary === undefined ? {} : { providerQuotaSummary: summary }),
        // Route health comes from the Gateway row, which already scopes a fault
        // to its own route/provider/pool — a zero paid balance never marks a free
        // pool. The row is still emitted while faulted so a selected model that
        // became unavailable can still be named and explained.
        ...(gatewayModel.routeState === undefined ? {} : { routeState: gatewayModel.routeState }),
        ...(gatewayModel.routePhase === undefined ? {} : { routePhase: gatewayModel.routePhase }),
        ...(gatewayModel.routeUntil === undefined ? {} : { routeUntil: gatewayModel.routeUntil }),
        ...(gatewayModel.supportsFast === true ? { supportsFast: true } : {}),
        // Intelligence tier likewise comes from the Gateway row's catalog data;
        // it is omitted when the catalog genuinely does not know.
        ...(gatewayModel.intelligence === undefined ? {} : { intelligence: gatewayModel.intelligence }),
      });
    }
  }
  return [...entries.values()];
}
