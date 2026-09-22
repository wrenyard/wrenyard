import type { BrowserWindow } from 'electron';
import {
  applyPetSettingsPatch,
  serializePetSettings,
  type AppConfig,
  type EntityVisibilityConfig,
} from './pet/main/config';
import type { PetRuntimeStatus } from './pet/main/runtime';
import type { QuotaProviderState } from './main/projections/quota-runtime';
import type {
  PetCompanionSettings,
  PetCompanionSnapshot,
  PetDisplaySnapshot,
} from './shell-contract.js';
import { normalizeProviderOrder } from './provider-order.js';
import {
  configFromPetSettings,
  petSettingsFromConfig,
  type DesktopSettingsStore,
} from './main/settings/desktop-settings.js';

export interface DesktopPetRuntimeHandle {
  readonly status: PetRuntimeStatus;
  start(): Promise<void>;
  stop(): Promise<void>;
  setVisible(visible: boolean): void;
  setQuotaProviders(providers: QuotaProviderState[]): void;
  /** House window, used by the shared window owner to place task entities. */
  getHouseWindow?(): BrowserWindow | null;
}

export interface DesktopPetControllerOptions {
  /** Single Desktop settings store; the controller never caches its own copy. */
  store: DesktopSettingsStore;
  createRuntime(config: AppConfig, onConfigChange: (config: AppConfig) => void): DesktopPetRuntimeHandle;
  listDisplays?(): PetDisplaySnapshot[];
}

/**
 * Owns Pet lifecycle and visibility inside the Desktop application. It never
 * persists its own document: every preference write goes through the shared
 * Desktop settings store, partitioned so a Pet save cannot clobber provider
 * order or update channel.
 *
 * Visibility is separate from disposal. `setVisible` only toggles the mounted
 * runtime; the runtime is created once and destroyed only on `stop()` (quit) or
 * a structural change the windows cannot apply in place.
 */
export class DesktopPetController {
  private readonly store: DesktopSettingsStore;
  private readonly createRuntime: DesktopPetControllerOptions['createRuntime'];
  private readonly listDisplays: () => PetDisplaySnapshot[];
  private runtime: DesktopPetRuntimeHandle | null = null;
  private runtimeConfig: AppConfig | null = null;
  private quotaProviders: QuotaProviderState[] = [];
  private transition: Promise<void> = Promise.resolve();

  constructor(options: DesktopPetControllerOptions) {
    this.store = options.store;
    this.createRuntime = options.createRuntime;
    this.listDisplays = options.listDisplays ?? (() => []);
  }

  /** Pet runtime config projected from the store partitions. */
  getConfig(): AppConfig {
    const settings = this.store.load();
    return configFromPetSettings(
      settings.pet,
      normalizeProviderOrder(settings.providers.providers),
      settings.window.graphSlip,
    );
  }

  /** Persisted visibility intent, independent of runtime state. */
  isVisible(): boolean {
    return this.store.load().pet.visible;
  }

  /** House window of the mounted runtime, when one exists. */
  getHouseWindow(): BrowserWindow | null {
    return this.runtime?.getHouseWindow?.() ?? null;
  }

  async start(): Promise<void> {
    return this.enqueue(async () => {
      const config = this.getConfig();
      if (!config.enabled) return;
      await this.startRuntime(config);
    });
  }

  async stop(): Promise<void> {
    return this.enqueue(async () => {
      const runtime = this.runtime;
      this.runtime = null;
      this.runtimeConfig = null;
      await runtime?.stop();
    });
  }

  /** Change Pet visibility without rebuilding the runtime or its subscriptions. */
  async setVisible(visible: boolean): Promise<void> {
    return this.enqueue(async () => {
      const settings = this.store.load();
      if (settings.pet.visible !== visible) {
        this.store.patch('pet', { ...settings.pet, visible });
      }
      if (visible) await this.startRuntime(this.getConfig());
      else this.runtime?.setVisible(false);
    });
  }

  async restart(): Promise<void> {
    return this.enqueue(async () => {
      await this.stopRuntime();
      const config = this.getConfig();
      if (!config.enabled) return;
      await this.startRuntime(config);
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
    this.store.patch('pet', petSettingsFromConfig(result.config));

    return this.enqueue(async () => {
      if (!result.config.enabled) {
        this.runtime?.setVisible(false);
        return;
      }
      if (this.runtime?.status === 'running' && !this.requiresRebuild(result.config)) {
        // Live-appliable change: keep the mounted runtime and its subscriptions.
        this.runtime.setVisible(true);
        return;
      }
      await this.stopRuntime();
      await this.startRuntime(this.getConfig());
    });
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

  /** Tray/compat entry point: same semantics as {@link setVisible}. */
  async setEnabled(enabled: boolean): Promise<void> {
    await this.setVisible(enabled);
  }

  setQuotaProviders(providers: QuotaProviderState[]): void {
    this.quotaProviders = providers.map((provider) => ({ ...provider }));
    this.runtime?.setQuotaProviders(this.quotaProviders);
  }

  private async startRuntime(config: AppConfig): Promise<void> {
    if (this.runtime?.status === 'running' && !this.requiresRebuild(config)) {
      this.runtime.setVisible(true);
      return;
    }
    if (this.runtime) await this.runtime.stop();
    const runtime = this.createRuntime(config, (updated) => this.persistRuntimeConfig(updated));
    this.runtime = runtime;
    this.runtimeConfig = config;
    await runtime.start();
    runtime.setVisible(true);
    runtime.setQuotaProviders(this.quotaProviders);
  }

  private async stopRuntime(): Promise<void> {
    const runtime = this.runtime;
    this.runtime = null;
    this.runtimeConfig = null;
    await runtime?.stop();
  }

  /**
   * A rebuild is only needed for changes the mounted entity windows cannot
   * apply in place: overall visibility is applied live, but scale, house skin,
   * display selection, entity toggles and tip timing all change window geometry
   * or the config the entity manager was constructed with.
   */
  private requiresRebuild(config: AppConfig): boolean {
    const current = this.runtimeConfig;
    if (!current) return true;
    // `enabled` is the visibility intent, handled by setVisible before this
    // check, so it must not force a rebuild by itself. Shared window geometry is
    // not Pet config either; it is owned by the Desktop window partition.
    const normalized = (value: AppConfig) => JSON.stringify({ ...value, enabled: false, windows: {} });
    return normalized(current) !== normalized(config);
  }

  private persistRuntimeConfig(config: AppConfig): void {
    this.runtimeConfig = config;
    this.store.patch('pet', { ...petSettingsFromConfig(config), visible: this.store.load().pet.visible });
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.transition.catch(() => undefined).then(operation);
    this.transition = result.catch(() => undefined);
    return result;
  }
}
