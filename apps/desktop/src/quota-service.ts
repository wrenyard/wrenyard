import { WrenyardIpcClient } from '@wrenyard/control';
import { parseQuotaJson, type QuotaProviderState } from './main/projections/quota-runtime';

/**
 * Desktop quota source: reads the daemon-owned provider quota projection over
 * the local control socket. Errors propagate to the controller (never an empty
 * list) so a failed query is distinguishable from a genuinely empty catalog.
 */
export class DesktopQuotaSource {
  constructor(private readonly ipcPath: string, private readonly canConnect: () => boolean = () => true) {}

  async listProviders(forceRefresh = false): Promise<QuotaProviderState[]> {
    if (!this.canConnect()) throw new Error('daemon 不可用');
    const client = new WrenyardIpcClient({ path: this.ipcPath });
    try {
      const result = await client.providerQuota(forceRefresh, { timeoutMs: 45_000 });
      return parseQuotaJson(JSON.stringify(result.providers));
    } finally {
      client.close();
    }
  }
}
