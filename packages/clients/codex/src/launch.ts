import type { AgentRequest } from '@wrenyard/agent-client';
import { inspectCodex } from './installation.ts';
import { resolveMcpServers, type ResolvedMcpServer } from '@wrenyard/agent-client/mcp';
import { assertLaunch, stringEnv } from '@wrenyard/agent-client/native';
import type { ProcessSpec } from '@wrenyard/execution';

/**
 * A TOML literal for a string value. The reference encoder used JSON string
 * encoding, which is a valid TOML basic string for every path/env value we
 * project (no control characters are expected from a caller-supplied server).
 */
function tomlLiteral(value: string): string {
    return JSON.stringify(value);
}

/**
 * Build the `-c mcp_servers.<name>.*` overrides Codex accepts before its
 * `app-server` subcommand. A URL server is registered by url alone; a stdio
 * server carries command, args, and sorted env keys. The server name comes from
 * the caller and is used verbatim as the TOML key segment.
 */
function codexMcpArgs(servers: readonly ResolvedMcpServer[]): string[] {
    const args: string[] = [];
    for (const { name, server } of servers) {
        const prefix = `mcp_servers.${name}`;
        if (server.transport === 'http') {
            args.push('-c', `${prefix}.url=${tomlLiteral(server.url)}`);
            for (const [key, value] of Object.entries(server.headers ?? {}))
                args.push('-c', `${prefix}.http_headers.${tomlLiteral(key)}=${tomlLiteral(value)}`);
            continue;
        }
        args.push('-c', `${prefix}.command=${tomlLiteral(server.command)}`);
        args.push('-c', `${prefix}.args=${JSON.stringify(server.args ?? [])}`);
        if (server.cwd)
            args.push('-c', `${prefix}.cwd=${tomlLiteral(server.cwd)}`);
        const env = server.env ?? {};
        for (const key of Object.keys(env).sort())
            args.push('-c', `${prefix}.env.${tomlLiteral(key)}=${tomlLiteral(env[key])}`);
    }
    return args;
}

export async function launchCodex(request: AgentRequest, env: NodeJS.ProcessEnv): Promise<ProcessSpec> {
    assertLaunch(request);
    const status = await inspectCodex({ env });
    if (status.installation.state !== 'installed')
        throw new Error('codex is not installed');
    const args: string[] = [];
    const gateway = request.mode === 'gateway' ? env.WRENYARD_GATEWAY_OPENAI_RESPONSES_URL?.trim() : undefined;
    if (gateway) {
        args.push(
            '-c', 'model_provider="wrenyard"',
            '-c', 'model_providers.wrenyard.name="Wrenyard"',
            '-c', `model_providers.wrenyard.base_url=${JSON.stringify(gateway)}`,
            '-c', 'model_providers.wrenyard.env_key="WRENYARD_GATEWAY_TOKEN"',
            '-c', 'model_providers.wrenyard.wire_api="responses"',
        );
    }
    if (request.thinking)
        args.push('-c', `model_reasoning_effort=${JSON.stringify(request.thinking)}`);
    // MCP servers are registered as -c overrides ahead of the app-server bridge.
    args.push(...codexMcpArgs(resolveMcpServers(request.mcpServers)));
    args.push('app-server', '--stdio');
    return { executable: status.installation.executable, args, cwd: request.cwd, env: stringEnv(env, { CODEX_MODEL: request.model }) };
}
