import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { AgentRequest } from '@wrenyard/agent-client';
import { resolveMcpServers, type ResolvedMcpServer } from '@wrenyard/agent-client/mcp';
import { assertLaunch, stringEnv } from '@wrenyard/agent-client/native';
import { type ProcessSpec } from '@wrenyard/execution';
import { inspectDsh } from './installation.ts';
import { DSH_PROVIDER_ENV, writeLoaderPatch, type DshMcpServer, type DshModelRoute } from './patch.ts';
import { DSH_REASONING_EFFORT_ENV, DSH_REASONING_EFFORT_URL_ENV } from './reasoning-effort-asset.ts';

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

/**
 * Minimum supported external DSH executable version. Upstream `0.2.0-rc.2`
 * changed the session event stream and the native model ids, so an older
 * runtime cannot be driven correctly; the launch checks the bounded shared
 * `--version` result and fails
 * fast below this.
 */
const DSH_MINIMUM_VERSION = '0.2.0-rc.2';

/** The one upgrade command named in the minimum-version error. */
const DSH_UPGRADE_COMMAND = 'npm install -g @deepseek-ai/dsh@0.2.0-rc.2';

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
 * Canonical Wrenyard DeepSeek flash selections mapped to their upstream native
 * model id. Only the native route consults this table; a `deepseek-flash`
 * selection stays `deepseek-flash`.
 */
const DSH_NATIVE_FLASH_ALIASES: Record<string, string> = {
  'deepseek-v4-flash': 'deepseek-flash',
  'deepseek-v4.1-flash': 'deepseek-flash',
  'deepseek-flash': 'deepseek-flash',
};

/**
 * Map a canonical Wrenyard DeepSeek model id onto the upstream native id.
 * Every other model id, including `deepseek-v4-pro`, is returned unchanged.
 */
