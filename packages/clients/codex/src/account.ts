import { rpcSequence, type Executor } from '@wrenyard/execution';
import { ClientError, type AccountOptions, type AccountSnapshot } from '@wrenyard/agent-client';
import { inspectCodex } from './installation.ts';
export async function readCodexAccount(execution: Executor, options?: AccountOptions): Promise<AccountSnapshot> {
    const status = await inspectCodex(options);
    if (status.installation.state !== 'installed') throw new ClientError('configuration_missing');
    const results = await rpcSequence(execution, { command: status.installation.executable, args: ['app-server', '--stdio'], steps: [
            { method: 'initialize', params: { clientInfo: { name: 'wrenyard', title: 'Wrenyard', version: '1' } } },
            { method: 'initialized', notification: true },
            { method: 'account/rateLimits/read', params: null },
        ] }, options);
    return results[2] as AccountSnapshot;
}
