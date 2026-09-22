import { openSession } from '@wrenyard/agent-client/session';
import type { AgentClient, AgentRequest, AgentSession, ClientStatus, InspectOptions, OperationOptions } from '@wrenyard/agent-client';
import { decodeOpenCode } from './events.ts';
import { inspectOpenCode } from './installation.ts';
import { launchOpenCode } from './launch.ts';
export class OpenCodeClient implements AgentClient {
    readonly id = 'opencode';
    readonly capabilities = { run: true, account: false, resume: true };
    inspect(options?: InspectOptions): Promise<ClientStatus> {
        return inspectOpenCode(options);
    }
    async start(request: AgentRequest, options?: OperationOptions): Promise<AgentSession> {
        const env = options?.env ?? process.env;
        return await openSession(await launchOpenCode(request, env), decodeOpenCode, options);
    }
}
