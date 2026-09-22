import { desktopCatalog } from './builtin-catalog.js';
import type { WrenyardGatewayConnection, WrenyardGatewayModel } from '@wrenyard/control-client';
import type { SettingsSnapshot, SummarySettingsSnapshot } from './shell-contract.js';
import type { PetCompanionSnapshot } from './shell-contract.js';
import type { UpdateSnapshot } from './shell-contract.js';
import type { WorkspaceConfigurationSnapshot } from './shell-contract.js';
import { hasUsableSummaryProvider, summaryGatewayCandidates } from './conversation-summary.js';

export interface HealthSnapshot {
  connected: boolean;
  uptimeMs?: number;
}

export interface SettingsSnapshotOptions {
  endpoint: string;
  workspace: WorkspaceConfigurationSnapshot;
  desktopVersion: string;
  wrenyardVersion: string;
  dshVersion: string;
  buildTime?: string;
  readHealth(): Promise<HealthSnapshot>;
  readGatewayModels?: () => Promise<WrenyardGatewayModel[]>;
  /** Live local Gateway connection for the summary-model setting projection. */
  readGatewayConnection?: () => Promise<WrenyardGatewayConnection>;
  /** Canonical summary-model preference persisted by the summary service. */
  readSummaryModel?: () => string;
  readPet(): Promise<PetCompanionSnapshot>;
  readUpdate(): UpdateSnapshot;
  sourceDevelopment?: boolean;
}

/**
 * Project the summary-model preference against the live (credential-filtered)
 * Gateway connection. A provider directory entry alone never proves usable
 * credentials — the daemon connection list is the availability SSOT here.
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
    const definition = desktopCatalog().providers().flatMap((provider) => provider.models)
      .find((model) => (model.canonicalModel?.id ?? model.id) === selectedCanonicalModel);
    projected.push({ canonicalModel: selectedCanonicalModel,
      displayName: definition?.displayName ?? selectedCanonicalModel, available: false });
  }
  return {
    selectedCanonicalModel,
    options: projected,
    unresolved: !hasUsableSummaryProvider(connection, selectedCanonicalModel),
  };
}

/**
 * Build the read-only Desktop settings projection. Credential values are
 * reduced to booleans here so the renderer can never receive a secret.
 */
export async function buildSettingsSnapshot(options: SettingsSnapshotOptions): Promise<SettingsSnapshot> {
  const update = options.readUpdate();
  const [health, gatewayModels, pet] = await Promise.all([
    options.readHealth().catch((): HealthSnapshot => ({ connected: false })),
    (options.readGatewayModels ?? (async () => []))().catch((): WrenyardGatewayModel[] => []),
    options.readPet(),
  ]);

  return {
    service: {
      status: health.connected ? 'connected' : 'unavailable',
      endpoint: options.endpoint,
      workspace: options.workspace,
      ...(typeof health.uptimeMs === 'number' ? { uptimeMs: health.uptimeMs } : {}),
    },
    models: [...new Map(gatewayModels.map((model) => [model.provider, {
      id: model.provider,
      label: model.provider,
      configured: true,
    }])).values()],
    pet,
    update,
    about: {
      desktopVersion: options.desktopVersion,
      wrenyardVersion: options.wrenyardVersion,
      dshVersion: options.dshVersion,
      ...(options.buildTime ? { buildTime: options.buildTime } : {}),
      channel: update.channel,
      ...(options.sourceDevelopment ? { sourceDevelopment: true } : {}),
    },
  };
}
