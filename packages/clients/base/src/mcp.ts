import type { McpServer } from './index.ts';

/**
 * Client-agnostic MCP launch helpers. A client launch reads the typed
 * `mcpServers` map it was handed and encodes it into whatever native surface it
 * owns; these helpers only normalize the neutral input so every client sees the
 * same deterministic ordering and fails on the same invalid shapes.
 */

/**
 * One resolved MCP server: the exposed name plus its neutral transport
 * definition. Ordering is by server name so independently-built launch
 * arguments (and their tests) are deterministic.
 */
export interface ResolvedMcpServer {
    readonly name: string;
    readonly server: McpServer;
}

/**
 * Resolve the request's MCP servers into a name-sorted list, validating each
 * entry before any side effect. A blank name or a server missing its
 * transport-defining field is rejected loudly; nothing is silently dropped.
 * Returns an empty list when no servers were requested.
 */
export function resolveMcpServers(servers: Readonly<Record<string, McpServer>> | undefined): readonly ResolvedMcpServer[] {
    if (!servers)
        return [];
    const resolved: ResolvedMcpServer[] = [];
    for (const name of Object.keys(servers).sort()) {
        const trimmed = name.trim();
        if (!/^[A-Za-z0-9_-]{1,32}$/.test(name))
            throw new Error('MCP server name must contain 1–32 letters, digits, underscores or hyphens');
        const server = servers[name];
        if (server.transport === 'stdio') {
            if (!server.command.trim())
                throw new Error(`MCP server ${JSON.stringify(trimmed)} has no command`);
        }
        else if (server.transport === 'http') {
            if (!server.url.trim())
                throw new Error(`MCP server ${JSON.stringify(trimmed)} has no url`);
        }
        else {
            throw new Error(`MCP server ${JSON.stringify(trimmed)} has an unsupported transport`);
        }
        resolved.push({ name: trimmed, server });
    }
    return resolved;
}

/** Reject a requested server whose transport the client family cannot represent. */
export function requireHttpServer(name: string, server: McpServer): Extract<McpServer, { transport: 'http' }> {
    if (server.transport !== 'http')
        throw new Error(`MCP server ${JSON.stringify(name)} uses the ${server.transport} transport, which this client does not support`);
    return server;
}

/**
 * Render the Claude-family `--mcp-config` JSON document (used verbatim by both
 * the `claude` and `codebuddy` clients). A stdio server carries a command with
 * optional args/env; an HTTP server carries `type: http` and a url. Returns
 * undefined when there is nothing to inject so the flag pair is omitted.
 */
export function claudeFamilyMcpConfig(servers: readonly ResolvedMcpServer[]): string | undefined {
    if (servers.length === 0)
        return undefined;
    const mcpServers: Record<string, unknown> = {};
    for (const { name, server } of servers) {
        if (server.transport === 'http') {
            mcpServers[name] = { type: 'http', url: server.url, ...(server.headers ? { headers: { ...server.headers } } : {}) };
            continue;
        }
        if (server.cwd) throw new Error('Claude-family MCP configuration does not support a per-server cwd');
        mcpServers[name] = {
            command: server.command,
            ...(server.args && server.args.length > 0 ? { args: [...server.args] } : {}),
            ...(server.env && Object.keys(server.env).length > 0 ? { env: { ...server.env } } : {}),
        };
    }
    return JSON.stringify({ mcpServers });
}
