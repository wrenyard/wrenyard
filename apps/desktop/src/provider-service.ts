import { WrenyardIpcClient, type WrenyardProviderStatus } from '@wrenyard/control';
import { StaleGenerationError } from './main/remote/context.js';
import type { ProviderAuthStatus } from './shell-contract.js';

const MAX_PROVIDER_ID_LENGTH = 120;
const MAX_KEY_LENGTH = 4096;

export interface ProviderControlClient {
  providerList(): Promise<{ providers: WrenyardProviderStatus[] }>;
  providerConfigure(providerId: string, key: string): Promise<{ ok: true }>;
  close(): void;
}

export interface ProviderServiceOptions {
  ipcPath: string;
  canConnect?: () => boolean;
  /**
   * Active connection generation, captured before each request and re-checked
   * once it resolves. A provider/quota reply produced on the previous endpoint
   * is discarded instead of being applied after a connection switch.
   */
  getGeneration?: () => number;
  clientFactory?: (path: string) => ProviderControlClient;
}

/** Provider metadata and credentials have one boundary: daemon IPC. */
export class ProviderService {
  private readonly clientFactory: (path: string) => ProviderControlClient;

  constructor(private readonly options: ProviderServiceOptions) {
    this.clientFactory = options.clientFactory ?? ((path) => new WrenyardIpcClient({ path }));
  }

  /**
   * Reject a reply whose generation was superseded by a connection switch. The
   * caller sees the same error a fenced transport request would raise, so a
   * previous context's catalog can never be projected into the new one.
   */
  private assertCurrentGeneration(generation: number | undefined): void {
    if (generation === undefined) return;
    if (this.options.getGeneration?.() !== generation) {
      throw new StaleGenerationError('连接上下文已切换，忽略过期结果');
    }
  }

  async listProviders(): Promise<ProviderAuthStatus[]> {
    if (this.options.canConnect?.() === false) throw new Error('daemon 不可用');
    const generation = this.options.getGeneration?.();
    const client = this.clientFactory(this.options.ipcPath);
    try {
      const result = await client.providerList();
      this.assertCurrentGeneration(generation);
      return result.providers.map((provider) => ({
        id: provider.id,
        displayName: provider.displayName,
        description: provider.description,
        setupHint: provider.setupHint,
        configured: provider.configured,
        authMode: provider.authMode,
        models: provider.models.map((model) => ({
          id: model.id,
          displayName: model.displayName,
          ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
          ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
          ...(model.taskOnly === undefined ? {} : { taskOnly: model.taskOnly }),
          ...(model.effectiveTps === undefined ? {} : { effectiveTps: model.effectiveTps }),
          ...(model.quotaAbundant === undefined ? {} : { quotaAbundant: model.quotaAbundant }),
          ...(model.free === undefined ? {} : { free: model.free }),
          // The CodeBuddy credit multiplier copied through verbatim; omitted when
          // the catalog declares none rather than defaulted.
          ...(model.credits === undefined ? {} : { credits: model.credits }),
          ...(model.intelligence === undefined ? {} : { intelligence: model.intelligence }),
          ...(model.speedSource === undefined ? {} : { speedSource: model.speedSource }),
          ...(model.available === undefined ? {} : { available: model.available }),
          // Omitted when the catalog declares no price rather than defaulted.
          ...(model.pricing === undefined ? {} : { pricing: model.pricing }),
        })),
      }));
    } finally {
      client.close();
    }
  }

  async configureApiKey(providerId: string, key: string): Promise<void> {
    if (this.options.canConnect?.() === false) throw new Error('daemon 不可用');
    if (typeof providerId !== 'string' || !providerId || providerId.length > MAX_PROVIDER_ID_LENGTH) {
      throw new Error('Provider id 无效');
    }
    const normalized = key.trim();
    if (!normalized || normalized.length > MAX_KEY_LENGTH) throw new Error('API Key 格式无效');
    const generation = this.options.getGeneration?.();
    const client = this.clientFactory(this.options.ipcPath);
    try {
      await client.providerConfigure(providerId, normalized);
      this.assertCurrentGeneration(generation);
    } finally {
      client.close();
    }
  }
}
