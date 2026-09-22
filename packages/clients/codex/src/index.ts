import { ForgeAgentClient, type AccountRequest, type ClientOptions } from '@wrenyard/agent-client';
import { rpcSequence } from '@wrenyard/execution';
export class CodexClient extends ForgeAgentClient {
    readonly id = 'codex';
    readonly capabilities = { run: true, account: true };
    async readAccount(_request?: AccountRequest, options?: ClientOptions): Promise<unknown> {
        const results = await rpcSequence(this.execution, { command: 'codex', args: ['app-server', '--stdio'], steps: [
                { method: 'initialize', params: { clientInfo: { name: 'wrenyard', title: 'Wrenyard', version: '1' } } },
                { method: 'initialized', notification: true },
                { method: 'account/rateLimits/read', params: null },
            ] }, options);
        return results[2];
    }
}
