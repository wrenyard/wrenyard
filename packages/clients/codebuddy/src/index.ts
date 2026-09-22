import { openSession } from '@wrenyard/agent-client/session';
import type { AgentClient, AgentRequest, AgentSession, ClientStatus, InspectOptions, OperationOptions } from '@wrenyard/agent-client';
import type { CodeBuddyAccountContext } from './account.ts';
import { decodeCodeBuddy } from './events.ts';
import { launchCodeBuddy } from './launch.ts';
import { readCodeBuddyInstall, type CodeBuddyProductSnapshot } from './product.ts';
export type { CodeBuddyAccountContext, CodeBuddyProductSnapshot };
export class CodeBuddyClient implements AgentClient {
    readonly id = 'codebuddy';
    readonly capabilities = { run: true, account: false, resume: true };
    private cache: { key: string; install: Awaited<ReturnType<typeof readCodeBuddyInstall>> } | undefined;
    inspect(options?: InspectOptions): Promise<ClientStatus> {
        return this.load(options).then((install) => inspectStatus(install));
    }
    async start(request: AgentRequest, options?: OperationOptions): Promise<AgentSession> {
        const env = options?.env ?? process.env;
        const install = await this.load(options);
        if (!install.product.executable)
            throw new Error(install.product.reason ?? 'codebuddy executable is not bound to the product snapshot');
        return await openSession(await launchCodeBuddy(request, env, install.product.executable), decodeCodeBuddy, options);
    }
    async readInstall(options?: InspectOptions) {
        return this.load(options);
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
