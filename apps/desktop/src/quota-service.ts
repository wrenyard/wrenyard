import { WrenyardIpcClient } from '@wrenyard/control';
import { parseQuotaJson, type QuotaProviderState } from './main/projections/quota-runtime';
import { StaleGenerationError } from './main/remote/context.js';

/**
 * Desktop quota source: reads the daemon-owned provider quota projection over
 * the local control socket. Errors propagate to the controller (never an empty
 * list) so a failed query is distinguishable from a genuinely empty catalog.
 */
export class DesktopQuotaSource {
  constructor(
    private readonly ipcPath: string,
    private readonly canConnect: () => boolean = () => true,
    /**
     * Active connection generation. Captured before the request and re-checked
     * once it resolves, so a quota reply produced on the previous endpoint is
     * discarded instead of repopulating the controller's cache after a switch.
     */
    private readonly getGeneration?: () => number,
  ) {}

  async listProviders(forceRefresh = false): Promise<QuotaProviderState[]> {
    if (!this.canConnect()) throw new Error('daemon 不可用');
    const generation = this.getGeneration?.();
    const client = new WrenyardIpcClient({ path: this.ipcPath });
    try {
      const result = await client.providerQuota(forceRefresh, { timeoutMs: 45_000 });
      // A switch that committed while this request was in flight makes the
      // reply belong to the previous endpoint: drop it rather than cache it.
      if (generation !== undefined && this.getGeneration?.() !== generation) {
        throw new StaleGenerationError('连接上下文已切换，忽略过期结果');
      }
      return parseQuotaJson(JSON.stringify(result.providers));
    } finally {
      client.close();
    }
  }
}
