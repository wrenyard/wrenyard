import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { findExecutable, type AgentRequest } from '@wrenyard/agent-client';
import { resolveMcpServers, type ResolvedMcpServer } from '@wrenyard/agent-client/mcp';
import { assertLaunch, stringEnv } from '@wrenyard/agent-client/native';
import type { ProcessSpec } from '@wrenyard/execution';
import { writeLoaderPatch, type DshMcpServer, type DshModelRoute } from './patch.ts';

/** DSH profile used for a one-shot background agent invocation. */
const DSH_AGENT_PROFILE = 'headless';

/**
 * Wrenyard's single execution mode. DSH permissions are env-carried, never CLI
 * flags, and Wrenyard has exactly one mode: full access.
 */
const DSH_PERMISSION_MODE = 'danger-full-access';

/**
 * Only the Desktop product may deliver asynchronous task results, so only the
 * Desktop DSH composition may opt into nonblocking task dispatch. A background
 * agent invocation must never inherit that flag: if it leaked in from a parent
 * process the task would dispatch asynchronously and no terminal result would
 * ever be delivered back. The flag is explicitly scrubbed below.
 */
const DSH_ASYNC_TASKS_ENV = 'WRENYARD_DESKTOP_ASYNC_TASKS';

/**
 * Gateway endpoint the launch reads for a `gateway` request. Its value is the
 * OpenAI-compatible chat base URL; a trailing `/chat/completions` is stripped
 * because DSH appends the route itself.
 */
const GATEWAY_CHAT_URL_ENV = 'WRENYARD_GATEWAY_OPENAI_CHAT_URL';

/** The single credential name a gateway launch forwards to the child. */
const GATEWAY_TOKEN_ENV = 'WRENYARD_GATEWAY_TOKEN';

export interface DshLaunch {
  /** Fully resolved process spec for @wrenyard/execution. */
  readonly spec: ProcessSpec;
  /**
   * Release the isolated per-run DSH home. Idempotent and safe on success,
   * failure, and cancellation; never throws.
   */
  cleanup(): Promise<void>;
}

/**
 * Resolve one native DSH background-agent invocation.
 *
 * The real `@deepseek-ai/dsh` executable is discovered exactly like
 * `inspectDsh` does (explicit `executable`, then the `WRENYARD_DSH_BIN`
 * compatibility override, then PATH), never a wrapper. The launch materializes
 * an isolated per-run `DSH_HOME` carrying a freshly generated secret-free
 * loader patch (passed last, so it remains the final application layer), then
 * runs the `headless` profile with the task as its single positional argument.
 *
 * The requested model is never dropped. A `gateway` request declares exactly
 * one Wrenyard Gateway provider whose public model id is
 * `<provider>/<canonicalModel>` and whose route is the configured chat base
 * URL; a `native` request declares the selected provider/model against no
 * invented endpoint. Either way the patch selects that same model through
 * `agent-default-model`.
 *
 * Requested MCP servers are projected as loader insert rows: a stdio server
 * carries its command plus sorted env overrides, an HTTP server is projected
 * as a streamable-http row. Both are represented natively by the loader, so no
 * requested server is silently dropped.
 *
 * Native resume is unavailable: the installed headless profile creates one
 * fresh persisted session per invocation and exposes no resume flag, and the
 * Wrenyard daemon rejects a product handle that is not a native session id, so
 * a resume request is rejected loudly before any side effect instead of
 * silently losing continuity.
 */
