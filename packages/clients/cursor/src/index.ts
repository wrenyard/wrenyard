import { Executor } from '@wrenyard/execution';
import { openSession } from '@wrenyard/agent-client/session';
import type { AccountOptions, AccountSnapshot, AgentClient, AgentRequest, AgentSession, ClientStatus, InspectOptions, NativeClientReadiness, OperationOptions, ReadinessOptions } from '@wrenyard/agent-client';
import { readCursorAccount } from './account.ts';
import { decodeCursor } from './events.ts';
import { inspectCursor } from './installation.ts';
import { launchCursor } from './launch.ts';
import { readCursorReadiness } from './readiness.ts';
export class CursorClient implements AgentClient {
    readonly id = 'cursor';
    readonly capabilities = { run: true, account: true, resume: true };
    private readonly execution = new Executor();
    inspect(options?: InspectOptions): Promise<ClientStatus> {
        return inspectCursor(options);
    }
    async start(request: AgentRequest, options?: OperationOptions): Promise<AgentSession> {
        const env = options?.env ?? process.env;
        return await openSession(await launchCursor(request, env), decodeCursor, options);
    }
    readAccount(options?: AccountOptions): Promise<AccountSnapshot> {
        return readCursorAccount(this.execution, options);
    }
    readReadiness(options?: ReadinessOptions): Promise<NativeClientReadiness> {
        return readCursorReadiness(this.execution, options);
    }
}
