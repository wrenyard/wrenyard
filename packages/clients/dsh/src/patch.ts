import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { DSH_BRIDGE_PLUGIN_FILENAME, DSH_BRIDGE_PLUGIN_SOURCE, DSH_BRIDGE_ROW_ID } from './bridge-asset.ts';
import { DSH_YOLO_PLUGIN_FILENAME, DSH_YOLO_PLUGIN_SOURCE, DSH_YOLO_ROW_ID } from './yolo-asset.ts';
import { DSH_REASONING_EFFORT_PLUGIN_FILENAME, DSH_REASONING_EFFORT_PLUGIN_SOURCE, DSH_REASONING_EFFORT_ROW_ID, DSH_REASONING_EFFORT_URL_ENV } from './reasoning-effort-asset.ts';

/** File name of the generated loader overlay inside the per-run DSH home. */
export const DSH_LOADER_PATCH_FILENAME = 'wrenyard-loader-patch.yaml';

/** Exactly one Wrenyard Gateway provider is injected, keyed by its route. */
const DSH_GATEWAY_ROUTE_KEY = 'wrenyard';
const DSH_GATEWAY_PROVIDER_ROW_ID = 'llm-pi-ai';
const DSH_DEFAULT_MODEL_ROW_ID = 'agent-default-model';

/** The one credential name the generated overlay may reference; never a value. */
const DSH_GATEWAY_TOKEN_ENV = 'WRENYARD_GATEWAY_TOKEN';

/** Loader overlay insert id the native DSH loader uses for injected MCP clients. */
const DSH_MCP_CLIENT_ROW_ID = '@deepseek-ai/dsh-mcp-client';

/** Loader row and file of the generated provider-selector forwarder. */
export const DSH_PROVIDER_HEADER_ROW_ID = 'wrenyard-dsh-provider-header';
export const DSH_PROVIDER_HEADER_PLUGIN_FILENAME = 'wrenyard-dsh-provider-header.mjs';

/**
 * The provider the forwarder selects for every Gateway request. The body's
 * model id is the bare registered model id, so the provider is a separate
 * dimension and must travel in the Gateway's own header.
 */
export const DSH_PROVIDER_ENV = 'WRENYARD_GATEWAY_PROVIDER';

/**
 * The provider-header forwarder plugin source. DSH's `llm-pi-ai` provider has
 * no per-request header config, so — exactly like the effort forwarder — this
 * wraps the child's `globalThis.fetch` and adds the Gateway's provider header to
 * requests for the configured chat-completions URL only. Every other request,
 * and a launch with no provider, passes through untouched.
 */
export const DSH_PROVIDER_HEADER_PLUGIN_SOURCE = String.raw`export const name = 'wrenyard-dsh-provider-header';
export const inject = [];

const HEADER = 'x-wrenyard-provider';
const URL_ENV = '${DSH_REASONING_EFFORT_URL_ENV}';
const PROVIDER_ENV = '${DSH_PROVIDER_ENV}';
const WRAPPER = Symbol.for('wrenyard.dsh.provider-header.fetch-wrapped');

function sameEndpoint(target, candidate) {
  if (!candidate) return false;
  try {
    const left = new URL(target);
    const right = new URL(candidate);
    return left.href === right.href;
  } catch {
    return target === candidate;
  }
}

export function apply() {
  const target = process.env[URL_ENV];
  const provider = process.env[PROVIDER_ENV];
  if (!target || !provider) return;
  const scope = globalThis;
  if (scope[WRAPPER] === true) return;
  const original = scope.fetch;
  if (typeof original !== 'function') return;
  const wrapped = function fetchWithProviderHeader(input, init) {
    const isRequest = typeof input === 'object' && input !== null
      && typeof input.url === 'string' && typeof input.clone === 'function';
    if (isRequest) {
      if (!sameEndpoint(target, input.url)) return original.call(this, input, init);
      const headers = new Headers(init && init.headers !== undefined ? init.headers : input.headers);
      headers.set(HEADER, provider);
      const request = new Request(input, { ...(init || {}), headers });
      return original.call(this, request);
    }
    const url = typeof input === 'string' ? input : (input instanceof URL ? input.toString() : '');
    if (!sameEndpoint(target, url)) return original.call(this, input, init);
    const headers = new Headers(init && init.headers ? init.headers : undefined);
    headers.set(HEADER, provider);
    return original.call(this, input, { ...(init || {}), headers });
  };
  Object.defineProperty(scope, 'fetch', {
    value: wrapped,
    writable: true,
    configurable: true,
    enumerable: false,
  });
  Object.defineProperty(scope, WRAPPER, {
    value: true,
    writable: false,
    configurable: true,
    enumerable: false,
  });
}

export default { name, inject, apply };
`;

