import { appendFile, cp, readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentRequest } from '@wrenyard/agent-client';
import { resolveMcpServers, requireHttpServer, type ResolvedMcpServer } from '@wrenyard/agent-client/mcp';
import { assertLaunch, clientStateDirForEnv, createOwnedClientRunHome, stringEnv } from '@wrenyard/agent-client/native';
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

/**
 * Discover the newest native session id under a Grok run home. Grok stores
 * sessions as `<home>/sessions/<encoded-cwd>/<session-id>` directories; the
 * newest entry by mtime is the id `--resume` accepts. Returns `undefined`
 * when the run home has no session tree yet or cannot be read.
 */
export async function findGrokSessionIdInHome(home: string): Promise<string | undefined> {
    const sessionsDir = join(home, 'sessions');
    let cwdDirs: string[];
    try {
        cwdDirs = await readdir(sessionsDir);
    }
    catch {
        return undefined;
    }
    let newest: { id: string; mtimeMs: number } | undefined;
    for (const cwdDir of cwdDirs) {
        const parent = join(sessionsDir, cwdDir);
        let entries: string[];
        try {
            entries = await readdir(parent);
        }
        catch {
            continue;
        }
        for (const entry of entries) {
            let mtimeMs: number;
            try {
                const info = await stat(join(parent, entry));
                if (!info.isDirectory())
                    continue;
                mtimeMs = info.mtimeMs;
            }
            catch {
                continue;
            }
            if (newest === undefined || mtimeMs > newest.mtimeMs)
                newest = { id: entry, mtimeMs };
        }
    }
    return newest?.id;
}

/**
 * Find the newest Grok run home under the shared runs directory that carries
 * a native session directory for `sessionId`. Returns `undefined` when no run
 * home contains it or the runs directory cannot be read.
 */
async function findGrokRunHomeWithSession(env: NodeJS.ProcessEnv, sessionId: string): Promise<string | undefined> {
    const runsDir = clientStateDirForEnv(env, 'grok', 'runs');
    let runDirs: string[];
    try {
        runDirs = await readdir(runsDir);
    }
    catch {
        return undefined;
    }
    let newest: { path: string; mtimeMs: number } | undefined;
    for (const runDir of runDirs) {
        const home = join(runsDir, runDir);
        const sessionsDir = join(home, 'sessions');
        let cwdDirs: string[];
        try {
            cwdDirs = await readdir(sessionsDir);
        }
        catch {
            continue;
        }
        for (const cwdDir of cwdDirs) {
            const candidate = join(sessionsDir, cwdDir, sessionId);
            try {
                const info = await stat(candidate);
                if (!info.isDirectory())
                    continue;
                if (newest === undefined || info.mtimeMs > newest.mtimeMs)
                    newest = { path: home, mtimeMs: info.mtimeMs };
            }
            catch {
                continue;
            }
        }
    }
    return newest?.path;
}

const interruptedToolResultContent = '[interrupted: previous run was killed before this tool completed]';

/**
 * Append synthetic `tool_result` lines for assistant tool calls that never
 * completed before the previous run died. Grok replay would otherwise wait
 * forever on resume. Fails open when the session tree or history is missing.
 */
