import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { resolveWrenyardConnectionEnv, startDshWeb } from '../src/dsh-process.js';

const READY_SCRIPT = `
const http = require('node:http');
const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('ok');
});
server.listen(0, '127.0.0.1', () => {
  console.log('dsh web: http://127.0.0.1:' + server.address().port);
});
const shutdown = () => server.close(() => process.exit(0));
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
`;

const ENV_SCRIPT = `
const fs = require('node:fs');
const http = require('node:http');
const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('ok');
});
server.listen(0, '127.0.0.1', () => {
  console.log('dsh web: http://127.0.0.1:' + server.address().port);
  fs.writeFileSync('child-env.json', JSON.stringify({
    WRENYARD_IPC_PATH: process.env.WRENYARD_IPC_PATH || null,
    WRENYARD_MCP_URL: process.env.WRENYARD_MCP_URL || null,
    WRENYARD_MCP_SENDER: process.env.WRENYARD_MCP_SENDER || null,
    FORGE_DSH_KIMI_CODING_API_KEY: process.env.FORGE_DSH_KIMI_CODING_API_KEY || null,
    argv: process.argv.slice(2),
    execArgv: process.execArgv,
  }));
});
const shutdown = () => server.close(() => process.exit(0));
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
`;

const SILENT_SCRIPT = `
const fs = require('node:fs');
fs.writeFileSync('child.pid', String(process.pid));
setInterval(() => {}, 1000);
`;

const NEVER_LISTENS_SCRIPT = `
const fs = require('node:fs');
fs.writeFileSync('child.pid', String(process.pid));
console.log('dsh web: http://127.0.0.1:59999');
setInterval(() => {}, 1000);
`;

const EARLY_EXIT_SCRIPT = `
console.error('boom: dsh failed to start');
process.exit(1);
`;

const NOISY_EXIT_SCRIPT = `
const c = 'x'.repeat(1024);
for (let i = 0; i < 256; i++) process.stderr.write(c);
process.exit(1);
`;

async function withTemp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-process-test-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function writeFixture(dir: string, name: string, content: string): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, content);
  return path;
}

function baseOptions(dir: string, bin: string, timeoutMs = 5_000) {
  return {
    binPath: bin,
    profileHome: join(dir, 'dsh-home'),
    workspace: dir,
    command: [process.execPath, bin],
    timeoutMs,
  };
}

function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

test('startDshWeb resolves with a verified loopback URL', async () => {
  await withTemp(async (dir) => {
    const bin = await writeFixture(dir, 'ready.js', READY_SCRIPT);
    const handle = await startDshWeb(baseOptions(dir, bin));

    assert.match(handle.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.ok(handle.child.pid);

    const response = await fetch(handle.url);
    assert.equal(response.status, 200);

    await handle.stop();
  });
});

test('stop terminates the child process', async () => {
  await withTemp(async (dir) => {
    const bin = await writeFixture(dir, 'ready.js', READY_SCRIPT);
    const handle = await startDshWeb(baseOptions(dir, bin));

    await handle.stop();
    assert.ok(
      handle.child.exitCode !== null || handle.child.signalCode !== null,
      'child must be terminal immediately after stop() resolves',
    );
  });
});

test('stop is idempotent under concurrent calls', async () => {
  await withTemp(async (dir) => {
    const bin = await writeFixture(dir, 'ready.js', READY_SCRIPT);
    const handle = await startDshWeb(baseOptions(dir, bin));

    await Promise.all([handle.stop(), handle.stop(), handle.stop()]);
    assert.ok(
      handle.child.exitCode !== null || handle.child.signalCode !== null,
      'child must be terminal after concurrent stop() calls resolve',
    );
  });
});

test('startDshWeb rejects on timeout with bounded stderr', async () => {
  await withTemp(async (dir) => {
    const bin = await writeFixture(dir, 'silent.js', SILENT_SCRIPT);
    await assert.rejects(
      startDshWeb(baseOptions(dir, bin, 1_500)),
      /did not become ready within/,
    );
    const pid = Number(await readFile(join(dir, 'child.pid'), 'utf8'));
    assert.ok(!pidExists(pid), 'timeout rejection must not leave the child alive');
  });
});

test('startDshWeb rejects when the advertised server never answers', async () => {
  await withTemp(async (dir) => {
    const bin = await writeFixture(dir, 'never-listens.js', NEVER_LISTENS_SCRIPT);
    await assert.rejects(
      startDshWeb(baseOptions(dir, bin, 1_500)),
      /did not become ready within/,
    );
    const pid = Number(await readFile(join(dir, 'child.pid'), 'utf8'));
    assert.ok(!pidExists(pid), 'unanswerable-server rejection must not leave the child alive');
  });
});

test('startDshWeb rejects on early exit with stderr included', async () => {
  await withTemp(async (dir) => {
    const bin = await writeFixture(dir, 'early.js', EARLY_EXIT_SCRIPT);
    await assert.rejects(
      startDshWeb(baseOptions(dir, bin)),
      /exited before ready.*boom: dsh failed to start/s,
    );
  });
});

test('startDshWeb bounds stderr in rejection messages', async () => {
  await withTemp(async (dir) => {
    const bin = await writeFixture(dir, 'noisy.js', NOISY_EXIT_SCRIPT);
    await assert.rejects(
      startDshWeb(baseOptions(dir, bin)),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        return message.includes('stderr:') && message.length < 64 * 1024;
      },
    );
  });
});

