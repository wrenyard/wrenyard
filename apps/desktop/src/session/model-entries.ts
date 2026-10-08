/** Projects current daemon route metadata; a defective row never breaks the list. */
import { REASONING_EFFORTS } from '@wrenyard/models';
import type { ProviderListResult } from '@wrenyard/protocol/provider';
import { selectInferenceMode } from '@wrenyard/session/model-metadata';
import type { SessionBridgeModelEntry } from './preload.js';

export function toModelEntries(
  result: ProviderListResult,
  warn: (message: string) => void = console.warn,
): SessionBridgeModelEntry[] {
  const entries = new Map<string, SessionBridgeModelEntry>();
  for (const provider of result.providers) {
    if (!provider.configured) continue;
    const runtime = selectInferenceMode(provider.protocols);
    if (!runtime) continue;
    for (const model of provider.models) {
      const publicId = `${provider.id}/${model.id}`;
      if (model.available !== true || model.taskOnly === true
        || model.supportedClients !== undefined || entries.has(publicId)) continue;
      const efforts = model.reasoningEfforts;
      if (!Array.isArray(efforts) || efforts.length === 0
        || efforts.some(effort => !REASONING_EFFORTS.includes(effort))
        || new Set(efforts).size !== efforts.length) {
        warn(`Catalog model has missing or invalid reasoning efforts: ${publicId}`);
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
      });
    }
  }
  return [...entries.values()];
}