async function repairInterruptedToolCalls(home: string, sessionId: string): Promise<void> {
    const sessionsDir = join(home, 'sessions');
    let chatHistoryPath: string | undefined;
    try {
        const cwdDirs = await readdir(sessionsDir);
        for (const cwdDir of cwdDirs) {
            const candidate = join(sessionsDir, cwdDir, sessionId, 'chat_history.jsonl');
            try {
                const info = await stat(candidate);
                if (!info.isFile())
                    continue;
                chatHistoryPath = candidate;
                break;
            }
            catch {
                continue;
            }
        }
    }
    catch {
        return;
    }
    if (chatHistoryPath === undefined)
        return;
    let raw: string;
    try {
        raw = await readFile(chatHistoryPath, 'utf8');
    }
    catch {
        return;
    }
    const toolCallIds = new Set<string>();
    const resultIds = new Set<string>();
    for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.length === 0)
            continue;
        let record: unknown;
        try {
            record = JSON.parse(trimmed);
        }
        catch {
            continue;
        }
        if (record === null || typeof record !== 'object')
            continue;
        const entry = record as Record<string, unknown>;
        if (entry.type === 'assistant' && Array.isArray(entry.tool_calls)) {
            for (const toolCall of entry.tool_calls) {
                if (toolCall !== null && typeof toolCall === 'object' && typeof (toolCall as Record<string, unknown>).id === 'string')
                    toolCallIds.add((toolCall as Record<string, unknown>).id as string);
            }
        }
        if (entry.type === 'tool_result' && typeof entry.tool_call_id === 'string')
            resultIds.add(entry.tool_call_id);
    }
    const dangling = [...toolCallIds].filter((id) => !resultIds.has(id));
    if (dangling.length === 0)
        return;
    const suffix = dangling.map((id) => JSON.stringify({
        type: 'tool_result',
        tool_call_id: id,
        content: interruptedToolResultContent,
    })).join('\n') + '\n';
    try {
        await appendFile(chatHistoryPath, suffix, 'utf8');
    }
    catch { /* resume must not fail because repair could not write */ }
}

/**
 * Snapshot a Grok run home so resume data survives settle cleanup. For each
 * session id under `<home>/sessions/<encoded-cwd>/<sessionId>` the whole run
 * home is force-copied to `<sessionsStateDir>/<sessionId>`. A run home with
 * no sessions subtree produced nothing resumable, so the call is a no-op.
 */
export async function preserveGrokSessionSnapshot(sessionsStateDir: string, homePath: string): Promise<void> {
    const sessionsRoot = join(homePath, 'sessions');
    let projectDirs: string[];
    try {
        projectDirs = await readdir(sessionsRoot);
    }
    catch {
        return;
    }
    for (const projectDir of projectDirs) {
        const projectPath = join(sessionsRoot, projectDir);
        let sessionIds: string[];
        try {
            sessionIds = await readdir(projectPath);
        }
        catch {
            continue;
        }
        for (const sessionId of sessionIds)
            await cp(homePath, join(sessionsStateDir, sessionId), { recursive: true, force: true });
    }
}

/**
 * Preflight the gateway `/models` listing for the requested route. This check
 * fails open: any fetch, timeout, parse, or non-JSON error means "unknown",
 * not "rejected". The launch is rejected only when every matching model
 * entry carries a `route_phase` of `open`, which tells us the local gateway
 * circuit would refuse the run before it starts.
 */
async function assertGatewayRouteNotCircuitOpen(gateway: string, request: AgentRequest, env: NodeJS.ProcessEnv): Promise<void> {
    let response: Response;
    try {
        const headers: Record<string, string> = {};
        const token = env.WRENYARD_GATEWAY_TOKEN;
        if (token)
            headers['authorization'] = `Bearer ${token}`;
        if (request.provider)
            headers['x-wrenyard-provider'] = request.provider;
        response = await fetch(`${gateway}/models`, {
            headers,
            signal: AbortSignal.timeout(5_000),
        });
    }
    catch {
        return;
    }
    let body: unknown;
    try {
        body = await response.json();
    }
    catch {
        return;
    }
    if (body === null || typeof body !== 'object' || Array.isArray(body))
        return;
    const data = (body as Record<string, unknown>).data;
    if (!Array.isArray(data))
        return;
    const target = request.canonicalModel?.trim() ?? request.model;
    const matching = data.filter((entry): entry is Record<string, unknown> =>
        entry !== null && typeof entry === 'object' &&
        (entry as Record<string, unknown>).id === target &&
        (request.provider === undefined || (entry as Record<string, unknown>).owned_by === request.provider));
    if (matching.length === 0)
        return;
    if (matching.every((entry) => entry.route_phase === 'open')) {
        const first = matching[0]!;
        const fault = typeof first.fault_kind === 'string' ? first.fault_kind : first.route_state;
        const until = typeof first.route_until === 'string' ? `; retry after ${first.route_until}` : '';
        throw new Error(`Route ${target} is unavailable (fault ${fault}, circuit open)${until}`);
    }
}