test('resolveWrenyardConnectionEnv prefers WRENYARD_* and falls back to FOREMAN_*', () => {
  assert.deepEqual(
    resolveWrenyardConnectionEnv({
      WRENYARD_IPC_PATH: '/run/wrenyard.sock',
      FOREMAN_IPC_PATH: '/run/foreman.sock',
      FOREMAN_MCP_URL: 'http://legacy/mcp',
    }),
    { WRENYARD_IPC_PATH: '/run/wrenyard.sock', WRENYARD_MCP_URL: 'http://legacy/mcp' },
  );
  assert.deepEqual(
    resolveWrenyardConnectionEnv({
      FOREMAN_IPC_PATH: '/run/foreman.sock',
      FOREMAN_MCP_URL: 'http://legacy/mcp',
      FOREMAN_MCP_SENDER: 'pet',
    }),
    {
      WRENYARD_IPC_PATH: '/run/foreman.sock',
      WRENYARD_MCP_URL: 'http://legacy/mcp',
      WRENYARD_MCP_SENDER: 'pet',
    },
  );
  assert.deepEqual(resolveWrenyardConnectionEnv({}), {});
});

test('startDshWeb propagates the Wrenyard connection env to the child', async () => {
  const previous: Record<string, string | undefined> = {
    WRENYARD_IPC_PATH: process.env.WRENYARD_IPC_PATH,
    FOREMAN_IPC_PATH: process.env.FOREMAN_IPC_PATH,
    WRENYARD_MCP_URL: process.env.WRENYARD_MCP_URL,
    FOREMAN_MCP_URL: process.env.FOREMAN_MCP_URL,
    WRENYARD_MCP_SENDER: process.env.WRENYARD_MCP_SENDER,
    FOREMAN_MCP_SENDER: process.env.FOREMAN_MCP_SENDER,
  };
  try {
    process.env.WRENYARD_IPC_PATH = '/tmp/wrenyard.sock';
    process.env.FOREMAN_IPC_PATH = '/tmp/legacy.sock';
    process.env.WRENYARD_MCP_URL = 'http://127.0.0.1:8787/mcp';
    process.env.FOREMAN_MCP_URL = 'http://legacy/mcp';
    delete process.env.WRENYARD_MCP_SENDER;
    process.env.FOREMAN_MCP_SENDER = 'pet';

    await withTemp(async (dir) => {
      const bin = await writeFixture(dir, 'env.js', ENV_SCRIPT);
      const handle = await startDshWeb(baseOptions(dir, bin));
      await handle.stop();

      const childEnv = JSON.parse(await readFile(join(dir, 'child-env.json'), 'utf8'));
      assert.equal(childEnv.WRENYARD_IPC_PATH, '/tmp/wrenyard.sock');
      assert.equal(childEnv.WRENYARD_MCP_URL, 'http://127.0.0.1:8787/mcp');
      assert.equal(childEnv.WRENYARD_MCP_SENDER, 'pet', 'legacy sender used when WRENYARD sender absent');
    });
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('startDshWeb explicit wrenyardEnv overrides values derived from process.env', async () => {
  await withTemp(async (dir) => {
    const bin = await writeFixture(dir, 'env.js', ENV_SCRIPT);
    const handle = await startDshWeb({
      ...baseOptions(dir, bin),
      wrenyardEnv: { WRENYARD_IPC_PATH: '/run/explicit.sock', WRENYARD_MCP_URL: 'http://explicit/mcp' },
    });
    await handle.stop();

    const childEnv = JSON.parse(await readFile(join(dir, 'child-env.json'), 'utf8'));
    assert.equal(childEnv.WRENYARD_IPC_PATH, '/run/explicit.sock');
    assert.equal(childEnv.WRENYARD_MCP_URL, 'http://explicit/mcp');
  });
});

test('startDshWeb puts --patch before web flags and injects extraEnv without dropping it', async () => {
  await withTemp(async (dir) => {
    const bin = await writeFixture(dir, 'env.js', ENV_SCRIPT);
    const patchPath = join(dir, 'forge-model-patch.yaml');
    await writeFile(patchPath, '- id: llm-pi-ai\n');
    const handle = await startDshWeb({
      ...baseOptions(dir, bin),
      patchPath,
      extraEnv: { FORGE_DSH_KIMI_CODING_API_KEY: 'sk-test-not-for-logs' },
    });
    await handle.stop();

    const childEnv = JSON.parse(await readFile(join(dir, 'child-env.json'), 'utf8'));
    const argv = childEnv.argv as string[];
    const patchAt = argv.indexOf('--patch');
    assert.ok(patchAt >= 0, 'expected --patch on the DSH argv');
    assert.equal(argv[patchAt + 1], patchPath);
    assert.ok(patchAt < argv.indexOf('--host'), '--patch must precede --host');
    assert.ok(patchAt < argv.indexOf('--port'), '--patch must precede --port');
    assert.equal(childEnv.FORGE_DSH_KIMI_CODING_API_KEY, 'sk-test-not-for-logs');
  });
});

test('startDshWeb puts --expose-internals in execArgv, not DSH argv', async () => {
  await withTemp(async (dir) => {
    const bin = await writeFixture(dir, 'env.js', ENV_SCRIPT);
    const handle = await startDshWeb({
      binPath: bin,
      profileHome: join(dir, 'dsh-home'),
      workspace: dir,
      runAsElectron: false,
      timeoutMs: 5_000,
    });
    await handle.stop();

    const childEnv = JSON.parse(await readFile(join(dir, 'child-env.json'), 'utf8'));
    const execArgv = childEnv.execArgv as string[];
    const argv = childEnv.argv as string[];
    assert.ok(execArgv.includes('--expose-internals'), 'HMR requires --expose-internals in process.execArgv');
    assert.ok(!argv.includes('--expose-internals'), 'flag must not leak into DSH argv');
  });
});
