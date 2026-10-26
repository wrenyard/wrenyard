import { rm } from 'node:fs/promises';
import { openSession } from '@wrenyard/agent-client/session';
import type { AgentClient, AgentClientPreparation, AgentEvent, AgentFinalizeContext, AgentRequest, AgentSession, ClientStatus, InspectOptions, InternalAgentEvent, OperationOptions } from '@wrenyard/agent-client';
import { clientStateDirForEnv } from '@wrenyard/agent-client/native';
import type { CodeBuddyAccountContext, CodeBuddyEnvironment } from './account.ts';
import { decodeCodeBuddy } from './events.ts';
import { launchCodeBuddy } from './launch.ts';
import { readCodeBuddyAccount, readCodeBuddyInstall, type CodeBuddyProductSnapshot } from './product.ts';
import { armRunHomeSessionPreserve, clearRunHomeSessionPreserveSlot } from './session-preserve.ts';
export type { CodeBuddyAccountContext, CodeBuddyProductSnapshot };

interface ExecutionContext {
    readonly resumeSessionId?: string;
}

export class CodeBuddyClient implements AgentClient {
    readonly id = 'codebuddy';
    readonly capabilities = { run: true, account: false, resume: true };
    private cache: { key: string; install: Awaited<ReturnType<typeof readCodeBuddyInstall>> } | undefined;
    /** Per-execution context keyed by executionId, populated at start. */
    private readonly executions = new Map<string, ExecutionContext>();

    inspect(options?: InspectOptions): Promise<ClientStatus> {
        return this.load(options).then((install) => inspectStatus(install));
    }
    async prepare(request: AgentRequest): Promise<AgentClientPreparation | void> {
        const executionId = request.executionId?.trim();
        if (!executionId)
            return;
        return { env: { WRENYARD_EXECUTION_ID: executionId } };
    }
    async start(request: AgentRequest, options?: OperationOptions): Promise<AgentSession> {
        const env = options?.env ?? process.env;
        const install = await this.load(options);
        if (!install.product.executable)
            throw new Error(install.product.reason ?? 'codebuddy executable is not bound to the product snapshot');
        const executionId = request.executionId?.trim();
        if (executionId)
            this.executions.set(executionId, { resumeSessionId: request.resumeSessionId });
        const normalizeModel = (model: string) => model === request.model ? request.canonicalModel ?? model : model;
        try {
            return await openSession(await launchCodeBuddy(request, env, install.product.executable),
                (events) => this.decodeWithPreserveArming(decodeCodeBuddy(events, normalizeModel), executionId), options);
        }
        catch (error) {
            if (executionId) {
                this.executions.delete(executionId);
                clearRunHomeSessionPreserveSlot(executionId);
            }
            throw error;
        }
    }
    /**
     * Arm the run-home session-preserve slot the moment the native session id
     * becomes known, on both the `session` event and the `finished` event
     * paths, keyed by this run's execution id. The execution layer never sees
     * this: a non-success run snapshots its owned run home through
     * `ownedHome.preserveSession` using the armed slot.
     */
    private async *decodeWithPreserveArming(
        events: AsyncIterable<AgentEvent | InternalAgentEvent>,
        executionId: string | undefined,
    ): AsyncGenerator<AgentEvent | InternalAgentEvent> {
        try {
            for await (const event of events) {
                if (executionId
                    && (event.type === 'session' || event.type === 'finished')
                    && event.nativeSessionId)
                    armRunHomeSessionPreserve(executionId, this.id, event.nativeSessionId);
                yield event;
            }
        }
        finally { /* finalization is bound to the request execution id */ }
    }
    /**
     * Post-commit cleanup for this client's own state. On `done` the resume
     * snapshot for the session this run resumed is removed; on every other
     * terminal status it is kept — non-success retention is owned by
     * `ownedHome.preserveSession` in launch.ts, not here. The run-home
     * preserve slot is always released.
     */
    async finalize(status: string, finalizeContext: AgentFinalizeContext): Promise<void> {
        const executionId = finalizeContext.executionId?.trim();
        const context = executionId ? this.executions.get(executionId) : undefined;
        if (executionId) {
            this.executions.delete(executionId);
            clearRunHomeSessionPreserveSlot(executionId);
        }
        if (status !== 'done' || !context?.resumeSessionId)
            return;
        const snapshot = clientStateDirForEnv(finalizeContext.env, 'codebuddy', 'sessions', context.resumeSessionId);
        await rm(snapshot, { recursive: true, force: true });
    }
    async readInstall(options?: InspectOptions) {
        return this.load(options);
    }
    readAccountContext(environment: CodeBuddyEnvironment, options?: InspectOptions): Promise<CodeBuddyAccountContext | undefined> {
        return readCodeBuddyAccount(environment, options);
    }
    async readProduct(options?: InspectOptions): Promise<CodeBuddyProductSnapshot> {
        return (await this.load(options)).product;
    }
    async accountContext(options?: InspectOptions): Promise<CodeBuddyAccountContext | undefined> {
        return (await this.load(options)).account;
    }
    private async load(options?: InspectOptions) {
        const env = options?.env ?? process.env;
        const key = `${process.platform}|${options?.executable ?? ''}|${env.ACC_PRODUCT_CONFIG_PATH ?? ''}|${env.PATH ?? ''}|${env.HOME ?? ''}|${env.USERPROFILE ?? ''}`;
        if (!options?.refresh && this.cache?.key === key)
            return this.cache.install;
        const install = await readCodeBuddyInstall(options);
        this.cache = { key, install };
        return install;
    }
}
function inspectStatus(install: Awaited<ReturnType<typeof readCodeBuddyInstall>>): ClientStatus {
    if (!install.product.executable) {
        return {
            installation: install.product.installationRoot
                ? { state: 'unknown', reason: install.product.reason ?? 'CLI executable was not resolved' }
                : { state: 'missing' },
            authentication: install.authentication,
        };
    }
    return {
        installation: { state: 'installed', executable: install.product.executable, ...(install.product.version ? { version: install.product.version } : {}) },
        authentication: install.authentication,
    };
}