export async function launchGrok(request: AgentRequest, env: NodeJS.ProcessEnv): Promise<ProcessSpec> {
    assertLaunch(request);
    if (!request.clientReasoningEffort)
        throw new Error('grok: launch requires a mapped reasoning effort');
    const status = await inspectGrok({ env });
    if (status.installation.state !== 'installed')
        throw new Error('grok is not installed');
    const mcpServers = resolveMcpServers(request.mcpServers);
    // Resolve transports before any side effect so an unsupported server never
    // leaves an isolated home behind.
    const mcpToml = grokMcpToml(mcpServers);
    const mcpPermissionArgs = grokMcpPermissionArgs(mcpServers);
    const owned = await createOwnedClientRunHome(env, 'grok');
    const home = owned.path;
    // Grok resume reads session data from the run home, so before settle
    // cleanup deletes it, snapshot the whole home under each session id the
    // run produced (sessions/<encoded-cwd>/<sessionId>). No sessions subtree
    // means nothing resumable was written, so the hook is a no-op.
    const sessionsStateDir = clientStateDirForEnv(env, 'grok', 'sessions');
    owned.preserveSession = async (homePath: string) => {
        await preserveGrokSessionSnapshot(sessionsStateDir, homePath);
    };
    if (request.resumeSessionId) {
        const snapshot = clientStateDirForEnv(env, 'grok', 'sessions', request.resumeSessionId);
        try {
            await cp(snapshot, home, { recursive: true, force: false });
        }
        catch {
            // The dedicated snapshot may never have been written (e.g. the
            // previous run was killed). Fall back to the newest run home that
            // still holds this session's directory and copy that instead.
            const runHome = await findGrokRunHomeWithSession(env, request.resumeSessionId);
            if (runHome === undefined)
                throw new Error(`native Grok resume snapshot for session ${request.resumeSessionId} was not found`);
            try {
                await cp(runHome, home, { recursive: true, force: false });
            }
            catch {
                throw new Error(`native Grok resume snapshot for session ${request.resumeSessionId} was not found`);
            }
        }
        await repairInterruptedToolCalls(home, request.resumeSessionId);
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
    if (request.mode === 'gateway' && gateway)
        await assertGatewayRouteNotCircuitOpen(gateway, request, env);
    const modelId = request.mode === 'gateway' && request.provider
        ? `wrenyard-${request.provider}--${request.model.replace(/[^A-Za-z0-9_]/gu, '-')}`
        : request.model;
    const gatewayModel = request.mode === 'gateway'
        ? (request.canonicalModel?.trim() ?? request.model)
        : request.model;
    // Grok forwards extra_headers verbatim with each chat-completions request.
    const gatewayHeaders = request.mode === 'gateway'
        ? [
            ...(request.provider ? [`${tomlKey('x-wrenyard-provider')} = ${tomlString(request.provider)}`] : []),
            ...(request.reasoningEffort ? [`${tomlKey('x-wrenyard-reasoning-effort')} = ${tomlString(request.reasoningEffort)}`] : []),
        ]
        : [];
    const gatewayHeadersToml = gatewayHeaders.length > 0
        ? `extra_headers = { ${gatewayHeaders.join(', ')} }\n`
        : '';
    const config = (request.mode === 'gateway' && gateway
        ? `models.default = ${JSON.stringify(modelId)}\n` +
        `models.session_summary = ${JSON.stringify(modelId)}\n` +
        `models.web_search = ${JSON.stringify(modelId)}\n` +
        `models.image_description = ${JSON.stringify(modelId)}\n` +
        `models.prompt_suggestion = ${JSON.stringify(modelId)}\n` +
        `[model.${JSON.stringify(modelId).slice(1, -1)}]\nname = "Wrenyard"\nmodel = ${JSON.stringify(gatewayModel)}\nbase_url = ${JSON.stringify(gateway)}\nenv_key = "WRENYARD_GATEWAY_TOKEN"\napi_backend = "chat_completions"\nsupports_backend_search = false\n${gatewayHeadersToml}`
        : '') + mcpToml;
    const args = ['--permission-mode', 'bypassPermissions', '--always-approve', ...mcpPermissionArgs, '--model', modelId];
    if (request.clientReasoningEffort)
        args.push('--reasoning-effort', request.clientReasoningEffort);
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
        ownedRunHome: owned,
    };
}
