import { randomBytes } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { findExecutable, type AgentRequest } from '@wrenyard/agent-client';
import { resolveMcpServers, type ResolvedMcpServer } from '@wrenyard/agent-client/mcp';
import { assertLaunch, clientStateDirForEnv, createOwnedClientRunHome, stringEnv } from '@wrenyard/agent-client/native';
import type { ProcessSpec } from '@wrenyard/execution';

/**
 * Render the OpenCode `mcp` config block. A stdio server is a `local` entry
 * whose `command` array is the executable followed by its arguments and whose
 * `environment` is the env map; an HTTP server is a `remote` entry with a url
 * and optional headers. Every entry is explicitly enabled.
 */
function openCodeMcpConfig(servers: readonly ResolvedMcpServer[]): Record<string, unknown> | undefined {
    if (servers.length === 0)
        return undefined;
    const mcp: Record<string, unknown> = {};
    for (const { name, server } of servers) {
        if (server.transport === 'http') {
            mcp[name] = {
                type: 'remote',
                url: server.url,
                ...(server.headers && Object.keys(server.headers).length > 0 ? { headers: { ...server.headers } } : {}),
                enabled: true,
            };
            continue;
        }
        if (server.cwd) throw new Error('OpenCode MCP configuration does not support a per-server cwd');
        mcp[name] = {
            type: 'local',
            command: [server.command, ...(server.args ?? [])],
            ...(server.env && Object.keys(server.env).length > 0 ? { environment: { ...server.env } } : {}),
            enabled: true,
        };
    }
    return mcp;
}

export async function launchOpenCode(request: AgentRequest, env: NodeJS.ProcessEnv): Promise<ProcessSpec> {
    assertLaunch(request);
    const status = await findExecutable(['opencode'], { env });
    if (status.installation.state !== 'installed')
        throw new Error('opencode is not installed');
    const session = request.resumeSessionId || randomBytes(16).toString('hex');
    const ownedHome = await createOwnedClientRunHome(env, 'opencode');
    try {
    const configPath = join(ownedHome.path, 'opencode.json');
    // Stable per-client config discovery root, shared by every run so OpenCode
    // installs its plugin dependency tree once instead of once per run. It
    // holds no run-specific values; those stay in the per-run `configPath`.
    const sharedConfigHome = clientStateDirForEnv(env, 'opencode', 'config');
    const gateway = request.protocol === 'anthropic_messages'
        ? env.WRENYARD_GATEWAY_ANTHROPIC_URL
        : env.WRENYARD_GATEWAY_OPENAI_CHAT_URL;
    // The variant key is the mapped wire effort; `--variant` selects it and the
    // model config binds that variant to the exact reasoning-effort option.
    const variant = request.clientReasoningEffort;
    const model = request.model;
    let selector: string;
    let base: Record<string, unknown>;
    if (request.mode === 'gateway' && gateway) {
        if (!variant)
            throw new Error('opencode: a gateway launch requires a mapped reasoning effort');
        selector = `wrenyard/${model}`;
        base = {
            provider: {
                wrenyard: {
                    npm: request.protocol === 'anthropic_messages' ? '@ai-sdk/anthropic' : '@ai-sdk/openai-compatible',
                    name: 'Wrenyard',
                    models: { [model]: { id: model, variants: { [variant]: { reasoningEffort: variant } } } },
                    options: {
                        baseURL: gateway,
                        apiKey: '{env:WRENYARD_GATEWAY_TOKEN}',
                        headers: {
                            'x-opencode-session': session,
                            // The Gateway owns effort conversion: it reads this
                            // public-level header and overwrites any erroneous
                            // reasoning-effort field the client
                            // writes into the request body.
                            'x-wrenyard-reasoning-effort': request.reasoningEffort,
                        },
                    },
                },
            },
        };
    }
    else if (request.provider === 'opencode-zen') {
        // The genuine OpenCode client owns Zen transport: select its built-in
        // `opencode` provider and bind the model to the variant that materializes
        // the mapped effort. Only config is overlaid here, so the persistent
        // OpenCode credential location (XDG data home) is left untouched.
        selector = `opencode/${model}`;
        base = {
            model: selector,
            provider: {
                opencode: {
                    models: { [model]: variant ? { variants: { [variant]: { reasoningEffort: variant } } } : {} },
                },
            },
        };
    }
    else {
        selector = model;
        base = { model };
    }
    const mcp = openCodeMcpConfig(resolveMcpServers(request.mcpServers));
    const config = JSON.stringify(mcp ? { ...base, mcp } : base);
    const args = ['run'];
    if (request.resumeSessionId)
        args.push('--session', request.resumeSessionId);
    if (variant)
        args.push('--variant', variant);
    args.push('-m', selector, '--title', 'Wrenyard task', '--format', 'json', '--pure', request.prompt);
    return {
        executable: status.installation.executable,
        args,
        // The prompt travels in argv above; stdin is deliberately an empty
        // string so the execution engine writes and immediately closes the
        // unused pipe, sending EOF instead of leaving OpenCode waiting on it.
        stdin: '',
        cwd: request.cwd,
        env: stringEnv(env, {
            // Both config discovery roots resolve to the same stable shared
            // directory (`sharedConfigHome/opencode`, under WRENYARD_STATE_HOME)
            // so plugin dependency installation is shared across runs: OpenCode
            // appends `opencode` to XDG_CONFIG_HOME, matching OPENCODE_CONFIG_DIR.
            // The per-run values (provider credentials, model, MCP servers)
            // travel only in `configPath`; native data/state roots are left
            // untouched so resume keeps working.
            XDG_CONFIG_HOME: sharedConfigHome,
            OPENCODE_CONFIG_DIR: join(sharedConfigHome, 'opencode'),
            OPENCODE_CONFIG: configPath,
            OPENCODE_DISABLE_PROJECT_CONFIG: 'true',
        }),
        files: [{ path: configPath, data: config + '\n', cleanup: 'completion' }],
        ownedRunHome: ownedHome,
    };
    } catch (error) {
        await rm(ownedHome.path, { recursive: true, force: true }).catch(() => undefined);
        throw error;
    }
}
