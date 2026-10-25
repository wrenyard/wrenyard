import { cp, mkdir, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentRequest } from '@wrenyard/agent-client';
import { claudeFamilyMcpConfig, resolveMcpServers } from '@wrenyard/agent-client/mcp';
import { assertLaunch, clientStateDirForEnv, createOwnedClientRunHome, preserveClientRunHomeSessionSnapshot, stringEnv } from '@wrenyard/agent-client/native';
import type { ProcessSpec } from '@wrenyard/execution';
import { registerRunHomeSessionPreserveSlot } from './session-preserve.ts';

const GATEWAY_CHAT_URL_ENV = 'WRENYARD_GATEWAY_OPENAI_CHAT_URL';
const GATEWAY_TOKEN_ENV = 'WRENYARD_GATEWAY_TOKEN';

function gatewayModelConfig(request: AgentRequest, endpoint: string): string {
    const model = request.model.trim();
    if (!model || !request.provider)
        throw new Error('codebuddy: a gateway launch requires a model and resolved provider');
    return `${JSON.stringify({
        models: [{
            id: model,
            url: endpoint,
            apiKey: '${WRENYARD_GATEWAY_TOKEN}',
            supportsToolCall: true,
        }],
        availableModels: [model],
    }, null, 2)}\n`;
}

async function assertNoProjectModelConfig(cwd: string): Promise<void> {
    const path = join(cwd, '.codebuddy', 'models.json');
    try {
        await stat(path);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw new Error(`codebuddy: unable to verify project custom-model configuration at ${path}`, { cause: error });
    }
    throw new Error(`codebuddy: project custom-model configuration is not allowed in gateway mode: ${path}`);
}

export async function launchCodeBuddy(request: AgentRequest, env: NodeJS.ProcessEnv, executable: string): Promise<ProcessSpec> {
    assertLaunch(request);
    // The mapped wire effort is mandatory here: CodeBuddy has no default level
    // and a run must never silently drop effort. It is carried per invocation
    // through `--settings`, never written into any persistent user config.
    if (!request.clientReasoningEffort)
        throw new Error('codebuddy requires a mapped reasoning effort');
    const ownedHome = await createOwnedClientRunHome(env, 'codebuddy');
    try {
    const gateway = request.mode === 'gateway';
    if (gateway && request.protocol !== 'openai_chat')
        throw new Error('codebuddy: gateway mode requires the openai_chat protocol');
    // The gateway resolves custom models with a `custom-local:` prefix while the
    // generated model config keeps the bare id; native launches use the bare id.
    const selectedModel = gateway ? `custom-local:${request.model.trim()}` : request.model;
    const gatewayEndpoint = gateway ? env[GATEWAY_CHAT_URL_ENV]?.trim() : undefined;
    const gatewayToken = gateway ? env[GATEWAY_TOKEN_ENV]?.trim() : undefined;
    const gatewayEnv = gateway ? {
        CODEBUDDY_CUSTOM_HEADERS: `X-Wrenyard-Provider: ${request.provider}`,
        CODEBUDDY_MODEL: selectedModel,
        // The custom model URL wins; clear inherited overrides for isolation.
        CODEBUDDY_BASE_URL: '',
    } : undefined;
    if (gateway && !gatewayEndpoint)
        throw new Error(`codebuddy: a gateway launch requires ${GATEWAY_CHAT_URL_ENV}`);
    if (gateway && !gatewayToken)
        throw new Error(`codebuddy: a gateway launch requires ${GATEWAY_TOKEN_ENV}`);
    if (gateway)
        await assertNoProjectModelConfig(request.cwd);
    const preserveSlot = { snapshotDir: ownedHome.path, sessionId: '', preserveTo: '' };
    const executionId = request.executionId?.trim();
    if (executionId) registerRunHomeSessionPreserveSlot(executionId, preserveSlot);
    ownedHome.preserveSession = async (homePath, context) => {
        if (context?.success) return;
        if (!preserveSlot.sessionId) return;
        await preserveClientRunHomeSessionSnapshot(env, ownedHome, homePath, preserveSlot.sessionId);
    };
    const sharedProjects = clientStateDirForEnv(env, 'codebuddy', 'agent-config', 'projects');
    await mkdir(sharedProjects, { recursive: true });
    await symlink(sharedProjects, join(ownedHome.path, 'projects'), 'dir');
    if (request.resumeSessionId) {
        const snapshot = clientStateDirForEnv(env, 'codebuddy', 'sessions', request.resumeSessionId);
        try {
            const entries = await readdir(snapshot, { withFileTypes: true });
            for (const entry of entries) {
                if (entry.name === 'projects') continue;
                await cp(join(snapshot, entry.name), join(ownedHome.path, entry.name), {
                    recursive: true,
                    force: false,
                    verbatimSymlinks: true,
                });
            }
        }
        catch {
            /* no snapshot yet: --resume may still attach to an empty config dir */
        }
    }
    if (gateway) {
        // Write after restoring the resume snapshot so this execution's scoped
        // endpoint always wins inside its owned config directory.
        await writeFile(join(ownedHome.path, 'models.json'), gatewayModelConfig(request, gatewayEndpoint!), { encoding: 'utf8', mode: 0o600 });
    }
    const args = ['-y', '--input-format', 'stream-json', '--output-format', 'stream-json', '--replay-user-messages', '--include-partial-messages', '--model', selectedModel];
    if (request.resumeSessionId)
        args.push('--resume', request.resumeSessionId);
    // CodeBuddy shares the Claude-family MCP dialect: strict config + JSON
    // payload immediately before the terminal -p prompt flag.
    const mcpConfig = claudeFamilyMcpConfig(resolveMcpServers(request.mcpServers));
    if (mcpConfig)
        args.push('--strict-mcp-config', '--mcp-config', mcpConfig);
    // Native settings carry only effort; gateway settings also pin invocation
    // routing to the same values supplied in the child environment.
    args.push('--settings', JSON.stringify({
        reasoningEffort: request.clientReasoningEffort,
        ...(gatewayEnv ? { env: gatewayEnv } : {}),
    }), '-p');
    return {
        executable,
        args,
        cwd: request.cwd,
        env: stringEnv(env, {
            CODEBUDDY_CONFIG_DIR: ownedHome.path,
            WORKBUDDY_CONFIG_DIR: '',
            ...(gatewayEnv ?? {}),
            CODEBUDDY_DISABLE_FILE_LOGS: '1',
            DISABLE_AUTOUPDATER: '1',
            DISABLE_TELEMETRY: '1',
            DISABLE_ERROR_REPORTING: '1',
        }),
        ownedRunHome: ownedHome,
        stdin: JSON.stringify({ type: 'user', message: { role: 'user', content: request.prompt }, parent_tool_use_id: null }) + '\n',
    };
    } catch (error) {
        await rm(ownedHome.path, { recursive: true, force: true }).catch(() => undefined);
        throw error;
    }
}
