/** Projects current daemon route metadata; a defective row never breaks the list. */
import { REASONING_EFFORTS, isMainstreamModelId } from '@wrenyard/models';
import type { WrenyardGatewayModel } from '@wrenyard/control';
import type { ProviderListResult } from '@wrenyard/protocol/provider';
import { selectSessionProtocol } from '@wrenyard/session/model-metadata';
import type { SessionBridgeModelEntry } from './preload.js';

export function toModelEntries(
  result: ProviderListResult,
  gatewayModels: readonly WrenyardGatewayModel[],
  warn: (message: string) => void = console.warn,
): SessionBridgeModelEntry[] {
  // Index the Gateway directory by both the public id and `provider/model`, so
  // the model's protocols come from the Gateway model row, never the Provider.
  const gatewayByPublicId = new Map<string, WrenyardGatewayModel>();
  for (const model of gatewayModels) {
    gatewayByPublicId.set(model.publicId, model);
    gatewayByPublicId.set(`${model.provider}/${model.id}`, model);
  }
  const entries = new Map<string, SessionBridgeModelEntry>();
  for (const provider of result.providers) {
    if (!provider.configured) continue;
    for (const model of provider.models) {
      const publicId = `${provider.id}/${model.id}`;
      // Session inference uses the credential-backed Gateway, not Task client admission.
      if (model.taskOnly === true
        || (model.supportedClients?.length ?? 0) > 0 || entries.has(publicId)) continue;
      // Devin SWE-2 is explicitly selectable alongside the mainstream catalog.
      if (!isMainstreamModelId(model.canonicalId ?? model.id)
        && !(provider.id === 'devin' && model.id === 'swe-2')) continue;
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
        quotaProvider: provider.quotaProvider ?? provider.id,
        ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
        ...(model.maxTokens === undefined ? {} : { maxOutputTokens: model.maxTokens }),
        ...(model.free === undefined ? {} : { free: model.free }),
        ...(model.effectiveTps === undefined ? {} : { effectiveTps: model.effectiveTps }),
        ...(model.quotaAbundant === undefined ? {} : { quotaAbundant: model.quotaAbundant }),
        // Route health comes from the Gateway row, which already scopes a fault
        // to its own route/provider/pool — a zero paid balance never marks a free
        // pool. The row is still emitted while faulted so a selected model that
        // became unavailable can still be named and explained.
        ...(gatewayModel.routeState === undefined ? {} : { routeState: gatewayModel.routeState }),
        ...(gatewayModel.routePhase === undefined ? {} : { routePhase: gatewayModel.routePhase }),
        ...(gatewayModel.routeNextProbeAt === undefined ? {} : { routeNextProbeAt: gatewayModel.routeNextProbeAt }),
        ...(gatewayModel.supportsFast === true ? { supportsFast: true } : {}),
      });
    }
  }
  return [...entries.values()];
}