export async function prepareDshLaunch(
  request: AgentRequest,
  explicitExecutable: string | undefined,
  env: NodeJS.ProcessEnv,
): Promise<DshLaunch> {
  assertLaunch(request);
  if (request.resumeSessionId)
    throw new Error('dsh: native resume is unsupported by the headless profile');
  const mcpServers = projectDshMcpServers(resolveMcpServers(request.mcpServers));
  if (request.mode === 'gateway' && !request.provider)
    throw new Error('dsh: a gateway launch requires a resolved provider');

  const configured = explicitExecutable?.trim() || env.WRENYARD_DSH_BIN?.trim();
  if (configured && !isAbsolute(configured))
    throw new Error('dsh: configured executable must be an absolute path');
  const status = await findExecutable(['dsh'], configured ? { env, executable: configured } : { env });
  if (status.installation.state !== 'installed')
    throw new Error('dsh is not installed');

  const home = await mkdtemp(join(tmpdir(), 'wrenyard-dsh-agent-'));
  const cleanup = async (): Promise<void> => {
    await rm(home, { recursive: true, force: true }).catch(() => undefined);
  };

  let route: DshModelRoute | undefined;
  let gatewayToken: string | undefined;
  try {
    if (request.mode === 'gateway') {
      // `canonicalModel` is the provider-local declared id and is what the
      // public Gateway directory publishes as `provider/model`; `request.model`
      // may be an upstream wire id, so it is only the fallback.
      const model = (request.canonicalModel?.trim() || request.model.trim());
      route = { publicModelId: `${request.provider}/${model}`, baseUrl: chatBaseUrl(env) };
      gatewayToken = env[GATEWAY_TOKEN_ENV]?.trim();
      if (!gatewayToken)
        throw new Error(`dsh: a gateway launch requires ${GATEWAY_TOKEN_ENV}`);
    }
    else {
      // A native request keeps the selected provider/model exactly as asked and
      // declares NO endpoint of our own: no Gateway route is invented, and the
      // native provider the request already resolved to owns the transport.
      if (!request.provider)
        throw new Error('dsh: a native launch requires a resolved provider');
      const model = (request.canonicalModel?.trim() || request.model.trim());
      route = { publicModelId: `${request.provider}/${model}` };
    }

    let patchPath: string;
    try {
      patchPath = await writeLoaderPatch(home, route, mcpServers);
    } catch (error) {
      await cleanup();
      throw error;
    }

    const args = [
      '--profile', DSH_AGENT_PROFILE,
      '--patch', patchPath,
      request.prompt,
    ];

    const scrubbed = scrubInheritedEnv(env);
    // The launch's own values are applied afterwards and always win. Only the
    // explicitly selected gateway credential survives the scrub; every other
    // inherited Gateway secret was already dropped.
    const spec: ProcessSpec = {
      executable: status.installation.executable,
      args,
      cwd: request.cwd,
      env: stringEnv(scrubbed, {
        DSH_HOME: home,
        DSH_PERMISSION_MODE,
        ...(gatewayToken ? { [GATEWAY_TOKEN_ENV]: gatewayToken } : {}),
      }),
    };

    return { spec, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

/**
 * Project resolved MCP servers onto the DSH loader rows. An HTTP server uses
 * the streamable-http transport; a stdio server carries its command plus its
 * env overrides as sorted `KEY=value` pairs, matching the retired Go
 * projection. Both transports are representable, so nothing is dropped.
 */
function projectDshMcpServers(servers: readonly ResolvedMcpServer[]): DshMcpServer[] {
  return servers.map(({ name, server }) => {
    if (server.transport === 'http')
      return { name, transport: 'streamable-http' as const, url: server.url, headers: server.headers };
    const env = server.env ?? {};
    return {
      name,
      transport: 'stdio' as const,
      command: server.command,
      cwd: server.cwd,
      args: server.args ? [...server.args] : undefined,
      env: Object.keys(env).length > 0 ? Object.keys(env).sort().map((key) => `${key}=${env[key]}`) : undefined,
    };
  });
}

/**
 * Resolve the Gateway chat base URL a `gateway` request must use. DSH appends
 * the completions route itself, so a trailing `/chat/completions` is
 * normalized away; the value is required rather than defaulted, because a
 * guessed endpoint would silently route the configured model nowhere.
 */
function chatBaseUrl(env: NodeJS.ProcessEnv): string {
  const configured = env[GATEWAY_CHAT_URL_ENV]?.trim();
  if (!configured)
    throw new Error(`dsh: a gateway launch requires ${GATEWAY_CHAT_URL_ENV}`);
  return configured.replace(/\/chat\/completions$/u, '').replace(/\/+$/u, '');
}

/**
 * Drop inherited DSH credential variables so no parent-process secret can
 * reach the child, matching the retired Go launcher's scrub, and drop the
 * Desktop-only asynchronous dispatch flag so a background invocation keeps
 * DSH's blocking contract. The launch's own DSH_HOME, permission, and selected
 * gateway token are applied afterwards and always win.
 */
function scrubInheritedEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const scrubbed: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith('WRENYARD_DSH_') || key.startsWith('WRENYARD_GATEWAY_'))
      continue;
    if (key === DSH_ASYNC_TASKS_ENV)
      continue;
    scrubbed[key] = value;
  }
  return scrubbed;
}
