import { openSession } from '@wrenyard/agent-client/session';
import type { AgentClient, AgentRequest, AgentSession, ClientStatus, InspectOptions, OperationOptions } from '@wrenyard/agent-client';
import { decodePi } from './events.ts';
import { inspectPi } from './installation.ts';
import { launchPi } from './launch.ts';

export class PiClient implements AgentClient {
    readonly id = 'pi';
    readonly capabilities = { run: true, account: false, resume: false };
    inspect(options?: InspectOptions): Promise<ClientStatus> {
        return inspectPi(options);
    }
    async start(request: AgentRequest, options?: OperationOptions): Promise<AgentSession> {
        const env = options?.env ?? process.env;
        return await openSession(await launchPi(request, env), decodePi, options);
    }
}
