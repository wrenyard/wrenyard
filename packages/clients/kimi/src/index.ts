import type { AgentClient, AgentRequest, AgentSession, ClientStatus, InspectOptions, NativeClientReadiness, OperationOptions, ReadinessOptions } from '@wrenyard/agent-client';
import { startKimiAcpSession } from './acp-session.ts';
import { inspectKimi } from './installation.ts';
import { launchKimi } from './launch.ts';
import { readKimiReadiness } from './readiness.ts';

export class KimiClient implements AgentClient {
    readonly id = 'kimi';
    readonly capabilities = { run: true, account: false, resume: true };
    inspect(options?: InspectOptions): Promise<ClientStatus> {
        return inspectKimi(options);
    }
    async start(request: AgentRequest, options?: OperationOptions): Promise<AgentSession> {
        const env = options?.env ?? process.env;
        const launch = await launchKimi(request, env);
        return await startKimiAcpSession(request, launch, options);
    }
    readReadiness(options?: ReadinessOptions): Promise<NativeClientReadiness> {
        return readKimiReadiness(options);
    }
}
