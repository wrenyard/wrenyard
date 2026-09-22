import { cp, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentRequest } from '@wrenyard/agent-client';
import { resolveMcpServers, requireHttpServer, type ResolvedMcpServer } from '@wrenyard/agent-client/mcp';
import { assertLaunch, clientStateDir, stringEnv } from '@wrenyard/agent-client/native';
import type { ProcessSpec } from '@wrenyard/execution';
import { inspectGrok } from './installation.ts';

/**
 * Render the `[mcp_servers.<name>]` TOML tree for the requested HTTP MCP
 * servers. All servers share one parent table so the generated config never
 * declares a duplicate `[mcp_servers]` key, which Grok rejects. A server whose
 * transport is not HTTP is rejected: Grok's config dialect only carries URL
 * MCP servers.
 */
function grokMcpToml(servers: readonly ResolvedMcpServer[]): string {
    if (servers.length === 0)
        return '';
    const lines: string[] = ['', '[mcp_servers]'];
    for (const { name, server } of servers) {
        const http = requireHttpServer(name, server);
        if (!/^https?:\/\//u.test(http.url))
            throw new Error(`MCP server ${JSON.stringify(name)} has an unsupported url scheme; Grok accepts only http or https`);
        lines.push(`[mcp_servers.${tomlKey(name)}]`, `url = ${tomlString(http.url)}`, 'enabled = true');
        const headers = http.headers ?? {};
        if (Object.keys(headers).length > 0) {
            lines.push('[mcp_servers.' + tomlKey(name) + '.headers]');
            for (const key of Object.keys(headers).sort())
                lines.push(`${tomlKey(key)} = ${tomlString(headers[key])}`);
        }
    }
    return lines.join('\n') + '\n';
}

/**
 * Build the `--allow MCPTool(<name>__*)` pairs that let a headless Grok run
 * invoke the injected MCP tools without an interactive prompt. Names are
 * validated against the character set Grok can parse in an MCPTool rule and
 * emitted in sorted order for determinism.
 */
function grokMcpPermissionArgs(servers: readonly ResolvedMcpServer[]): string[] {
    if (servers.length === 0)
        return [];
    const args: string[] = [];
    for (const name of servers.map((entry) => entry.name).sort()) {
        if (!/^[A-Za-z0-9._-]+$/u.test(name))
            throw new Error(`MCP server name ${JSON.stringify(name)} contains characters Grok cannot encode in an MCPTool rule`);
        args.push('--allow', `MCPTool(${name}__*)`);
    }
    return args;
}

/** A bare TOML key when it is a plain identifier; otherwise a quoted key. */
function tomlKey(value: string): string {
    return /^[A-Za-z0-9_-]+$/u.test(value) ? value : tomlString(value);
}

/** A TOML basic string literal. */
function tomlString(value: string): string {
    return JSON.stringify(value);
}

export async function launchGrok(request: AgentRequest, env: NodeJS.ProcessEnv): Promise<ProcessSpec> {
    assertLaunch(request);
    const status = await inspectGrok({ env });
    if (status.installation.state !== 'installed')
        throw new Error('grok is not installed');
    const mcpServers = resolveMcpServers(request.mcpServers);
    // Resolve transports before any side effect so an unsupported server never
    // leaves an isolated home behind.
    const mcpToml = grokMcpToml(mcpServers);
    const mcpPermissionArgs = grokMcpPermissionArgs(mcpServers);
    const home = clientStateDir('grok', 'runs', `${Date.now().toString(36)}`);
    await mkdir(home, { recursive: true });
    if (request.resumeSessionId) {
        const snapshot = clientStateDir('grok', 'sessions', request.resumeSessionId);
        try {
            await cp(snapshot, home, { recursive: true, force: false });
        }
        catch {
            throw new Error(`native Grok resume snapshot for session ${request.resumeSessionId} was not found`);
        }
    }
    else if (request.mode !== 'gateway') {
        const userHome = join(homedir(), '.grok');
        try {
            await cp(userHome, home, { recursive: true, force: false });
        }
        catch { /* a fresh home still receives the prompt and model config */ }
    }
    const promptPath = join(home, 'prompt.txt');
    const gateway = env.WRENYARD_GATEWAY_OPENAI_CHAT_URL?.replace(/\/chat\/completions$/u, '');
    const modelId = request.mode === 'gateway' && request.provider
        ? `wrenyard-${request.provider}--${request.model.replace(/[^A-Za-z0-9_]/gu, '-')}`
        : request.model;
    const config = (request.mode === 'gateway' && gateway
        ? `models.default = ${JSON.stringify(modelId)}\n[model.${JSON.stringify(modelId).slice(1, -1)}]\nname = "Wrenyard"\nmodel = ${JSON.stringify(request.model)}\nbase_url = ${JSON.stringify(gateway)}\nenv_key = "WRENYARD_GATEWAY_TOKEN"\napi_backend = "chat_completions"\nsupports_backend_search = false\n`
        : '') + mcpToml;
    const args = ['--permission-mode', 'bypassPermissions', '--always-approve', ...mcpPermissionArgs, '--model', modelId];
    if (request.thinking)
        args.push('--reasoning-effort', request.thinking);
    if (request.resumeSessionId)
        args.push('--resume', request.resumeSessionId);
    args.push('--output-format', 'streaming-json', '--prompt-file', promptPath);
    return {
        executable: status.installation.executable,
        args,
        cwd: request.cwd,
        env: stringEnv(env, { GROK_HOME: home, GROK_MODEL: modelId }),
        files: [
            { path: promptPath, data: request.prompt, cleanup: 'completion' },
            ...(config ? [{ path: join(home, 'config.toml'), data: config, cleanup: 'completion' as const }] : []),
        ],
    };
}
