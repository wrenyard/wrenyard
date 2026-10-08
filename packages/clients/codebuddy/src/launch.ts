import type { AgentRequest } from '@wrenyard/agent-client';
import { claudeFamilyMcpConfig, resolveMcpServers } from '@wrenyard/agent-client/mcp';
import { assertLaunch, clientStateDir, stringEnv } from '@wrenyard/agent-client/native';
import type { ProcessSpec } from '@wrenyard/execution';

export async function launchCodeBuddy(request: AgentRequest, env: NodeJS.ProcessEnv, executable: string): Promise<ProcessSpec> {
    assertLaunch(request);
    // The mapped wire effort is mandatory here: CodeBuddy has no default level
    // and a run must never silently drop effort. It is carried per invocation
    // through `--settings`, never written into any persistent user config.
    if (!request.clientReasoningEffort)
        throw new Error('codebuddy requires a mapped reasoning effort');
    const args = ['-y', '--input-format', 'stream-json', '--output-format', 'stream-json', '--replay-user-messages', '--include-partial-messages', '--model', request.model];
    if (request.resumeSessionId)
        args.push('--resume', request.resumeSessionId);
    // CodeBuddy shares the Claude-family MCP dialect: strict config + JSON
    // payload immediately before the terminal -p prompt flag.
    const mcpConfig = claudeFamilyMcpConfig(resolveMcpServers(request.mcpServers));
    if (mcpConfig)
        args.push('--strict-mcp-config', '--mcp-config', mcpConfig);
    // The per-run settings JSON carries only the mapped effort, so the flag is
    // scoped to this invocation and never mutates persistent CodeBuddy config.
    args.push('--settings', JSON.stringify({ reasoningEffort: request.clientReasoningEffort }), '-p');
    return {
        executable,
        args,
        cwd: request.cwd,
        env: stringEnv(env, {
            CODEBUDDY_CONFIG_DIR: clientStateDir('codebuddy', 'agent-config'),
            DISABLE_AUTOUPDATER: '1',
            DISABLE_TELEMETRY: '1',
            DISABLE_ERROR_REPORTING: '1',
        }),
        stdin: JSON.stringify({ type: 'user', message: { role: 'user', content: request.prompt }, parent_tool_use_id: null }) + '\n',
    };
}
