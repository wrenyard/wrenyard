import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { WrenyardGatewayConnection } from '@wrenyard/control-client';

export const MODEL_PATCH_FILENAME = 'forge-model-patch.yaml';
export const DEFAULT_WRENYARD_MCP_URL = 'http://127.0.0.1:8787/mcp';
export const WRENYARD_DSH_PROVIDER_ID = 'wrenyard';
export const WRENYARD_GATEWAY_TOKEN_ENV = 'WRENYARD_GATEWAY_TOKEN';

const YAML_PLAIN = /^[A-Za-z0-9][A-Za-z0-9._@/\-]*$/;
function yamlStr(value: string): string { return YAML_PLAIN.test(value) ? value : JSON.stringify(value); }

/** Render exactly one secret-free DSH provider backed by the local Gateway. */
export function renderModelPatch(connection: WrenyardGatewayConnection): string {
  const lines = [
    '# wrenyard dsh patch (generated; secret-free)',
    '- id: llm-pi-ai',
    '  config:',
    '    providers:',
    `      ${WRENYARD_DSH_PROVIDER_ID}:`,
    '        displayName: Wrenyard',
    '        api: openai-completions',
    `        apiKeyEnv: ${WRENYARD_GATEWAY_TOKEN_ENV}`,
    `        baseURL: ${yamlStr(connection.openaiChatBaseUrl)}`,
    '        models:',
  ];
  for (const model of connection.models) {
    lines.push(`          - id: ${yamlStr(model.publicId)}`);
    lines.push(`            name: ${yamlStr(model.displayName)}`);
    if (model.contextWindow) lines.push(`            contextWindow: ${model.contextWindow}`);
    if (model.maxTokens) lines.push(`            maxTokens: ${model.maxTokens}`);
  }
  return `${lines.join('\n')}\n`;
}

export async function writeModelPatch(dshHome: string, connection: WrenyardGatewayConnection): Promise<string> {
  await fs.mkdir(dshHome, { recursive: true });
  const target = join(dshHome, MODEL_PATCH_FILENAME);
  const tmp = `${target}.tmp-${randomBytes(6).toString('hex')}`;
  await fs.writeFile(tmp, renderModelPatch(connection), 'utf8');
  await fs.rename(tmp, target);
  return target;
}

export function defaultMcpUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env.WRENYARD_MCP_URL ?? env.FOREMAN_MCP_URL ?? DEFAULT_WRENYARD_MCP_URL;
}
