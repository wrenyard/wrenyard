import { Executor } from '@wrenyard/execution';
import { startCodexSession } from './protocol.ts';
import type { AccountOptions, AccountSnapshot, AgentClient, AgentRequest, AgentSession, ClientStatus, InspectOptions, NativeClientReadiness, OperationOptions, ReadinessOptions } from '@wrenyard/agent-client';
import { readCodexAccount } from './account.ts';
import { inspectCodex } from './installation.ts';
import { launchCodex } from './launch.ts';
import { readCodexReadiness } from './readiness.ts';
export class CodexClient implements AgentClient {
    readonly id = 'codex';
    readonly capabilities = { run: true, account: true, resume: true };
    private readonly execution = new Executor();
    inspect(options?: InspectOptions): Promise<ClientStatus> {
        return inspectCodex(options);
    }
    async start(request: AgentRequest, options?: OperationOptions): Promise<AgentSession> {
        const env = options?.env ?? process.env;
        return await startCodexSession(await launchCodex(request, env), request, options);
    }
    readAccount(options?: AccountOptions): Promise<AccountSnapshot> {
        return readCodexAccount(this.execution, options);
    }
    readReadiness(options?: ReadinessOptions): Promise<NativeClientReadiness> {
        return readCodexReadiness(options);
    }
}
