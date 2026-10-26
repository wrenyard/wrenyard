import { type AgentClient, type AgentRequest, type AgentSession, type ClientStatus, type InspectOptions, type OperationOptions } from '@wrenyard/agent-client';
import { openSession } from '@wrenyard/agent-client/session';
import { decodeDsh } from './events.ts';
import { inspectDsh } from './installation.ts';
import { prepareDshLaunch } from './launch.ts';

export class DshClient implements AgentClient {
    readonly id = 'dsh';
    /**
     * Resume stays disabled because this adapter launches every run against a
     * disposable per-run DSH_HOME and keeps no persistent session store, so
     * there is never a session to resume. It is not an upstream limitation:
     * 0.2.0-rc.2's headless profile does accept `--session-id`.
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
            void session.result.finally(() => launch.cleanup()).catch(() => undefined);
            return {
                events: session.events,
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
