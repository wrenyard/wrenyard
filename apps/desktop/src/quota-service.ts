import { WrenyardIpcClient } from '@wrenyard/control-client';
import { parseQuotaJson, type QuotaProviderState } from './main/projections/quota-runtime';

/**
 * Desktop quota source: reads the daemon-owned provider quota projection over
 * the local control socket. Errors propagate to the controller (never an empty
 * list) so a failed query is distinguishable from a genuinely empty catalog.
 */
export class DesktopQuotaSource {
  constructor(private readonly ipcPath: string) {}

  async listProviders(forceRefresh = false): Promise<QuotaProviderState[]> {
    const client = new WrenyardIpcClient({ path: this.ipcPath });
    try {
      const result = await client.providerQuota(forceRefresh, { timeoutMs: 45_000 });
      return parseQuotaJson(JSON.stringify(result.providers));
    } finally {
      client.close();
    }
  }
}