/** The two MCP transports the DSH loader overlay can represent. */
export type DshMcpTransport = 'stdio' | 'streamable-http';

/**
 * A single projected MCP server for the DSH loader overlay. A stdio server
 * carries a command plus optional args/env; an HTTP server carries only its
 * transport. This mirrors the retired Go projection, which represented HTTP
 * servers by transport alone.
 */
export interface DshMcpServer {
  readonly name: string;
  readonly transport: DshMcpTransport;
  readonly command?: string;
  readonly url?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly cwd?: string;
  readonly args?: readonly string[];
  /** Sorted `KEY=value` entries; a `!!js ` prefix is passed through unquoted. */
  readonly env?: readonly string[];
}

const YAML_PLAIN = /^[A-Za-z0-9][A-Za-z0-9._@/\-]*$/;

/** Render a YAML scalar, quoting only when the plain form is unsafe. */
function yamlStr(value: string): string {
  return YAML_PLAIN.test(value) ? value : JSON.stringify(value);
}

/**
 * Render a config value, passing an explicit `!!js ` tag through raw so a
 * credential reference stays unquoted rather than becoming a string literal.
 */
function yamlValue(value: string): string {
  return value.startsWith('!!js ') ? value : yamlStr(value);
}

/** Secret-free description of the single model route the overlay declares. */
export interface DshModelRoute {
  /**
   * The model id selected for the run. For a Gateway route this is the bare
   * registered model id; for a native route it is the exact native model id.
   */
  readonly modelId: string;
  /**
   * Provider selector. For a Gateway route the forwarder sends it in the
   * X-Wrenyard-Provider header, because the model id alone is the registered
   * identity; for a native route it names the provider the default model is
   * declared against.
   */
  readonly provider?: string;
  /**
   * OpenAI-compatible chat base URL of the local Gateway. Present only for a
   * Wrenyard Gateway route; absent for a native route, which declares no
   * endpoint of ours because the native provider owns its own transport.
   */
  readonly baseUrl?: string;
  /** Optional context-window annotation for the declared model. */
  readonly contextWindow?: number;
  /**
   * Public reasoning-effort level for a Gateway route. When present, the overlay
   * mounts the reasoning-effort forwarder plugin, which adds the internal
   * Gateway effort header to requests for the exact configured chat-completions
   * URL. Absent for a native route, which never reaches Wrenyard's Gateway.
   */
  readonly reasoningEffort?: string;
}

/**
 * Render the complete secret-free loader overlay for one DSH invocation: the
 * `llm-pi-ai` provider row carrying the single Wrenyard Gateway route (gateway
 * routes only), the `agent-default-model` selection, the pinned execution mode,
 * and the two runtime insert rows that mount the transcript bridge and the
 * session normalizer.
 *
 * Only the selected model id is ever projected — the overlay never invents a
 * second model, and a native route declares no endpoint at all. The credential
 * is always the literal `!!js process.env.<ENV>` tag, so the generated file can
 * never hold a secret.
 *
 * `yoloPluginPath` and `bridgePluginPath` are absolute plugin paths, exactly as
 * the retired Go renderer required them; an empty bridge path omits its row.
 * `reasoningPluginPath` mounts the effort forwarder and is emitted only for a
 * Gateway route carrying a public reasoning effort.
 *
 * `mcpServers` are projected as `@deepseek-ai/dsh-mcp-client` insert rows after
 * the plugin rows, sorted by server name, matching the retired Go projection.
 */
