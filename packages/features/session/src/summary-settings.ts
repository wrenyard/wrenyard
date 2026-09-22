import type { WrenyardGatewayConnection } from '@wrenyard/control-client';
import type { SummarySettingsSnapshot } from '@wrenyard/protocol/session';
import { builtinCatalog } from './catalog.js';
import { hasUsableSummaryProvider, summaryGatewayCandidates } from './conversation-summary.js';

/**
 * Project the summary-model settings surface: the persisted canonical model id
 * plus every ordinary-LLM candidate the live local Gateway can serve right now.
 *
 * A candidate is only listed when the gateway projection carries it, because
 * that list is already filtered to credentialed providers — a provider
 * directory entry alone is never usable evidence. The persisted choice always
 * appears, marked unavailable when no usable route backs it, so the user can
 * see what is selected instead of silently losing it.
 */
export async function buildSummarySettingsSnapshot(options: {
  readGatewayConnection?: () => Promise<WrenyardGatewayConnection>;
  readSummaryModel?: () => string;
}): Promise<SummarySettingsSnapshot> {
  const selectedCanonicalModel = options.readSummaryModel?.() ?? '';
  let connection: WrenyardGatewayConnection | null = null;
  try {
    connection = await options.readGatewayConnection?.() ?? null;
  } catch {
    connection = null;
  }
  if (connection === null) {
    return {
      selectedCanonicalModel,
      options: [],
      unresolved: true,
      message: '本地模型网关不可用，暂时无法解析摘要模型。',
    };
  }
  const candidates = summaryGatewayCandidates(connection);
  const seen = new Set<string>();
  const projected: SummarySettingsSnapshot['options'] = [];
  for (const candidate of candidates) {
    if (seen.has(candidate.canonicalModel)) continue;
    seen.add(candidate.canonicalModel);
    projected.push({
      canonicalModel: candidate.canonicalModel,
      publicId: candidate.publicId,
      displayName: candidate.displayName,
      providerLabel: candidate.providerLabel,
      available: true,
    });
  }
  if (selectedCanonicalModel && !seen.has(selectedCanonicalModel)) {
    const definition = builtinCatalog().providers().flatMap((provider) => provider.models)
      .find((model) => (model.canonicalModel?.id ?? model.id) === selectedCanonicalModel);
    projected.push({
      canonicalModel: selectedCanonicalModel,
      displayName: definition?.displayName ?? selectedCanonicalModel,
      available: false,
    });
  }
  return {
    selectedCanonicalModel,
    options: projected,
    unresolved: !hasUsableSummaryProvider(connection, selectedCanonicalModel),
  };
}
