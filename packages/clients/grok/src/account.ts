import { dirname } from 'node:path';
import { rpcSequence, NativeOperationError, type Executor } from '@wrenyard/execution';
import { ClientError, observation, type AccountOptions, type AccountSnapshot } from '@wrenyard/agent-client';
import { readableGrokOAuthSources } from './sources.ts';
import { inspectGrok } from './installation.ts';
export async function readGrokAccount(execution: Executor, options?: AccountOptions): Promise<AccountSnapshot> {
    const env = options?.env ?? process.env;
    const sources = await readableGrokOAuthSources(env);
    if (!sources.length)
        throw new ClientError('configuration_missing');
    const status = await inspectGrok({ env });
    if (status.installation.state !== 'installed')
        throw new ClientError('configuration_missing');
    const command = status.installation.executable;
    for (const source of sources) {
        try {
            const results = await rpcSequence(execution, { command, args: ['agent', 'stdio'],
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
