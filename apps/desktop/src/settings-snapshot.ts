import {
  INJECTED_PROVIDERS,
  resolveModelCredentialEnv,
} from './model-patch.js';
import type { SettingsSnapshot } from './shell-contract.js';
import type { PetCompanionSnapshot } from './shell-contract.js';
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
  readHealth(): Promise<HealthSnapshot>;
  readCredentialEnv?: () => Promise<NodeJS.ProcessEnv>;
  readPet(): Promise<PetCompanionSnapshot>;
}

/**
 * Build the read-only Desktop settings projection. Credential values are
 * reduced to booleans here so the renderer can never receive a secret.
 */
export async function buildSettingsSnapshot(options: SettingsSnapshotOptions): Promise<SettingsSnapshot> {
  const [health, credentialEnv, pet] = await Promise.all([
    options.readHealth().catch((): HealthSnapshot => ({ connected: false })),
    (options.readCredentialEnv ?? resolveModelCredentialEnv)().catch((): NodeJS.ProcessEnv => ({})),
    options.readPet(),
  ]);

  return {
    service: {
      status: health.connected ? 'connected' : 'unavailable',
      endpoint: options.endpoint,
      workspace: options.workspace,
      ...(typeof health.uptimeMs === 'number' ? { uptimeMs: health.uptimeMs } : {}),
    },
    models: INJECTED_PROVIDERS.map((provider) => ({
      id: provider.routeKey,
      label: provider.displayName,
      configured: typeof credentialEnv[provider.apiKeyEnv] === 'string'
        && credentialEnv[provider.apiKeyEnv]!.trim() !== '',
    })),
    pet,
    about: {
      desktopVersion: options.desktopVersion,
      wrenyardVersion: options.wrenyardVersion,
      dshVersion: options.dshVersion,
      channel: 'development-preview',
    },
  };
}
