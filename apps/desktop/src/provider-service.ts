import { WrenyardIpcClient, type WrenyardProviderStatus } from '@wrenyard/control-client';
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
  clientFactory?: (path: string) => ProviderControlClient;
}

/** Provider metadata and credentials have one boundary: daemon IPC. */
export class ProviderService {
  private readonly clientFactory: (path: string) => ProviderControlClient;

  constructor(private readonly options: ProviderServiceOptions) {
    this.clientFactory = options.clientFactory ?? ((path) => new WrenyardIpcClient({ path }));
  }

  async listProviders(): Promise<ProviderAuthStatus[]> {
    const client = this.clientFactory(this.options.ipcPath);
    try {
      const result = await client.providerList();
      return result.providers.map((provider) => ({
        id: provider.id,
        displayName: provider.displayName,
        description: provider.description,
        setupHint: provider.setupHint,
        configured: provider.configured,
        authMode: provider.authMode,
      }));
    } finally {
      client.close();
    }
  }

  async configureApiKey(providerId: string, key: string): Promise<void> {
    if (typeof providerId !== 'string' || !providerId || providerId.length > MAX_PROVIDER_ID_LENGTH) {
      throw new Error('Provider id 无效');
    }
    const normalized = key.trim();
    if (!normalized || normalized.length > MAX_KEY_LENGTH) throw new Error('API Key 格式无效');
    const client = this.clientFactory(this.options.ipcPath);
    try {
      await client.providerConfigure(providerId, normalized);
    } finally {
      client.close();
    }
  }
}