export function renderDshPatch(route: DshModelRoute | undefined, yoloPluginPath: string, bridgePluginPath: string, reasoningPluginPath: string, mcpServers: readonly DshMcpServer[] = [], providerPluginPath = ''): string {
  const lines: string[] = ['# wrenyard dsh patch (generated; secret-free)'];

  if (route) {
    const modelId = route.modelId.trim();
    if (modelId === '' || modelId.includes('/'))
      throw new Error(`dsh: model id must be a bare model id: ${route.modelId}`);
    if (route.baseUrl) {
      if (!route.provider)
        throw new Error('dsh: a gateway route requires a provider selector');
      lines.push(
        `- id: ${yamlStr(DSH_GATEWAY_PROVIDER_ROW_ID)}`,
        '  config:',
        '    providers:',
        `      ${yamlStr(DSH_GATEWAY_ROUTE_KEY)}:`,
        '        displayName: Wrenyard',
        '        api: openai-completions',
        `        apiKeyEnv: ${yamlStr(DSH_GATEWAY_TOKEN_ENV)}`,
        `        baseURL: ${yamlStr(route.baseUrl)}`,
        '        models:',
        `          - id: ${yamlStr(modelId)}`,
        `            name: ${yamlStr(modelId)}`,
      );
      if (route.contextWindow && route.contextWindow > 0)
        lines.push(`            contextWindow: ${route.contextWindow}`);
    }
    lines.push(
      `- id: ${yamlStr(DSH_DEFAULT_MODEL_ROW_ID)}`,
      '  config:',
      `    provider: ${yamlStr(route.baseUrl ? DSH_GATEWAY_ROUTE_KEY : route.provider ?? '')}`,
      `    model: ${yamlStr(modelId)}`,
    );
  }

  // The generated overlay is always the final application layer. Keep the
  // enforcing services mounted, fix their defaults to YOLO, and remove the
  // obsolete user-facing permission selector.
  lines.push(
    '- id: sandbox-policy',
    '  config:',
    '    mode: danger-full-access',
    '- id: approval',
    '  config:',
    '    policy: never',
    '- id: permission',
    '  disabled: true',
    '- id: ui-permission',
    '  disabled: true',
  );
  // Mandatory session normalizer first, then the optional transcript bridge —
  // the exact insert order the retired Go patch renderer emitted.
  if (yoloPluginPath)
    lines.push(
      '- insert:',
      `    - id: ${yamlStr(DSH_YOLO_ROW_ID)}`,
      `      name: ${yamlStr(yoloPluginPath)}`,
    );
  if (bridgePluginPath)
    lines.push(
      '- insert:',
      `    - id: ${yamlStr(DSH_BRIDGE_ROW_ID)}`,
      `      name: ${yamlStr(bridgePluginPath)}`,
    );
  // The effort forwarder mounts only for a Gateway route that declares the
  // public effort; a native route never reaches Wrenyard's Gateway.
  if (route?.baseUrl && route.reasoningEffort && reasoningPluginPath)
    lines.push(
      '- insert:',
      `    - id: ${yamlStr(DSH_REASONING_EFFORT_ROW_ID)}`,
      `      name: ${yamlStr(reasoningPluginPath)}`,
    );
  // The provider-selector forwarder mounts for every Gateway route: the request
  // body names only the registered model id, so the provider must be selected
  // by the Gateway's own header.
  if (route?.baseUrl && route.provider && providerPluginPath)
    lines.push(
      '- insert:',
      `    - id: ${yamlStr(DSH_PROVIDER_HEADER_ROW_ID)}`,
      `      name: ${yamlStr(providerPluginPath)}`,
    );

  // MCP servers are inserted after the plugins, sorted by name. A transport the
  // loader cannot represent is rejected before any row is emitted.
  for (const server of [...mcpServers].sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
    if (server.transport !== 'stdio' && server.transport !== 'streamable-http')
      throw new Error(`dsh: unsupported mcp transport ${JSON.stringify(server.transport)}`);
    lines.push(
      '- insert:',
      `    - id: ${yamlStr('wrenyard-mcp-' + server.name)}`,
      `      name: ${yamlStr(DSH_MCP_CLIENT_ROW_ID)}`,
      '      config:',
      `        serverName: ${yamlStr(server.name)}`,
      `        transport: ${yamlStr(server.transport)}`,
      '        failOnStartupError: true',
    );
    if (server.transport === 'stdio') {
      lines.push(`        command: ${yamlStr(server.command ?? '')}`);
      if (server.cwd) lines.push(`        cwd: ${yamlStr(server.cwd)}`);
      if (server.args && server.args.length > 0) {
        lines.push('        args:');
        for (const arg of server.args)
          lines.push(`          - ${yamlStr(arg)}`);
      }
    }
    if (server.transport === 'streamable-http') {
      if (!server.url) throw new Error('DSH HTTP MCP server requires a URL');
      lines.push(`        url: ${yamlStr(server.url)}`);
      if (server.headers && Object.keys(server.headers).length > 0) {
        lines.push('        headers:');
        for (const [key, value] of Object.entries(server.headers))
          lines.push(`          ${yamlStr(key)}: ${yamlStr(value)}`);
      }
    }
    if (server.env && server.env.length > 0) {
      lines.push('        env:');
      for (const entry of [...server.env].sort()) {
        const separator = entry.indexOf('=');
        if (separator === -1)
          continue;
        lines.push(`          ${yamlStr(entry.slice(0, separator))}: ${yamlStr(entry.slice(separator + 1))}`);
      }
    }
  }

  return `${lines.join('\n')}\n`;
}

