import { constants } from 'node:fs';
import { access, copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { findExecutable, type AgentRequest } from '@wrenyard/agent-client';
import { resolveMcpServers, type ResolvedMcpServer } from '@wrenyard/agent-client/mcp';
import { assertLaunch, clientStateDirForEnv, createOwnedClientRunHome, stringEnv } from '@wrenyard/agent-client/native';
import type { ProcessSpec } from '@wrenyard/execution';

const GATEWAY_CHAT_URL_ENV = 'WRENYARD_GATEWAY_OPENAI_CHAT_URL';
const GATEWAY_TOKEN_ENV = 'WRENYARD_GATEWAY_TOKEN';
const MCP_EXTENSION_PACKAGE = 'npm:pi-mcp-extension@1.5.0';

function gatewayChatBaseUrl(env: NodeJS.ProcessEnv): string {
    const raw = env[GATEWAY_CHAT_URL_ENV]?.trim();
    if (!raw)
        throw new Error(`pi: a gateway launch requires ${GATEWAY_CHAT_URL_ENV}`);
    return raw.replace(/\/chat\/completions\/?$/i, '');
}

function piModelsConfig(request: AgentRequest, baseUrl: string): string {
    const model = request.model.trim();
    if (!request.provider)
        throw new Error('pi: a gateway launch requires a resolved provider');
    const config = {
        providers: {
            wrenyard: {
                baseUrl,
                api: 'openai-completions',
                // Pi resolves a bare name as an environment variable; ${...} would be sent literally.
                apiKey: GATEWAY_TOKEN_ENV,
                authHeader: true,
                headers: {
                    'x-wrenyard-provider': request.provider,
                    'x-wrenyard-reasoning-effort': request.reasoningEffort,
                },
                models: [{ id: model, name: model }],
            },
        },
    };
    return JSON.stringify(config, null, 2) + '\n';
}

function piUserAgentDir(env: NodeJS.ProcessEnv): string {
    const base = env.HOME?.trim() || env.USERPROFILE?.trim() || homedir();
    return join(base, '.pi', 'agent');
}

function piMcpDocument(servers: readonly ResolvedMcpServer[]): string {
    const mcpServers: Record<string, unknown> = {};
    for (const { name, server } of servers) {
        if (server.transport === 'http') {
            mcpServers[name] = {
                transport: 'streamable-http',
                url: server.url,
                ...(server.headers && Object.keys(server.headers).length > 0 ? { headers: { ...server.headers } } : {}),
            };
            continue;
        }
        if (server.cwd)
            throw new Error('Pi MCP configuration does not support a per-server cwd');
        mcpServers[name] = {
            command: server.command,
            transport: 'stdio',
            ...(server.args && server.args.length > 0 ? { args: [...server.args] } : {}),
            ...(server.env && Object.keys(server.env).length > 0 ? { env: { ...server.env } } : {}),
        };
    }
    return JSON.stringify({ mcpServers }, null, 2) + '\n';
}

function packageSourceIdentity(entry: unknown): string | undefined {
    if (typeof entry === 'string')
        return entry;
    if (entry !== null && typeof entry === 'object' && !Array.isArray(entry)) {
        const source = (entry as Record<string, unknown>).source;
        return typeof source === 'string' ? source : undefined;
    }
    return undefined;
}

function readSettingsObject(raw: string | undefined): Record<string, unknown> {
    if (!raw)
        return {};
    try {
        const parsed: unknown = JSON.parse(raw);
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed))
            return { ...(parsed as Record<string, unknown>) };
    } catch {
        /* ignore invalid settings and merge into a fresh document */
    }
    return {};
}

function piSettingsDocument(existing: Record<string, unknown>, includeMcpExtension: boolean): string {
    const settings = { ...existing };
    if (includeMcpExtension) {
        const packages = Array.isArray(settings.packages) ? [...settings.packages] : [];
        if (!packages.some((entry) => packageSourceIdentity(entry) === MCP_EXTENSION_PACKAGE))
            packages.push(MCP_EXTENSION_PACKAGE);
        settings.packages = packages;
    }
    return JSON.stringify(settings, null, 2) + '\n';
}

async function loadPiSettings(agentDir: string): Promise<Record<string, unknown>> {
    try {
        return readSettingsObject(await readFile(join(agentDir, 'settings.json'), 'utf8'));
    } catch {
        return {};
    }
}

async function writePiSettings(agentDir: string, includeMcpExtension: boolean): Promise<void> {
    const settings = piSettingsDocument(await loadPiSettings(agentDir), includeMcpExtension);
    await writeFile(join(agentDir, 'settings.json'), settings, { encoding: 'utf8', mode: 0o600 });
}

