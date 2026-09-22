import { Executor } from '@wrenyard/execution';
import { openSession } from '@wrenyard/agent-client/session';
import type { AccountOptions, AccountSnapshot, AgentClient, AgentRequest, AgentSession, ClientStatus, InspectOptions, OperationOptions } from '@wrenyard/agent-client';
import { readClaudeAccount } from './account.ts';
import { decodeClaude } from './events.ts';
import { inspectClaude } from './installation.ts';
import { launchClaude } from './launch.ts';
export class ClaudeClient implements AgentClient {
    readonly id = 'claude';
    readonly capabilities = { run: true, account: true, resume: true };
    private readonly execution = new Executor();
    inspect(options?: InspectOptions): Promise<ClientStatus> {
        return inspectClaude(options);
    }
    async start(request: AgentRequest, options?: OperationOptions): Promise<AgentSession> {
        const env = options?.env ?? process.env;
        return await openSession(await launchClaude(request, env), decodeClaude, options);
    }
    readAccount(options?: AccountOptions): Promise<AccountSnapshot> {
        return readClaudeAccount(this.execution, options, options);
    }
}
