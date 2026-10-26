import { cp, mkdir, readdir, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentRequest } from '@wrenyard/agent-client';
import { claudeFamilyMcpConfig, resolveMcpServers } from '@wrenyard/agent-client/mcp';
import { assertLaunch, clientStateDirForEnv, createOwnedClientRunHome, preserveClientRunHomeSessionSnapshot, stringEnv } from '@wrenyard/agent-client/native';
import type { ProcessSpec } from '@wrenyard/execution';
import { registerRunHomeSessionPreserveSlot } from './session-preserve.ts';

export async function launchCodeBuddy(request: AgentRequest, env: NodeJS.ProcessEnv, executable: string): Promise<ProcessSpec> {
    assertLaunch(request);
    // The mapped wire effort is mandatory here: CodeBuddy has no default level
    // and a run must never silently drop effort. It is carried per invocation
    // through `--settings`, never written into any persistent user config.
    if (!request.clientReasoningEffort)
        throw new Error('codebuddy requires a mapped reasoning effort');
    const ownedHome = await createOwnedClientRunHome(env, 'codebuddy');
    try {
    const preserveSlot = { snapshotDir: ownedHome.path, sessionId: '', preserveTo: '' };
    const executionId = request.executionId?.trim();
    if (executionId) registerRunHomeSessionPreserveSlot(executionId, preserveSlot);
    ownedHome.preserveSession = async (homePath, context) => {
        if (context?.success) return;
        if (!preserveSlot.sessionId) return;
        await preserveClientRunHomeSessionSnapshot(env, ownedHome, homePath, preserveSlot.sessionId);
    };
    const sharedProjects = clientStateDirForEnv(env, 'codebuddy', 'agent-config', 'projects');
    await mkdir(sharedProjects, { recursive: true });
    await symlink(sharedProjects, join(ownedHome.path, 'projects'), 'dir');
    if (request.resumeSessionId) {
        const snapshot = clientStateDirForEnv(env, 'codebuddy', 'sessions', request.resumeSessionId);
        try {
            const entries = await readdir(snapshot, { withFileTypes: true });
            for (const entry of entries) {
                if (entry.name === 'projects') continue;
                await cp(join(snapshot, entry.name), join(ownedHome.path, entry.name), {
                    recursive: true,
                    force: false,
                    verbatimSymlinks: true,
                });
            }
        }
        catch {
            /* no snapshot yet: --resume may still attach to an empty config dir */
        }
    }
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
            CODEBUDDY_CONFIG_DIR: ownedHome.path,
            WORKBUDDY_CONFIG_DIR: '',
            CODEBUDDY_DISABLE_FILE_LOGS: '1',
            DISABLE_AUTOUPDATER: '1',
            DISABLE_TELEMETRY: '1',
            DISABLE_ERROR_REPORTING: '1',
        }),
        ownedRunHome: ownedHome,
        stdin: JSON.stringify({ type: 'user', message: { role: 'user', content: request.prompt }, parent_tool_use_id: null }) + '\n',
    };
    } catch (error) {
        await rm(ownedHome.path, { recursive: true, force: true }).catch(() => undefined);
        throw error;
    }
}
