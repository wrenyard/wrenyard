import { findExecutable, type AgentRequest } from '@wrenyard/agent-client';
import { resolveMcpServers } from '@wrenyard/agent-client/mcp';
import { assertLaunch, stringEnv } from '@wrenyard/agent-client/native';
import type { ProcessSpec } from '@wrenyard/execution';

/**
 * The installed Cursor Agent CLI exposes no command-line MCP injection surface,
 * and its only MCP configuration is a project/user config file that a launch
 * must not write into the caller's working directory. Rather than guess a flag
 * or silently drop servers, a request that carries any MCP server is rejected
 * loudly before the process is started.
 */
function assertNoRequestedMcpServers(request: AgentRequest): void {
    const servers = resolveMcpServers(request.mcpServers);
    if (servers.length === 0)
        return;
    throw new Error(`cursor: MCP injection is unsupported; requested servers: ${servers.map((entry) => entry.name).join(', ')}`);
}

export async function launchCursor(request: AgentRequest, env: NodeJS.ProcessEnv): Promise<ProcessSpec> {
    assertLaunch(request);
    assertNoRequestedMcpServers(request);
    const status = await findExecutable(['cursor-agent'], { env });
    if (status.installation.state !== 'installed')
        throw new Error('cursor is not installed');
    const args = ['--force', '--sandbox', 'disabled', '-p', '--output-format', 'stream-json', '--stream-partial-output', '--trust', '--model', request.model];
    if (request.resumeSessionId)
        args.push('--resume', request.resumeSessionId);
    return { executable: status.installation.executable, args, cwd: request.cwd, env: stringEnv(env, { CURSOR_MODEL: request.model }), stdin: request.prompt };
}