/**
 * Materialize the generated overlay and its plugin assets into the isolated
 * per-run DSH home, returning the absolute overlay path. The caller owns the
 * home and removes it through its lifecycle cleanup.
 */
export async function writeLoaderPatch(home: string, route?: DshModelRoute, mcpServers: readonly DshMcpServer[] = []): Promise<string> {
  await fs.mkdir(home, { recursive: true });
  const bridgePath = join(home, DSH_BRIDGE_PLUGIN_FILENAME);
  const yoloPath = join(home, DSH_YOLO_PLUGIN_FILENAME);
  const reasoningPath = join(home, DSH_REASONING_EFFORT_PLUGIN_FILENAME);
  const providerPath = join(home, DSH_PROVIDER_HEADER_PLUGIN_FILENAME);
  await fs.writeFile(bridgePath, DSH_BRIDGE_PLUGIN_SOURCE, { encoding: 'utf8', mode: 0o600 });
  await fs.writeFile(yoloPath, DSH_YOLO_PLUGIN_SOURCE, { encoding: 'utf8', mode: 0o600 });
  await fs.writeFile(reasoningPath, DSH_REASONING_EFFORT_PLUGIN_SOURCE, { encoding: 'utf8', mode: 0o600 });
  await fs.writeFile(providerPath, DSH_PROVIDER_HEADER_PLUGIN_SOURCE, { encoding: 'utf8', mode: 0o600 });
  const target = join(home, DSH_LOADER_PATCH_FILENAME);
  await fs.writeFile(target, renderDshPatch(route, yoloPath, bridgePath, reasoningPath, mcpServers, providerPath), { encoding: 'utf8', mode: 0o600 });
  return target;
}
