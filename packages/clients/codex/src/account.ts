import { rpcSequence, type Executor } from '@wrenyard/execution';
import type { AccountOptions, AccountSnapshot } from '@wrenyard/agent-client';
export async function readCodexAccount(execution: Executor, options?: AccountOptions): Promise<AccountSnapshot> {
    const results = await rpcSequence(execution, { command: 'codex', args: ['app-server', '--stdio'], steps: [
            { method: 'initialize', params: { clientInfo: { name: 'wrenyard', title: 'Wrenyard', version: '1' } } },
            { method: 'initialized', notification: true },
            { method: 'account/rateLimits/read', params: null },
        ] }, options);
    return results[2] as AccountSnapshot;
}
