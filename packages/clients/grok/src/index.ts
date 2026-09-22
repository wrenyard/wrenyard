import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { ForgeAgentClient, ClientError, observation, type AccountRequest, type ClientOptions } from '@wrenyard/agent-client';
import { clientOperation, rpcSequence, NativeOperationError } from '@wrenyard/execution';
export class GrokClient extends ForgeAgentClient {
    readonly id = 'grok';
    readonly capabilities = { run: true, account: true };
    async readAccount(_request?: AccountRequest, options?: ClientOptions): Promise<unknown> {
        const sources = await clientOperation(this.execution, 'credential', { store: 'grok-sources' }, options) as string[];
        if (!Array.isArray(sources) || !sources.length)
            throw new ClientError('configuration_missing');
        const env = options?.env ?? process.env, home = env.HOME || env.USERPROFILE || homedir();
        const name = process.platform === 'win32' ? 'grok.exe' : 'grok';
        const local = join(home, '.grok', 'bin', name);
        const command = existsSync(local) ? local : name;
        for (const source of sources) {
            try {
                const results = await rpcSequence(this.execution, { command, args: ['agent', 'stdio'],
                    env: { GROK_HOME: dirname(source), XAI_API_KEY: null, GROK_CODE_XAI_API_KEY: null }, steps: [
                        { method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } },
                        { method: '_x.ai/billing' },
                    ] }, options);
                return observation('grok-acp-billing', results[1]);
            }
            catch (error) {
                options?.signal?.throwIfAborted();
                if (!(error instanceof NativeOperationError) || (error.step === 1 && error.rpcCode !== -32000))
                    throw error;
            }
        }
        throw new ClientError('authentication_required');
    }
}
