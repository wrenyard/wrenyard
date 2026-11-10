/** Projects current daemon route metadata; a defective row never breaks the list. */
import { REASONING_EFFORTS } from '@wrenyard/models';
import type { WrenyardGatewayModel } from '@wrenyard/control';
import type { ProviderListResult, ProviderQuotaBalance, ProviderQuotaSnapshot } from '@wrenyard/protocol/provider';
import { chatGptFundingSourceFromSnapshot } from '@wrenyard/providers/chatgpt';
import { formatBalanceAmount } from '@wrenyard/auto-routing';
import { selectSessionProtocol } from '@wrenyard/model-call/metadata';
import { floorQuotaPercentage } from '../pet/shared/quota-percentage.js';
import type { SessionBridgeModelEntry } from './preload.js';

/** Short label for one balance row: a unit row keeps its unit (e.g. Credits). */
function balanceSummary(balance: ProviderQuotaBalance): string | undefined {
  const unit = balance.unit ?? balance.currency;
  if (unit === undefined) return undefined;
  if (balance.unlimited === true) return `不限量 ${unit}`;
  const amount = balance.amount;
  // Unknown Credits render as unknown, never as a fabricated paid amount.
  if (amount === null) return `${unit}未知`;
  return `${formatBalanceAmount(amount, unit)} ${unit}`;
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
    const source = chatGptFundingSourceFromSnapshot({
      stale: row.stale,
      windows: windows.map((window) => ({ name: window.name, remainingPct: 100 - window.pct })),
      notApplicableWindows: row.not_applicable_windows,
      creditsBalance: balance,
    });
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
  // The endpoint list is the only model directory: each row is emitted once, in
  // connection order. The provider list still supplies the display label and
  // display-only facts (free supply, TPS, quota); it never decides membership.
  const providerByID = new Map(result.providers.map((provider) => [provider.id, provider]));
  const catalogByPublicId = new Map<string, ProviderListResult['providers'][number]['models'][number]>();
  for (const provider of result.providers) {
    for (const model of provider.models) catalogByPublicId.set(`${provider.id}/${model.id}`, model);
  }
  const quotaByProvider = new Map<string, ProviderQuotaSnapshot>();
  for (const row of quotaRows ?? []) quotaByProvider.set(row.provider, row);
  const entries: SessionBridgeModelEntry[] = [];
  const seen = new Set<string>();
  for (const gatewayModel of gatewayModels) {
    const publicId = gatewayModel.publicId;
    if (seen.has(publicId)) continue;
    const runtime = selectSessionProtocol(gatewayModel.protocols);
    if (!runtime) continue;
    // A route that declares no ladder has UNKNOWN efforts, not invalid ones, so
    // it is still selectable and is emitted with no effort levels. Only a ladder
    // that is present but malformed is treated as a defect and dropped.
    const efforts = Array.isArray(gatewayModel.reasoningEfforts) ? gatewayModel.reasoningEfforts : [];
    if (efforts.some(effort => !REASONING_EFFORTS.includes(effort))
      || new Set(efforts).size !== efforts.length) {
      warn(`Endpoint model has invalid reasoning efforts: ${publicId}`);
      continue;
    }
    seen.add(publicId);
    const provider = providerByID.get(gatewayModel.provider);
    const catalogModel = catalogByPublicId.get(publicId);
    const quotaProvider = provider?.quotaProvider ?? gatewayModel.provider;
    const summary = providerQuotaSummary(quotaByProvider.get(quotaProvider) ?? quotaByProvider.get(gatewayModel.provider));
    const maxOutputTokens = gatewayModel.maxOutputTokens ?? gatewayModel.maxTokens;
    entries.push({
      publicId,
      provider: gatewayModel.provider,
      providerDisplayName: provider?.displayName ?? gatewayModel.provider,
      model: gatewayModel.id,
      displayName: gatewayModel.displayName,
      runtime,
      reasoningEfforts: [...efforts],
      ...(gatewayModel.capabilities === undefined ? {} : { capabilities: gatewayModel.capabilities }),
      ...(gatewayModel.maxInputTokens === undefined ? {} : { maxInputTokens: gatewayModel.maxInputTokens }),
      ...(gatewayModel.inputModalities === undefined ? {} : { inputModalities: gatewayModel.inputModalities }),
      quotaProvider,
      ...(gatewayModel.contextWindow === undefined ? {} : { contextWindow: gatewayModel.contextWindow }),
      ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
      ...(catalogModel?.free === undefined ? {} : { free: catalogModel.free }),
      ...(catalogModel?.effectiveTps === undefined ? {} : { effectiveTps: catalogModel.effectiveTps }),
      ...(catalogModel?.quotaState === undefined ? {} : { quotaState: catalogModel.quotaState }),
      ...(catalogModel?.quotaEvidence === undefined ? {} : { quotaEvidence: catalogModel.quotaEvidence }),
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
  return entries;
}
