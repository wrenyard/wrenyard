import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { findExecutable, type AgentRequest } from '@wrenyard/agent-client';
import { assertLaunch, createOwnedClientRunHome, stringEnv } from '@wrenyard/agent-client/native';
import type { ProcessSpec } from '@wrenyard/execution';

const GATEWAY_CHAT_URL_ENV = 'WRENYARD_GATEWAY_OPENAI_CHAT_URL';
const GATEWAY_TOKEN_ENV = 'WRENYARD_GATEWAY_TOKEN';

function gatewayChatBaseUrl(env: NodeJS.ProcessEnv): string {
    const raw = env[GATEWAY_CHAT_URL_ENV]?.trim();
    if (!raw)
        throw new Error(`pi: a gateway launch requires ${GATEWAY_CHAT_URL_ENV}`);
    return raw.replace(/\/chat\/completions\/?$/i, '');
}

function piModelsConfig(request: AgentRequest, baseUrl: string): string {
    const model = request.model.trim();
    if (!request.provider)
        throw new Error('pi: a gateway launch requires a resolved provider');
    const config = {
        providers: {
            wrenyard: {
                baseUrl,
                api: 'openai-completions',
                apiKey: '${WRENYARD_GATEWAY_TOKEN}',
                authHeader: true,
                headers: {
                    'x-wrenyard-provider': request.provider,
                    'x-wrenyard-reasoning-effort': request.reasoningEffort,
                },
                models: [{ id: model, name: model }],
            },
        },
    };
    return JSON.stringify(config, null, 2) + '\n';
}

export async function launchPi(request: AgentRequest, env: NodeJS.ProcessEnv): Promise<ProcessSpec> {
    assertLaunch(request);
    if (request.resumeSessionId)
        throw new Error('pi: native resume is unsupported');
    if (request.mode !== 'gateway')
        throw new Error('pi: only gateway execution is supported');
    if (request.mcpServers && Object.keys(request.mcpServers).length > 0)
        throw new Error('pi: MCP servers are not supported');
    const gatewayToken = env[GATEWAY_TOKEN_ENV]?.trim();
    if (!gatewayToken)
        throw new Error(`pi: a gateway launch requires ${GATEWAY_TOKEN_ENV}`);
    const status = await findExecutable(['pi'], { env });
    if (status.installation.state !== 'installed')
        throw new Error('pi is not installed');
    const ownedHome = await createOwnedClientRunHome(env, 'pi');
    try {
        const modelsPath = join(ownedHome.path, 'models.json');
        const baseUrl = gatewayChatBaseUrl(env);
        const modelsConfig = piModelsConfig(request, baseUrl);
        const model = request.model.trim();
        const args = [
            '--mode', 'json',
            '--no-session',
            '--provider', 'wrenyard',
            '--model', model,
            '--no-extensions',
            '--no-skills',
            '--no-prompt-templates',
            '--no-themes',
            '--no-approve',
            '--no-mcp',
        ];
        return {
            executable: status.installation.executable,
            args,
            stdin: request.prompt,
            cwd: request.cwd,
            env: stringEnv(env, {
                PI_CODING_AGENT_DIR: ownedHome.path,
                [GATEWAY_TOKEN_ENV]: gatewayToken,
            }),
            files: [{ path: modelsPath, data: modelsConfig, cleanup: 'completion' }],
            ownedRunHome: ownedHome,
        };
    } catch (error) {
        await rm(ownedHome.path, { recursive: true, force: true }).catch(() => undefined);
        throw error;
    }
}
