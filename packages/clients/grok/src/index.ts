import { Executor } from '@wrenyard/execution';
import { openSession } from '@wrenyard/agent-client/session';
import type { AccountOptions, AccountSnapshot, AgentClient, AgentRequest, AgentSession, ClientStatus, InspectOptions, OperationOptions } from '@wrenyard/agent-client';
import { readGrokAccount } from './account.ts';
import { decodeGrok } from './events.ts';
import { inspectGrok } from './installation.ts';
import { launchGrok } from './launch.ts';
export class GrokClient implements AgentClient {
    readonly id = 'grok';
    readonly capabilities = { run: true, account: true, resume: true };
    private readonly execution = new Executor();
    inspect(options?: InspectOptions): Promise<ClientStatus> {
        return inspectGrok(options);
    }
    async start(request: AgentRequest, options?: OperationOptions): Promise<AgentSession> {
        const env = options?.env ?? process.env;
        return await openSession(await launchGrok(request, env), decodeGrok, options);
    }
    readAccount(options?: AccountOptions): Promise<AccountSnapshot> {
        return readGrokAccount(this.execution, options);
    }
}
