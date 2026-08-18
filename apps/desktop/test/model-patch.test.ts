import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  DEFAULT_WRENYARD_MCP_URL,
  INJECTED_PROVIDERS,
  MODEL_PATCH_FILENAME,
  defaultMcpUrl,
  renderModelPatch,
  resolveModelCredentialEnv,
  runtimeAuthPath,
  writeModelPatch,
} from '../src/model-patch.js';

async function withTemp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-model-patch-test-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('renderModelPatch matches the public fdsh overlay contract', () => {
  const raw = renderModelPatch();
  assert.ok(raw.startsWith('# forge dsh patch (generated; secret-free)\n- id: llm-pi-ai\n'));
  assert.match(raw, /^      kimi-coding:$/m);
  assert.match(raw, /^      zhipu-coding:$/m);
  assert.ok(raw.includes('        displayName: "Kimi Coding"\n'));
  assert.ok(raw.includes('        displayName: "Zhipu Coding"\n'));
  assert.ok(raw.includes('        api: openai-completions\n'));
  assert.ok(raw.includes('        apiKeyEnv: FORGE_DSH_KIMI_CODING_API_KEY\n'));
  assert.ok(raw.includes('        apiKeyEnv: FORGE_DSH_ZHIPU_CODING_API_KEY\n'));
  assert.ok(raw.includes('        baseURL: "https://api.kimi.com/coding/v1"\n'));
  assert.ok(raw.includes('        baseURL: "https://open.bigmodel.cn/api/coding/paas/v4"\n'));
  assert.ok(raw.includes('          - id: k3\n'));
  assert.ok(raw.includes('          - id: "k3[1m]"\n'));
  assert.ok(raw.includes('          - id: glm-5.3\n'));
  assert.ok(raw.includes('            name: "Kimi K3"\n'));
  assert.ok(raw.includes('            name: GLM-5.3\n'));
  assert.ok(raw.includes('            contextWindow: 1048576\n'));
  assert.ok(raw.includes('            maxTokens: 32768\n'));
  assert.equal(raw.includes('deepseek-official'), false);
  assert.equal(raw.includes('sk-'), false);
  assert.equal(raw.includes('!!js'), false);
  assert.equal(INJECTED_PROVIDERS.length, 2);
});

test('writeModelPatch atomically writes the overlay into DSH_HOME', async () => {
  await withTemp(async (dir) => {
    const path = await writeModelPatch(dir);
    assert.equal(path, join(dir, MODEL_PATCH_FILENAME));
    assert.equal(await readFile(path, 'utf8'), renderModelPatch());
  });
});

test('resolveModelCredentialEnv reads Wrenyard runtime auth.json without requiring every provider', async () => {
  await withTemp(async (dir) => {
    const dataHome = join(dir, 'share');
    await mkdir(join(dataHome, 'wrenyard', 'runtime'), { recursive: true });
    const authPath = runtimeAuthPath({ XDG_DATA_HOME: dataHome }, dir);
    await writeFile(authPath, JSON.stringify({
      'kimi-coding': { type: 'api', key: ' sk-kimi-test ' },
      other: { type: 'api', key: 'ignored' },
    }, null, 2));

    const env = await resolveModelCredentialEnv({ XDG_DATA_HOME: dataHome }, dir);
    assert.equal(env.FORGE_DSH_KIMI_CODING_API_KEY, 'sk-kimi-test');
    assert.equal(env.FORGE_DSH_ZHIPU_CODING_API_KEY, undefined);
    assert.equal(Object.keys(env).sort().join(','), 'FORGE_DSH_KIMI_CODING_API_KEY');
  });
});

test('resolveModelCredentialEnv returns empty env when auth.json is missing or invalid', async () => {
  await withTemp(async (dir) => {
    const missing = await resolveModelCredentialEnv({ XDG_DATA_HOME: join(dir, 'missing') }, dir);
    assert.deepEqual(missing, {});

    const dataHome = join(dir, 'share');
    await mkdir(join(dataHome, 'wrenyard', 'runtime'), { recursive: true });
    await writeFile(runtimeAuthPath({ XDG_DATA_HOME: dataHome }, dir), 'not-json');
    const invalid = await resolveModelCredentialEnv({ XDG_DATA_HOME: dataHome }, dir);
    assert.deepEqual(invalid, {});
  });
});

test('defaultMcpUrl prefers WRENYARD_* then FOREMAN_* then the shared default', () => {
  assert.equal(defaultMcpUrl({ WRENYARD_MCP_URL: 'http://a/mcp', FOREMAN_MCP_URL: 'http://b/mcp' }), 'http://a/mcp');
  assert.equal(defaultMcpUrl({ FOREMAN_MCP_URL: 'http://b/mcp' }), 'http://b/mcp');
  assert.equal(defaultMcpUrl({}), DEFAULT_WRENYARD_MCP_URL);
});
