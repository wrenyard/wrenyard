import { type AgentClient, type AgentRequest, type AgentSession, type ClientStatus, type InspectOptions, type OperationOptions } from '@wrenyard/agent-client';
import { openSession } from '@wrenyard/agent-client/session';
import { decodeDsh } from './events.ts';
import { inspectDsh } from './installation.ts';
import { prepareDshLaunch } from './launch.ts';

export class DshClient implements AgentClient {
    readonly id = 'dsh';
    /**
     * The installed `headless` DSH profile creates one fresh persisted session
     * per invocation and exposes no resume flag, so resume is not advertised.
     */
    readonly capabilities = { run: true, account: false, resume: false };
    inspect(options?: InspectOptions): Promise<ClientStatus> {
        return inspectDsh(options);
    }
    async start(request: AgentRequest, options?: OperationOptions): Promise<AgentSession> {
        const env = options?.env ?? process.env;
        // OperationOptions carries no executable selector: the WRENYARD_DSH_BIN
        // override and PATH discovery are the only launch inputs. Only the
        // inspect surface accepts an explicit executable.
        const launch = await prepareDshLaunch(request, undefined, env);
        try {
            const session = await openSession(launch.spec, decodeDsh, options);
            return {
                events: session.events,
                result: session.result.finally(() => launch.cleanup()),
                cancel: async () => {
                    try {
                        await session.cancel();
                    } finally {
                        await launch.cleanup();
                    }
                },
                diagnostics: session.diagnostics,
            };
        } catch (error) {
            await launch.cleanup();
            throw error;
        }
    }
}