async function ensurePiAuth(agentDir: string, env: NodeJS.ProcessEnv): Promise<void> {
    await mkdir(agentDir, { recursive: true, mode: 0o700 });
    const target = join(agentDir, 'auth.json');
    try {
        await access(target, constants.F_OK);
        return;
    } catch {
        /* import only when the managed agent dir has no auth.json yet */
    }
    try {
        await copyFile(join(piUserAgentDir(env), 'auth.json'), target);
    } catch {
        /* a fresh managed home can still run gateway routes */
    }
}

async function configurePiMcp(agentDir: string, servers: readonly ResolvedMcpServer[]): Promise<void> {
    if (servers.length === 0)
        return;
    await mkdir(agentDir, { recursive: true, mode: 0o700 });
    await writePiSettings(agentDir, true);
    await writeFile(join(agentDir, 'mcp.json'), piMcpDocument(servers), { encoding: 'utf8', mode: 0o600 });
}

function basePiArgs(request: AgentRequest, provider?: string): string[] {
    const model = request.model.trim();
    const args = ['--mode', 'json', '-p', '--model', model];
    if (provider)
        args.push('--provider', provider);
    return args;
}

async function launchPiGateway(
    request: AgentRequest,
    env: NodeJS.ProcessEnv,
    executable: string,
): Promise<ProcessSpec> {
    const gatewayToken = env[GATEWAY_TOKEN_ENV]?.trim();
    if (!gatewayToken)
        throw new Error(`pi: a gateway launch requires ${GATEWAY_TOKEN_ENV}`);
    const ownedHome = await createOwnedClientRunHome(env, 'pi');
    try {
        const modelsPath = join(ownedHome.path, 'models.json');
        const baseUrl = gatewayChatBaseUrl(env);
        const modelsConfig = piModelsConfig(request, baseUrl);
        const mcpServers = resolveMcpServers(request.mcpServers);
        const files: ProcessSpec['files'] = [
            { path: modelsPath, data: modelsConfig, cleanup: 'completion' },
            ...(mcpServers.length > 0
                ? [
                    { path: join(ownedHome.path, 'settings.json'), data: piSettingsDocument({}, true), cleanup: 'completion' as const },
                    { path: join(ownedHome.path, 'mcp.json'), data: piMcpDocument(mcpServers), cleanup: 'completion' as const },
                ]
                : []),
        ];
        const sessionsDir = clientStateDirForEnv(env, 'pi', 'sessions');
        await mkdir(sessionsDir, { recursive: true, mode: 0o700 });
        const args = [
            ...basePiArgs(request, 'wrenyard'),
            '--session-dir', sessionsDir,
            '--no-skills',
            '--no-prompt-templates',
            '--no-themes',
            ...(mcpServers.length === 0 ? ['--no-extensions'] as const : []),
            ...(request.resumeSessionId ? ['--session', request.resumeSessionId] as const : []),
        ];
        return {
            executable,
            args,
            stdin: request.prompt,
            cwd: request.cwd,
            env: stringEnv(env, {
                PI_CODING_AGENT_DIR: ownedHome.path,
                [GATEWAY_TOKEN_ENV]: gatewayToken,
            }),
            files,
            ownedRunHome: ownedHome,
        };
    } catch (error) {
        await rm(ownedHome.path, { recursive: true, force: true }).catch(() => undefined);
        throw error;
    }
}

async function launchPiNative(
    request: AgentRequest,
    env: NodeJS.ProcessEnv,
    executable: string,
): Promise<ProcessSpec> {
    const agentDir = clientStateDirForEnv(env, 'pi', 'agent');
    const sessionsDir = clientStateDirForEnv(env, 'pi', 'sessions');
    await mkdir(sessionsDir, { recursive: true, mode: 0o700 });
    await ensurePiAuth(agentDir, env);
    const mcpServers = resolveMcpServers(request.mcpServers);
    if (mcpServers.length > 0)
        await configurePiMcp(agentDir, mcpServers);
    const args = [
        ...basePiArgs(request, request.provider),
        '--session-dir', sessionsDir,
        ...(request.resumeSessionId ? ['--session', request.resumeSessionId] as const : []),
    ];
    return {
        executable,
        args,
        stdin: request.prompt,
        cwd: request.cwd,
        env: stringEnv(env, { PI_CODING_AGENT_DIR: agentDir }),
    };
}

export async function launchPi(request: AgentRequest, env: NodeJS.ProcessEnv): Promise<ProcessSpec> {
    assertLaunch(request);
    const status = await findExecutable(['pi'], { env });
    if (status.installation.state !== 'installed')
        throw new Error('pi is not installed');
    if (request.mode === 'gateway')
        return await launchPiGateway(request, env, status.installation.executable);
    return await launchPiNative(request, env, status.installation.executable);
}
