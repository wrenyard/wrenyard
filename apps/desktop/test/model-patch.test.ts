import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  DEFAULT_WRENYARD_MCP_URL,
  MODEL_PATCH_FILENAME,
  WRENYARD_DSH_PROVIDER_ID,
  WRENYARD_GATEWAY_TOKEN_ENV,
  defaultMcpUrl,
  renderModelPatch,
  writeModelPatch,
} from '../src/model-patch.js';
import type { WrenyardGatewayConnection } from '@wrenyard/control-client';

const connection: WrenyardGatewayConnection = {
  openaiChatBaseUrl: 'http://127.0.0.1:8787/gateway/openai-chat/v1',
  openaiResponsesBaseUrl: 'http://127.0.0.1:8787/gateway/openai-responses/v1',
  anthropicBaseUrl: 'http://127.0.0.1:8787/gateway/anthropic/v1',
  token: 'local-gateway-secret',
  models: [
    {
      id: 'glm-5.3',
      publicId: 'zhipu-coding/glm-5.3',
      provider: 'zhipu-coding',
      displayName: 'GLM 5.3',
      intelligence: 'high',
      contextWindow: 204800,
      maxTokens: 32768,
    },
    {
      id: 'deepseek-v4.1-flash',
      publicId: 'codebuddy/deepseek-v4.1-flash',
      provider: 'codebuddy',
      displayName: 'DeepSeek V4.1 Flash',
      intelligence: 'mid',
    },
  ],
};

async function withTemp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-model-patch-test-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('renderModelPatch matches the public fdsh overlay contract', () => {
  const raw = renderModelPatch(connection);
  assert.ok(raw.startsWith('# wrenyard dsh patch (generated; secret-free)\n- id: llm-pi-ai\n'));
  assert.match(raw, new RegExp(`^      ${WRENYARD_DSH_PROVIDER_ID}:$`, 'm'));
  assert.ok(raw.includes('        api: openai-completions\n'));
  assert.ok(raw.includes(`        apiKeyEnv: ${WRENYARD_GATEWAY_TOKEN_ENV}\n`));
  assert.ok(raw.includes(`        baseURL: "${connection.openaiChatBaseUrl}"\n`));
  assert.ok(raw.includes('          - id: zhipu-coding/glm-5.3\n'));
  assert.ok(raw.includes('          - id: codebuddy/deepseek-v4.1-flash\n'));
  assert.ok(raw.includes('            name: "GLM 5.3"\n'));
  assert.ok(raw.includes('            contextWindow: 204800\n'));
  assert.ok(raw.includes('            maxTokens: 32768\n'));
  assert.equal(raw.includes(connection.token), false);
  assert.equal(raw.includes('https://api.kimi.com'), false);
  assert.equal(raw.includes('https://open.bigmodel.cn'), false);
  assert.equal(raw.includes('!!js'), false);
});

test('writeModelPatch atomically writes the overlay into DSH_HOME', async () => {
  await withTemp(async (dir) => {
    const path = await writeModelPatch(dir, connection);
    assert.equal(path, join(dir, MODEL_PATCH_FILENAME));
    assert.equal(await readFile(path, 'utf8'), renderModelPatch(connection));
  });
});

test('defaultMcpUrl prefers WRENYARD_* then FOREMAN_* then the shared default', () => {
  assert.equal(defaultMcpUrl({ WRENYARD_MCP_URL: 'http://a/mcp', FOREMAN_MCP_URL: 'http://b/mcp' }), 'http://a/mcp');
  assert.equal(defaultMcpUrl({ FOREMAN_MCP_URL: 'http://b/mcp' }), 'http://b/mcp');
  assert.equal(defaultMcpUrl({}), DEFAULT_WRENYARD_MCP_URL);
});
