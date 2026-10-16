import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { AgentRequest } from '@wrenyard/agent-client';
import { launchOpenCode } from '../src/launch.ts';

const MODEL = 'ling-3.0-flash-fin-free';
const SELECTOR = `opencode/${MODEL}`;
const FINAL_INSTRUCTION = 'Final instruction: reply with exactly STDIN-UNIT-OK.';

/**
 * Filler paragraph repeated to build a prompt far larger than any command-line
 * limit, so the large-prompt case is a real reproduction rather than a token
 * one.
 */
const FILLER = 'The quick brown fox jumps over the lazy dog near the riverbank at dawn. ';

interface Sandbox {
  readonly root: string;
  readonly binDir: string;
  readonly stateDir: string;
  readonly configDir: string;
}

/**
 * Fresh isolated sandbox per case. Every writable root is a private temp dir and
 * no real user state or config is ever touched.
 */
async function withSandbox(body: (sandbox: Sandbox) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'wy-opencode-launch-'));
  const binDir = join(root, 'bin');
  const stateDir = join(root, 'state');
  const configDir = join(root, 'config');
  await mkdir(binDir, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  await mkdir(configDir, { recursive: true });
  // findExecutable only performs an F_OK existence check, so a plain file named
  // `opencode` is enough to make the client look installed (no chmod/exec).
  await writeFile(join(binDir, 'opencode'), '');
  try {
    await body({ root, binDir, stateDir, configDir });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function envOf(sandbox: Sandbox): NodeJS.ProcessEnv {
  return {
    PATH: sandbox.binDir,
    WRENYARD_STATE_HOME: sandbox.stateDir,
    WRENYARD_CONFIG_HOME: sandbox.configDir,
  };
}

function requestOf(prompt: string, cwd: string): AgentRequest {
  return {
    model: MODEL,
    provider: 'opencode-zen',
    mode: 'native',
    protocol: 'openai_chat',
    prompt,
    cwd,
    reasoningEffort: 'default',
  };
}

test('a very large prompt is delivered on stdin, never in argv', async () => {
  await withSandbox(async (sandbox) => {
    const cwd = join(sandbox.root, '路径 测试');
    await mkdir(cwd, { recursive: true });
    const prompt = `${FILLER.repeat(4500)}${FINAL_INSTRUCTION}`;
    assert.ok(Buffer.byteLength(prompt, 'utf8') > 300_000, 'the reproduction prompt must be roughly 300KB');

    const spec = await launchOpenCode(requestOf(prompt, cwd), envOf(sandbox));

    assert.equal(spec.stdin, prompt, 'the whole prompt must ride stdin unchanged');
    for (const arg of spec.args)
      assert.ok(!arg.includes(prompt), 'the prompt text must never appear in an argv element');
    assert.ok(
      [spec.executable, ...spec.args].join(' ').length < 32767,
      'executable plus joined args must stay below the Windows 32k command-line limit',
    );
    assert.equal(spec.args.at(-1), '--pure', 'no trailing positional prompt argument is allowed');
  });
});

test('a small prompt regression still rides stdin with the model selector in argv', async () => {
  await withSandbox(async (sandbox) => {
    const prompt = 'Reply with exactly STDIN-UNIT-OK.';
    const spec = await launchOpenCode(requestOf(prompt, sandbox.root), envOf(sandbox));

    assert.equal(spec.stdin, prompt);
    const modelFlag = spec.args.indexOf('-m');
    assert.ok(modelFlag >= 0, 'the model flag must be present');
    assert.equal(spec.args[modelFlag + 1], SELECTOR);
    for (const arg of spec.args)
      assert.ok(!arg.includes(prompt), 'the prompt text must never appear in an argv element');
  });
});
