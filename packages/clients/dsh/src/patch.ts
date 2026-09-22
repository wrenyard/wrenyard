import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { DSH_BRIDGE_PLUGIN_FILENAME, DSH_BRIDGE_PLUGIN_SOURCE, DSH_BRIDGE_ROW_ID } from './bridge-asset.ts';
import { DSH_YOLO_PLUGIN_FILENAME, DSH_YOLO_PLUGIN_SOURCE, DSH_YOLO_ROW_ID } from './yolo-asset.ts';

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
  /** Selected model id, always exactly `provider/model`. */
  readonly publicModelId: string;
  /**
   * OpenAI-compatible chat base URL of the local Gateway. Present only for a
   * Wrenyard Gateway route; absent for a native route, which declares no
   * endpoint of ours because the native provider owns its own transport.
   */
  readonly baseUrl?: string;
  /** Optional context-window annotation for the declared model. */
  readonly contextWindow?: number;
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
 *
 * `mcpServers` are projected as `@deepseek-ai/dsh-mcp-client` insert rows after
 * the plugin rows, sorted by server name, matching the retired Go projection.
 */
export function renderDshPatch(route: DshModelRoute | undefined, yoloPluginPath: string, bridgePluginPath: string, mcpServers: readonly DshMcpServer[] = []): string {
  const lines: string[] = ['# wrenyard dsh patch (generated; secret-free)'];

  if (route) {
    const separator = route.publicModelId.indexOf('/');
    if (separator <= 0 || separator === route.publicModelId.length - 1)
      throw new Error(`dsh: model id must be provider/model: ${route.publicModelId}`);
    const providerId = route.publicModelId.slice(0, separator);
    const modelId = route.publicModelId.slice(separator + 1);
    if (route.baseUrl) {
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
        `          - id: ${yamlStr(route.publicModelId)}`,
        `            name: ${yamlStr(modelId)}`,
      );
      if (route.contextWindow && route.contextWindow > 0)
        lines.push(`            contextWindow: ${route.contextWindow}`);
    }
    lines.push(
      `- id: ${yamlStr(DSH_DEFAULT_MODEL_ROW_ID)}`,
      '  config:',
      `    provider: ${yamlStr(route.baseUrl ? DSH_GATEWAY_ROUTE_KEY : providerId)}`,
      `    model: ${yamlStr(route.baseUrl ? route.publicModelId : modelId)}`,
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
      `    id: ${yamlStr(DSH_YOLO_ROW_ID)}`,
      `    name: ${yamlStr(yoloPluginPath)}`,
    );
  if (bridgePluginPath)
    lines.push(
      '- insert:',
      `    id: ${yamlStr(DSH_BRIDGE_ROW_ID)}`,
      `    name: ${yamlStr(bridgePluginPath)}`,
    );

  // MCP servers are inserted after the plugins, sorted by name. A transport the
  // loader cannot represent is rejected before any row is emitted.
  for (const server of [...mcpServers].sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
    if (server.transport !== 'stdio' && server.transport !== 'streamable-http')
      throw new Error(`dsh: unsupported mcp transport ${JSON.stringify(server.transport)}`);
    lines.push(
      '- insert:',
      `    id: ${yamlStr('wrenyard-mcp-' + server.name)}`,
      `    name: ${yamlStr(DSH_MCP_CLIENT_ROW_ID)}`,
      '    config:',
      `      serverName: ${yamlStr(server.name)}`,
      `      transport: ${yamlStr(server.transport)}`,
      '      failOnStartupError: true',
    );
    if (server.transport === 'stdio') {
      lines.push(`      command: ${yamlStr(server.command ?? '')}`);
      if (server.cwd) lines.push(`      cwd: ${yamlStr(server.cwd)}`);
      if (server.args && server.args.length > 0) {
        lines.push('      args:');
        for (const arg of server.args)
          lines.push(`        - ${yamlStr(arg)}`);
      }
    }
    if (server.transport === 'streamable-http') {
      if (!server.url) throw new Error('DSH HTTP MCP server requires a URL');
      lines.push(`      url: ${yamlStr(server.url)}`);
      if (server.headers && Object.keys(server.headers).length > 0) {
        lines.push('      headers:');
        for (const [key, value] of Object.entries(server.headers))
          lines.push(`        ${yamlStr(key)}: ${yamlStr(value)}`);
      }
    }
    if (server.env && server.env.length > 0) {
      lines.push('      env:');
      for (const entry of [...server.env].sort()) {
        const separator = entry.indexOf('=');
        if (separator === -1)
          continue;
        lines.push(`        ${yamlStr(entry.slice(0, separator))}: ${yamlStr(entry.slice(separator + 1))}`);
      }
    }
  }

  return `${lines.join('\n')}\n`;
}

/**
 * Materialize the generated overlay and its two plugin assets into the isolated
 * per-run DSH home, returning the absolute overlay path. The caller owns the
 * home and removes it through its lifecycle cleanup.
 */
export async function writeLoaderPatch(home: string, route?: DshModelRoute, mcpServers: readonly DshMcpServer[] = []): Promise<string> {
  await fs.mkdir(home, { recursive: true });
  const bridgePath = join(home, DSH_BRIDGE_PLUGIN_FILENAME);
  const yoloPath = join(home, DSH_YOLO_PLUGIN_FILENAME);
  await fs.writeFile(bridgePath, DSH_BRIDGE_PLUGIN_SOURCE, { encoding: 'utf8', mode: 0o600 });
  await fs.writeFile(yoloPath, DSH_YOLO_PLUGIN_SOURCE, { encoding: 'utf8', mode: 0o600 });
  const target = join(home, DSH_LOADER_PATCH_FILENAME);
  await fs.writeFile(target, renderDshPatch(route, yoloPath, bridgePath, mcpServers), { encoding: 'utf8', mode: 0o600 });
  return target;
}
