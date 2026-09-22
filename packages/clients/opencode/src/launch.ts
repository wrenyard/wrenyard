import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { findExecutable, type AgentRequest } from '@wrenyard/agent-client';
import { resolveMcpServers, type ResolvedMcpServer } from '@wrenyard/agent-client/mcp';
import { assertLaunch, clientStateDir, stringEnv } from '@wrenyard/agent-client/native';
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
    const home = clientStateDir('opencode', session);
    const configPath = join(home, 'opencode.json');
    const gateway = env.WRENYARD_GATEWAY_OPENAI_CHAT_URL;
    const base = request.mode === 'gateway' && gateway
        ? { provider: { wrenyard: { npm: '@ai-sdk/openai-compatible', name: 'Wrenyard', models: { [request.model]: { id: request.model } }, options: { baseURL: gateway, apiKey: '{env:WRENYARD_GATEWAY_TOKEN}', headers: { 'x-opencode-session': session } } } } }
        : { model: request.model };
    const mcp = openCodeMcpConfig(resolveMcpServers(request.mcpServers));
    const config = JSON.stringify(mcp ? { ...base, mcp } : base);
    const args = ['run'];
    if (request.resumeSessionId)
        args.push('--session', request.resumeSessionId);
    args.push('-m', request.mode === 'gateway' ? `wrenyard/${request.model}` : request.model, '--title', 'Wrenyard task', '--format', 'json', '--pure', request.prompt);
    return {
        executable: status.installation.executable,
        args,
        cwd: request.cwd,
        env: stringEnv(env, {
            XDG_CONFIG_HOME: home,
            OPENCODE_CONFIG_DIR: home,
            OPENCODE_CONFIG: configPath,
            OPENCODE_DISABLE_PROJECT_CONFIG: 'true',
        }),
        files: [{ path: configPath, data: config + '\n', cleanup: 'completion' }],
    };
}
