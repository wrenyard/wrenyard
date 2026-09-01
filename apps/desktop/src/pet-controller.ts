import {
  applyPetSettingsPatch,
  serializePetSettings,
  type AppConfig,
  type EntityVisibilityConfig,
} from '@wrenyard/pet/config';
import type { PetRuntimeStatus } from '@wrenyard/pet/runtime';
import type { QuotaProviderState } from '@wrenyard/pet/runtime';
import type {
  PetCompanionSettings,
  PetCompanionSnapshot,
  PetDisplaySnapshot,
} from './shell-contract.js';
import { normalizeProviderOrder, reorderProviders } from './provider-order.js';

export interface DesktopPetRuntimeHandle {
  readonly status: PetRuntimeStatus;
  start(): Promise<void>;
  stop(): Promise<void>;
  setQuotaProviders(providers: QuotaProviderState[]): void;
}

export interface DesktopPetControllerOptions {
  loadConfig(): AppConfig;
  saveConfig(config: AppConfig): void;
  createRuntime(config: AppConfig, onConfigChange: (config: AppConfig) => void): DesktopPetRuntimeHandle;
  listDisplays?(): PetDisplaySnapshot[];
}

/** Owns Pet persistence and lifecycle inside the Desktop application. */
export class DesktopPetController {
  private readonly load: () => AppConfig;
  private readonly save: (config: AppConfig) => void;
  private readonly createRuntime: DesktopPetControllerOptions['createRuntime'];
  private readonly listDisplays: () => PetDisplaySnapshot[];
  private runtime: DesktopPetRuntimeHandle | null = null;
  private quotaProviders: QuotaProviderState[] = [];
  private transition: Promise<void> = Promise.resolve();

  constructor(options: DesktopPetControllerOptions) {
    this.load = options.loadConfig;
    this.save = options.saveConfig;
    this.createRuntime = options.createRuntime;
    this.listDisplays = options.listDisplays ?? (() => []);
  }

  getConfig(): AppConfig {
    const config = this.load();
    return {
      ...config,
      quota: {
        providers: normalizeProviderOrder(config.quota.providers),
      },
    };
  }

  async start(): Promise<void> {
    return this.enqueue(async () => {
      const config = this.getConfig();
      if (!config.enabled || this.runtime?.status === 'running') return;
      if (this.runtime) await this.runtime.stop();
      const runtime = this.createRuntime(config, (updated) => this.save(updated));
      this.runtime = runtime;
      await runtime.start();
      runtime.setQuotaProviders(this.quotaProviders);
    });
  }

  async stop(): Promise<void> {
    return this.enqueue(async () => {
      const runtime = this.runtime;
      this.runtime = null;
      await runtime?.stop();
    });
  }

  async restart(): Promise<void> {
    return this.enqueue(async () => {
      const config = this.getConfig();
      const previous = this.runtime;
      this.runtime = null;
      await previous?.stop();
      if (!config.enabled) return;
      const runtime = this.createRuntime(config, (updated) => this.save(updated));
      this.runtime = runtime;
      await runtime.start();
      runtime.setQuotaProviders(this.quotaProviders);
    });
  }

  snapshot(): PetCompanionSnapshot {
    return {
      settings: serializePetSettings(this.getConfig()),
      status: this.runtime?.status ?? 'stopped',
      displays: this.listDisplays(),
    };
  }

  async saveSettings(settings: PetCompanionSettings): Promise<void> {
    const result = applyPetSettingsPatch(this.getConfig(), settings);
    if (!result.changed) return;
    this.save(result.config);
    if (result.config.enabled) await this.restart();
    else await this.stop();
  }

  async setEntityVisibility(key: keyof EntityVisibilityConfig, visible: boolean): Promise<void> {
    const current = serializePetSettings(this.getConfig());
    current.entities[key] = visible;
    await this.saveSettings(current);
  }

  async selectDisplay(displayId: number): Promise<void> {
    const current = serializePetSettings(this.getConfig());
    current.displayId = displayId;
    await this.saveSettings(current);
  }

  async setEnabled(enabled: boolean): Promise<void> {
    const current = serializePetSettings(this.getConfig());
    current.enabled = enabled;
    await this.saveSettings(current);
  }

  async saveProviderOrder(providerIds: string[]): Promise<void> {
    const current = this.getConfig();
    const providers = reorderProviders(current.quota.providers, providerIds);
    if (JSON.stringify(providers) === JSON.stringify(current.quota.providers)) return;
    this.save({
      ...current,
      quota: { providers },
    });
  }

  setQuotaProviders(providers: QuotaProviderState[]): void {
    this.quotaProviders = providers.map((provider) => ({ ...provider }));
    this.runtime?.setQuotaProviders(this.quotaProviders);
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.transition.catch(() => undefined).then(operation);
    this.transition = result.catch(() => undefined);
    return result;
  }
}
