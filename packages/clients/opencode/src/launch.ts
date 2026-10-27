import { randomBytes } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { findExecutable, type AgentRequest } from '@wrenyard/agent-client';
import { resolveMcpServers, type ResolvedMcpServer } from '@wrenyard/agent-client/mcp';
import { assertLaunch, clientStateDirForEnv, createOwnedClientRunHome, stringEnv } from '@wrenyard/agent-client/native';
import type { ProcessSpec } from '@wrenyard/execution';

const RETRY_GUARD_PLUGIN_SOURCE = `export const WrenyardRetryGuard = async ({ client }) => ({
    event: async ({ event }) => {
        if (event.type !== 'session.status' || event.properties?.status?.type !== 'retry')
            return;
        const s = event.properties.status;
        process.stderr.write(JSON.stringify({
            wrenyard_retry: {
                sessionID: event.properties.sessionID,
                attempt: s.attempt,
                message: s.message,
                reason: s.action?.reason,
                next: s.next,
            },
        }) + '\\n');
        await client.session.abort({ path: { id: event.properties.sessionID } });
    },
});
`;

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
                    models: {
                        [model]: {
                            id: model,
                            // Declared input modalities of the resolved model;
                            // text-only when the plan carries no capabilities,
                            // 'image' is never advertised unconditionally.
                            modalities: { input: request.capabilities ?? ['text'] },
                            variants: { [variant]: { reasoningEffort: variant } },
                        },
                    },
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
                            // The Gateway resolves bare model ids to a provider
                            // from this header; without it a model offered by
                            // more than one credentialed provider fails closed.
                            'x-wrenyard-provider': request.provider,
                        },
                    },
                },
            },
            // Every client launches unrestricted, so carry the full permission
            // set (edit, bash, webfetch, and external directories such as /tmp)
            // in the per-run config. This keeps the OpenCode client from
            // auto-rejecting actions outside the task cwd.
            permission: { edit: 'allow', bash: 'allow', webfetch: 'allow', external_directory: 'allow' },
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
            // Every client launches unrestricted; see the gateway-mode base for
            // the rationale behind the permission block.
            permission: { edit: 'allow', bash: 'allow', webfetch: 'allow', external_directory: 'allow' },
        };
    }
    else {
        selector = model;
        base = {
            model,
            // Every client launches unrestricted; see the gateway-mode base for
            // the rationale behind the permission block.
            permission: { edit: 'allow', bash: 'allow', webfetch: 'allow', external_directory: 'allow' },
        };
    }
    const mcp = openCodeMcpConfig(resolveMcpServers(request.mcpServers));
    const config = JSON.stringify(mcp ? { ...base, mcp } : base);
    const configDir = join(sharedConfigHome, 'opencode');
    const pluginDir = join(configDir, 'plugins');
    // OpenCode loads only {plugin,plugins}/*.{ts,js}; a .mjs file is silently ignored.
    const pluginPath = join(pluginDir, 'wrenyard-retry-guard.js');
    await mkdir(pluginDir, { recursive: true, mode: 0o700 });
    const args = ['run'];
    if (request.resumeSessionId)
        args.push('--session', request.resumeSessionId);
    if (variant)
        args.push('--variant', variant);
    args.push('-m', selector, '--title', 'Wrenyard task', '--format', 'json');
    args.push('--dir', request.cwd);
    return {
        executable: status.installation.executable,
        args,
        // The prompt travels on stdin, not in argv: on Windows CreateProcess
        // caps the whole command line at roughly 32k characters, so a large
        // task prompt would fail the spawn itself with ENAMETOOLONG (and other
        // platforms' ARG_MAX can also be exceeded). The execution engine writes
        // the prompt and then immediately closes the pipe, so OpenCode receives
        // the message followed by the EOF it needs.
        stdin: request.prompt,
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
        files: [
            { path: configPath, data: config + '\n', cleanup: 'completion' },
            { path: pluginPath, data: RETRY_GUARD_PLUGIN_SOURCE },
        ],
        ownedRunHome: ownedHome,
    };
    } catch (error) {
        await rm(ownedHome.path, { recursive: true, force: true }).catch(() => undefined);
        throw error;
    }
}
