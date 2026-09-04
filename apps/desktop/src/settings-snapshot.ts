import type { WrenyardGatewayModel } from '@wrenyard/control-client';
import type { SettingsSnapshot } from './shell-contract.js';
import type { PetCompanionSnapshot } from './shell-contract.js';
import type { UpdateSnapshot } from './shell-contract.js';
import type { WorkspaceConfigurationSnapshot } from './shell-contract.js';

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
  readPet(): Promise<PetCompanionSnapshot>;
  readUpdate(): UpdateSnapshot;
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
    },
  };
}