function nativeDeepseekModel(model: string): string {
  return DSH_NATIVE_FLASH_ALIASES[model] ?? model;
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
 * Native resume is unavailable: this adapter launches every run against a
 * disposable per-run DSH_HOME and keeps no persistent session store, so there
 * is never a session to resume, and the Wrenyard daemon rejects a product
 * handle that is not a native session id. Upstream 0.2.0-rc.2's headless
 * profile does accept `--session-id`, but a resume request is still rejected
 * loudly before any side effect instead of silently losing continuity.
 */
export async function prepareDshLaunch(
  request: AgentRequest,
  explicitExecutable: string | undefined,
  env: NodeJS.ProcessEnv,
): Promise<DshLaunch> {
  assertLaunch(request);
  if (request.resumeSessionId)
    throw new Error('dsh: native resume is unsupported: this adapter uses a disposable per-run DSH_HOME and persists no session');
  const mcpServers = projectDshMcpServers(resolveMcpServers(request.mcpServers));
  if (request.mode === 'gateway' && !request.provider)
    throw new Error('dsh: a gateway launch requires a resolved provider');

  const configured = explicitExecutable?.trim() || env.WRENYARD_DSH_BIN?.trim();
  if (configured && !isAbsolute(configured))
    throw new Error('dsh: configured executable must be an absolute path');
  const scrubbed = scrubInheritedEnv(env);
  const status = await inspectDsh(configured ? { env: scrubbed, executable: configured } : { env: scrubbed });
  if (status.installation.state !== 'installed')
    throw new Error('dsh is not installed');

  // Enforce the minimum external DSH version before any side effect, using the
  // bounded shared probe run in the scrubbed child environment.
  assertDshVersion(status.installation.version);

  const home = await mkdtemp(join(tmpdir(), 'wrenyard-dsh-agent-'));
  const cleanup = async (): Promise<void> => {
    await rm(home, { recursive: true, force: true }).catch(() => undefined);
  };

  let route: DshModelRoute | undefined;
  let gatewayToken: string | undefined;
  try {
    if (request.mode === 'gateway') {
      // The Gateway route is published by the bare registered model id, so
      // `canonicalModel` (the registered identity) is the model and `request.model`
      // (a possible upstream wire id) is only the fallback. The provider is a
      // separate selector carried by the generated forwarder's header.
      const model = (request.canonicalModel?.trim() || request.model.trim());
      // A Gateway route forwards the PUBLIC effort level unchanged: the
      // Gateway owns provider-owned conversion. The generated forwarder plugins
      // add the internal effort and provider headers only for this route's exact
      // chat-completions URL, so no body/field rewrite happens in the adapter.
      route = {
        modelId: model,
        provider: request.provider,
        baseUrl: chatBaseUrl(env),
        reasoningEffort: request.reasoningEffort,
      };
      gatewayToken = env[GATEWAY_TOKEN_ENV]?.trim();
      if (!gatewayToken)
        throw new Error(`dsh: a gateway launch requires ${GATEWAY_TOKEN_ENV}`);
    }
    else {
      // A native request declares NO endpoint of our own: no Gateway route is
      // invented, and the native provider the request already resolved to owns
      // the transport. Only here do the canonical Wrenyard DeepSeek provider
      // and its flash model aliases map onto the upstream native ids; the
      // Gateway route and every other provider/model are left as asked.
      if (!request.provider)
        throw new Error('dsh: a native launch requires a resolved provider');
      const model = (request.canonicalModel?.trim() || request.model.trim());
      const nativeProvider = request.provider === 'deepseek' ? 'deepseek-official' : request.provider;
      const nativeModel = request.provider === 'deepseek' ? nativeDeepseekModel(model) : model;
      route = { modelId: nativeModel, provider: nativeProvider };
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

    // The exact Gateway chat-completions endpoint and the public effort are
    // handed to the generated forwarder plugin through this run's environment;
    // the scrub above removed any inherited effort values, so only these fresh
    // ones can reach the child.
    const effortEnv: Record<string, string> = route?.baseUrl && route.reasoningEffort
      ? {
          [DSH_REASONING_EFFORT_ENV]: route.reasoningEffort,
          [DSH_REASONING_EFFORT_URL_ENV]: `${route.baseUrl}/chat/completions`,
        }
      : {};
    // The Gateway route carries the provider separately from the bare registered
    // model id: the generated forwarder adds it as the Gateway's provider
    // header so the exact offering is resolved without a qualified model id.
    const providerEnv: Record<string, string> = route?.baseUrl && route.provider
      ? { [DSH_PROVIDER_ENV]: route.provider }
      : {};
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
        ...effortEnv,
        ...providerEnv,
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

/** A parsed DSH `--version` value; build metadata is dropped. */
interface DshSemver {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: readonly string[];
}

/** First strict SemVer token, including prerelease identifiers. */
const DSH_SEMVER_PATTERN = /(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?/;

/**
 * Reject any version below the supported minimum. The bounded shared
 * `--version` probe uses no shell and runs under the same scrubbed environment
 * the child will inherit. Raw output is never surfaced: an old, unparseable or unprobeable version becomes a single
 * sanitized error naming the minimum version and the upgrade command.
 */
function assertDshVersion(version: string | undefined): void {
  const minimum = parseDshSemver(DSH_MINIMUM_VERSION);
  const found = version === undefined ? undefined : parseDshSemver(version);
  if (minimum === undefined || found === undefined || compareDshSemver(found, minimum) < 0) {
    const seen = found === undefined ? 'unknown' : formatDshSemver(found);
    throw new Error(`dsh: unsupported DSH version (${seen}); Wrenyard requires @deepseek-ai/dsh >= ${DSH_MINIMUM_VERSION}. Upgrade with: ${DSH_UPGRADE_COMMAND}`);
  }
}

/** Parse the first SemVer token in a `--version` banner, or undefined. */
function parseDshSemver(output: string): DshSemver | undefined {
  const match = DSH_SEMVER_PATTERN.exec(output.trim());
  if (!match)
    return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : [],
  };
}

/** Render a parsed DSH version back to its canonical string. */
function formatDshSemver(version: DshSemver): string {
  const core = `${version.major}.${version.minor}.${version.patch}`;
  return version.prerelease.length > 0 ? `${core}-${version.prerelease.join('.')}` : core;
}

/** Strict SemVer ordering (prerelease-aware); build metadata never participates. */
function compareDshSemver(a: DshSemver, b: DshSemver): number {
  if (a.major !== b.major)
    return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor)
    return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch)
    return a.patch < b.patch ? -1 : 1;
  if (a.prerelease.length === 0 && b.prerelease.length === 0)
    return 0;
  if (a.prerelease.length === 0)
    return 1;
  if (b.prerelease.length === 0)
    return -1;
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const left = a.prerelease[index];
    const right = b.prerelease[index];
    if (left === undefined)
      return -1;
    if (right === undefined)
      return 1;
    const leftNumeric = /^\d+$/.test(left);
    const rightNumeric = /^\d+$/.test(right);
    if (leftNumeric && rightNumeric) {
      const delta = Number(left) - Number(right);
      if (delta !== 0)
        return delta < 0 ? -1 : 1;
      continue;
    }
    if (leftNumeric !== rightNumeric)
      return leftNumeric ? -1 : 1;
    if (left !== right)
      return left < right ? -1 : 1;
  }
  return 0;
}

/**
 * Drop inherited DSH credential variables so no parent-process secret can
 * reach the child, matching the retired Go launcher's scrub; drop any inherited
 * reasoning-effort wiring so a stale effort can never leak; and drop the
 * Desktop-only asynchronous dispatch flag so a background invocation keeps
 * DSH's blocking contract. The launch's own DSH_HOME, permission, effort, and
 * selected gateway token are applied afterwards and always win.
 */
function scrubInheritedEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const scrubbed: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith('WRENYARD_DSH_') || key.startsWith('WRENYARD_GATEWAY_'))
      continue;
    // Drop any inherited effort wiring so a stale URL/level from a parent
    // process can never be forwarded; the launch sets its own fresh values.
    if (key.startsWith('WRENYARD_REASONING_'))
      continue;
    if (key === DSH_ASYNC_TASKS_ENV)
      continue;
    scrubbed[key] = value;
  }
  return scrubbed;
}
