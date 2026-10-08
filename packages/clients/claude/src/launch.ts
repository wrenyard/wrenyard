import { findExecutable, type AgentRequest } from '@wrenyard/agent-client';
import { claudeFamilyMcpConfig, resolveMcpServers } from '@wrenyard/agent-client/mcp';
import { assertLaunch, clientStateDir, stringEnv } from '@wrenyard/agent-client/native';
import type { ProcessSpec } from '@wrenyard/execution';

export async function launchClaude(request: AgentRequest, env: NodeJS.ProcessEnv): Promise<ProcessSpec> {
    assertLaunch(request);
    if (!request.clientReasoningEffort && !request.clientReasoningEnvironment)
        throw new Error('claude: launch requires mapped effort or thinking-budget settings');
    const status = await findExecutable(['claude'], { env });
    if (status.installation.state !== 'installed')
        throw new Error('claude is not installed');
    const args = ['--dangerously-skip-permissions', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--replay-user-messages', '--include-partial-messages', '--model', request.model];
    if (request.resumeSessionId)
        args.push('--resume', request.resumeSessionId);
    // MCP servers ride immediately before the terminal -p prompt flag.
    const mcpConfig = claudeFamilyMcpConfig(resolveMcpServers(request.mcpServers));
    if (mcpConfig)
        args.push('--strict-mcp-config', '--mcp-config', mcpConfig);
    args.push('-p');
    return {
        executable: status.installation.executable,
        args,
        cwd: request.cwd,
        env: stringEnv({ ...env, CLAUDE_CODE_EFFORT_LEVEL: undefined, MAX_THINKING_TOKENS: undefined }, {
            CLAUDE_CONFIG_DIR: clientStateDir('claude'),
            ...request.clientReasoningEnvironment,
            // The mapped wire effort rides the per-launch environment so it is
            // scoped to this run and never written into persistent config.
            ...(request.clientReasoningEffort ? { CLAUDE_CODE_EFFORT_LEVEL: request.clientReasoningEffort } : {}),
            ...(request.mode === 'gateway' && env.WRENYARD_GATEWAY_TOKEN ? {
                ANTHROPIC_BASE_URL: env.WRENYARD_GATEWAY_ANTHROPIC_URL ?? '',
                ANTHROPIC_AUTH_TOKEN: env.WRENYARD_GATEWAY_TOKEN,
                ANTHROPIC_API_KEY: env.WRENYARD_GATEWAY_TOKEN,
                ANTHROPIC_MODEL: request.model,
            } : {}),
        }),
        stdin: JSON.stringify({ type: 'user', message: { role: 'user', content: request.prompt }, parent_tool_use_id: null }) + '\n',
    };
}
