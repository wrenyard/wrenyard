import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import plugin, { wrenyardIpcPath } from '../src/foreman-tools.mjs';

const tmpDirs = [];
let ipcSequence = 0;

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function mkTmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-shell-test-'));
  tmpDirs.push(dir);
  return dir;
}

function withEnv(overrides, fn) {
  const keys = Object.keys(overrides);
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const key of keys) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
    });
}

function startMcp(handler) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', async () => {
      let msg = {};
      try {
        msg = JSON.parse(body || '{}');
      } catch {
        // malformed request: answer nothing useful
      }
      const reply = await handler(msg);
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.end(`data: ${JSON.stringify(reply)}\n\n`);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function startIpc(socketPath, handler) {
  const server = net.createServer((sock) => {
    let buffer = '';
    sock.on('data', async (chunk) => {
      buffer += chunk.toString();
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        let msg = {};
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        const result = await handler(msg);
        if (!sock.destroyed) {
          sock.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })}\n`);
        }
      }
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.removeListener('error', reject);
      resolve(server);
    });
  });
}

function okReply(msg, result) {
  return { jsonrpc: '2.0', id: msg.id, result };
}

function sseUrl(server) {
  return `http://127.0.0.1:${server.address().port}/mcp`;
}

function makeCtx() {
  const registered = [];
  return {
    tools: {
      register(definition) {
        registered.push(definition);
      },
    },
    logger: { info() {}, warn() {}, error() {} },
    registered,
  };
}

function testIpcPath(name) {
  ipcSequence += 1;
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\wrenyard-dsh-shell-test-${process.pid}-${ipcSequence}-${name}`
    : path.join(mkTmp(), `${name}.sock`);
}

const deadIpc = () => testIpcPath('missing');

const CANONICAL_TOOLS = [
  { name: 'task_list', description: 'List tasks', inputSchema: { type: 'object', properties: { repo: { type: 'string' } } } },
  { name: 'task_describe', description: 'Describe a task', inputSchema: { type: 'object', properties: { task_id: { type: 'string' } } } },
  { name: 'task_run', description: 'Run a task', inputSchema: { type: 'object', properties: { command: { type: 'string' } } } },
];

function canonicalListFixture(msg) {
  if (msg.method === 'tools/list') return okReply(msg, { tools: CANONICAL_TOOLS });
  if (msg.method === 'tools/call') {
    const name = msg.params.name;
    if (name === 'task_list') return okReply(msg, { structuredContent: { tasks: [{ id: 'a' }] }, content: [{ type: 'text', text: 'a' }] });
    if (name === 'task_describe') return okReply(msg, { structuredContent: { task_id: 'a', status: 'queued' } });
    if (name === 'task_run') {
      const id = msg.params.arguments && msg.params.arguments.task_id;
      return okReply(msg, { structuredContent: { task_run_id: id || 't-1', status: 'queued' } });
    }
  }
  return okReply(msg, { content: [{ type: 'text', text: '{}' }] });
}

test('registers exactly the three canonical task aliases with the correct contract', async () => {
  const server = await startMcp(canonicalListFixture);
  const ctx = makeCtx();
  await withEnv({ WRENYARD_MCP_URL: sseUrl(server), WRENYARD_IPC_PATH: deadIpc() }, () => plugin.apply(ctx));
  server.close();

  const names = ctx.registered.map((definition) => definition.name).sort();
  assert.deepEqual(names, ['describe_task', 'list_task', 'run_task']);

  for (const definition of ctx.registered) {
    assert.equal(definition.isConcurrencySafe(), true, `${definition.name} is concurrency safe`);
    assert.ok(definition.output && typeof definition.output.render === 'function');
  }

  const listTask = ctx.registered.find((d) => d.name === 'list_task');
  const describeTask = ctx.registered.find((d) => d.name === 'describe_task');
  const runTask = ctx.registered.find((d) => d.name === 'run_task');

  assert.ok(typeof listTask.timeoutMs === 'number' && listTask.timeoutMs > 0, 'list_task keeps a bounded timeout');
  assert.ok(typeof describeTask.timeoutMs === 'number' && describeTask.timeoutMs > 0, 'describe_task keeps a bounded timeout');
  assert.equal(runTask.timeoutMs, undefined, 'run_task omits timeoutMs so DSH enforces no deadline');

  assert.equal(runTask.parameters.type, 'object', 'run_task schema is sanitized to an object');
});

test('tools/call unwraps structuredContent/content and surfaces isError', async () => {
  const server = await startMcp((msg) => {
    if (msg.method === 'tools/list') return okReply(msg, { tools: CANONICAL_TOOLS });
    if (msg.method === 'tools/call') {
      if (msg.params.arguments && msg.params.arguments.fail) {
        return okReply(msg, { isError: true, content: [{ type: 'text', text: 'boom: project exploded' }] });
      }
      return okReply(msg, { structuredContent: { tasks: [{ name: 'alpha' }] }, content: [{ type: 'text', text: 'alpha' }] });
    }
    return okReply(msg, {});
  });
  const ctx = makeCtx();
  await withEnv({ WRENYARD_MCP_URL: sseUrl(server), WRENYARD_IPC_PATH: deadIpc() }, () => plugin.apply(ctx));

  const execute = ctx.registered.find((d) => d.name === 'list_task').execute;
  const output = await execute({}, {});
  assert.match(output, /alpha/);
  await assert.rejects(() => execute({ fail: true }, {}), /boom: project exploded/);
  server.close();
});

test('fails loudly when Wrenyard MCP is unavailable', async () => {
  const server = await startMcp(() => ({ jsonrpc: '2.0', id: 1, error: { code: -32001, message: 'denied' } }));
  const ctx = makeCtx();
  await assert.rejects(
    withEnv({ WRENYARD_MCP_URL: sseUrl(server), WRENYARD_IPC_PATH: deadIpc() }, () => plugin.apply(ctx)),
    /Wrenyard: MCP is unavailable/,
  );
  server.close();
});

test('fails loudly when Wrenyard MCP catalog is missing a required canonical task tool', async () => {
  const server = await startMcp((msg) => {
    if (msg.method === 'tools/list') return okReply(msg, { tools: [{ name: 'project_list', description: 'List', inputSchema: { type: 'object' } }] });
    return okReply(msg, {});
  });
  const ctx = makeCtx();
  await assert.rejects(
    withEnv({ WRENYARD_MCP_URL: sseUrl(server), WRENYARD_IPC_PATH: deadIpc() }, () => plugin.apply(ctx)),
    /Wrenyard: MCP catalog missing required task tool/,
  );
  server.close();
});

test('wrenyardIpcPath prefers non-blank overrides, then uses the daemon platform default', () => {
  assert.equal(
    wrenyardIpcPath({ WRENYARD_IPC_PATH: '/run/wrenyard.sock', FOREMAN_IPC_PATH: '/run/foreman.sock' }),
    '/run/wrenyard.sock',
  );
  assert.equal(wrenyardIpcPath({ FOREMAN_IPC_PATH: '/run/foreman.sock' }), '/run/foreman.sock');
  assert.equal(wrenyardIpcPath({ WRENYARD_IPC_PATH: ' ', FOREMAN_IPC_PATH: '' }),
    process.platform === 'win32' ? '\\\\.\\pipe\\wrenyard' : '/tmp/wrenyard.sock');
});

test('WRENYARD_MCP_URL takes precedence over legacy FOREMAN_MCP_URL', async () => {
  const server = await startMcp(canonicalListFixture);
  const ctx = makeCtx();
  await withEnv({
    WRENYARD_MCP_URL: sseUrl(server),
    FOREMAN_MCP_URL: 'http://127.0.0.1:9/mcp',
    WRENYARD_IPC_PATH: deadIpc(),
  }, () => plugin.apply(ctx));
  const names = ctx.registered.map((definition) => definition.name);
  assert.ok(names.includes('list_task'), 'WRENYARD_MCP_URL must win over FOREMAN_MCP_URL');
  server.close();
});

test('legacy FOREMAN_* env vars remain honored when WRENYARD_* are absent', async () => {
  const server = await startMcp(canonicalListFixture);
  const ctx = makeCtx();
  await withEnv({ FOREMAN_MCP_URL: sseUrl(server), FOREMAN_IPC_PATH: deadIpc() }, () => plugin.apply(ctx));
  const names = ctx.registered.map((definition) => definition.name);
  assert.ok(names.includes('list_task'), 'legacy FOREMAN_* env must still configure the bridge');
  server.close();
});

const TERMINAL_ENVELOPES = [
  { status: 'done', stdout: 'built ok' },
  { status: 'failed', error: 'kaboom' },
  { status: 'cancelled' },
  { status: 'interrupted' },
];

test('run_task creates once, waits once over IPC, and passes through terminal envelopes', async () => {
  for (const envelope of TERMINAL_ENVELOPES) {
    const ipcCalls = [];
    const ipcSocket = testIpcPath('run');
    const ipcServer = await startIpc(ipcSocket, (msg) => {
      ipcCalls.push(msg);
      return envelope;
    });
    const taskCallNames = [];
    const server = await startMcp((msg) => {
      if (msg.method === 'tools/list') return okReply(msg, { tools: CANONICAL_TOOLS });
      if (msg.method === 'tools/call') {
        taskCallNames.push(msg.params.name);
        if (msg.params.name === 'task_run') {
          return okReply(msg, { structuredContent: { task_run_id: 't-1', status: 'queued' } });
        }
      }
      return okReply(msg, {});
    });
    const ctx = makeCtx();
    await withEnv({ WRENYARD_MCP_URL: sseUrl(server), WRENYARD_IPC_PATH: ipcSocket }, () => plugin.apply(ctx));

    const runTask = ctx.registered.find((d) => d.name === 'run_task');
    const output = await runTask.execute({ command: 'build' }, {});
    assert.match(output, new RegExp(envelope.status));

    assert.equal(ipcCalls.length, 1, `exactly one task.run.wait for ${envelope.status}`);
    assert.equal(ipcCalls[0].method, 'task.run.wait');
    assert.equal(ipcCalls[0].params.task_run_id, 't-1');
    assert.deepEqual(taskCallNames, ['task_run'], 'no task_status/task_output polling calls');

    server.close();
    ipcServer.close();
  }
});

test('concurrent run_task calls use distinct ids with no cross-delivery or duplicate wait', async () => {
  const ipcCalls = [];
  const ipcSocket = testIpcPath('concurrent');
  const ipcServer = await startIpc(ipcSocket, (msg) => {
    ipcCalls.push(msg);
    return { task_run_id: msg.params.task_run_id, status: 'done' };
  });
  const taskCallNames = [];
  const server = await startMcp((msg) => {
    if (msg.method === 'tools/list') return okReply(msg, { tools: CANONICAL_TOOLS });
    if (msg.method === 'tools/call') {
      taskCallNames.push(msg.params.name);
      if (msg.params.name === 'task_run') {
        const id = msg.params.arguments.task_id;
        return okReply(msg, { structuredContent: { task_run_id: id, status: 'queued' } });
      }
    }
    return okReply(msg, {});
  });
  const ctx = makeCtx();
  await withEnv({ WRENYARD_MCP_URL: sseUrl(server), WRENYARD_IPC_PATH: ipcSocket }, () => plugin.apply(ctx));

  const runTask = ctx.registered.find((d) => d.name === 'run_task');
  const a = runTask.execute({ task_id: 'a-1' }, {});
  const b = runTask.execute({ task_id: 'b-2' }, {});
  const [oa, ob] = await Promise.all([a, b]);

  const ids = ipcCalls.map((m) => m.params.task_run_id).sort();
  assert.deepEqual(ids, ['a-1', 'b-2'], 'exactly one wait per distinct task');
  assert.equal(ipcCalls.length, 2, 'no duplicate wait');
  assert.ok(oa.includes('a-1') && ob.includes('b-2'), 'each call receives its own terminal envelope');
  assert.deepEqual(taskCallNames, ['task_run', 'task_run'], 'each call creates its task once');

  server.close();
  ipcServer.close();
});

test('AbortSignal aborts a pending IPC task.run.wait, cleans up the socket, and cancels the owned backend task', async () => {
  const sockets = new Set();
  const ipcCalls = [];
  const ipcSocket = testIpcPath('abort');
  const ipcServer = net.createServer((sock) => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
    sock.on('data', (chunk) => {
      const line = chunk.toString().trim();
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      ipcCalls.push(msg);
      // Hold task.run.wait open; respond immediately to task.run.cancel so the
      // cancel socket closes promptly.
      if (msg.method === 'task.run.cancel') {
        sock.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { status: 'cancelled' } })}\n`);
      }
    });
  });
  await new Promise((resolve) => ipcServer.listen(ipcSocket, resolve));

  const server = await startMcp((msg) => {
    if (msg.method === 'tools/list') return okReply(msg, { tools: CANONICAL_TOOLS });
    if (msg.method === 'tools/call' && msg.params.name === 'task_run') {
      return okReply(msg, { structuredContent: { task_run_id: 't-9' } });
    }
    return okReply(msg, {});
  });
  const ctx = makeCtx();
  await withEnv({ WRENYARD_MCP_URL: sseUrl(server), WRENYARD_IPC_PATH: ipcSocket }, () => plugin.apply(ctx));

  const runTask = ctx.registered.find((d) => d.name === 'run_task');
  const controller = new AbortController();
  const pending = runTask.execute({}, { signal: controller.signal });
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(
    () => pending,
    (err) => err.name === 'AbortError',
  );

  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(sockets.size, 0, 'IPC socket is cleaned up after abort');

  const waitCall = ipcCalls.find((c) => c.method === 'task.run.wait');
  const cancelCall = ipcCalls.find((c) => c.method === 'task.run.cancel');
  assert.ok(waitCall, 'task.run.wait was opened');
  assert.ok(cancelCall, 'owned backend task is cancelled exactly once on abort');
  assert.equal(cancelCall.params.task_run_id, 't-9');
  assert.equal(ipcCalls.filter((c) => c.method === 'task.run.cancel').length, 1, 'no duplicate cancel');

  server.close();
  ipcServer.close();
});

test('run_task with an already-aborted signal sends no task_run and no IPC', async () => {
  const ipcCalls = [];
  const ipcSocket = testIpcPath('prelaunch');
  const ipcServer = await startIpc(ipcSocket, (msg) => {
    ipcCalls.push(msg);
    return { status: 'done' };
  });
  const taskCallNames = [];
  const server = await startMcp((msg) => {
    if (msg.method === 'tools/list') return okReply(msg, { tools: CANONICAL_TOOLS });
    if (msg.method === 'tools/call') {
      taskCallNames.push(msg.params.name);
      if (msg.params.name === 'task_run') return okReply(msg, { structuredContent: { task_run_id: 't-abort' } });
    }
    return okReply(msg, {});
  });
  const ctx = makeCtx();
  await withEnv({ WRENYARD_MCP_URL: sseUrl(server), WRENYARD_IPC_PATH: ipcSocket }, () => plugin.apply(ctx));

  const runTask = ctx.registered.find((d) => d.name === 'run_task');
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => runTask.execute({}, { signal: controller.signal }),
    (err) => err.name === 'AbortError',
  );

  assert.deepEqual(taskCallNames, [], 'no task_run create on prelaunch abort');
  assert.deepEqual(ipcCalls, [], 'no IPC wait or cancel on prelaunch abort');

  server.close();
  ipcServer.close();
});

test('abort during a delayed create still returns the id and sends exactly one task.run.cancel, skipping wait', async () => {
  const ipcCalls = [];
  const ipcSocket = testIpcPath('during-create');
  const ipcServer = await startIpc(ipcSocket, (msg) => {
    ipcCalls.push(msg);
    return { status: 'cancelled' };
  });
  const taskCallNames = [];
  const server = await startMcp((msg) => {
    if (msg.method === 'tools/list') return okReply(msg, { tools: CANONICAL_TOOLS });
    if (msg.method === 'tools/call') {
      taskCallNames.push(msg.params.name);
      if (msg.params.name === 'task_run') {
        return new Promise((resolve) => {
          setTimeout(() => resolve(okReply(msg, { structuredContent: { task_run_id: 't-create' } })), 60);
        });
      }
    }
    return okReply(msg, {});
  });
  const ctx = makeCtx();
  await withEnv({ WRENYARD_MCP_URL: sseUrl(server), WRENYARD_IPC_PATH: ipcSocket }, () => plugin.apply(ctx));

  const runTask = ctx.registered.find((d) => d.name === 'run_task');
  const controller = new AbortController();
  const pending = runTask.execute({}, { signal: controller.signal });
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(
    () => pending,
    (err) => err.name === 'AbortError',
  );

  assert.deepEqual(taskCallNames, ['task_run'], 'create is allowed to finish exactly once');
  assert.ok(ipcCalls.some((c) => c.method === 'task.run.cancel'), 'created id is cancelled once');
  assert.equal(ipcCalls.filter((c) => c.method === 'task.run.cancel').length, 1, 'exactly one cancel');
  assert.equal(ipcCalls.find((c) => c.method === 'task.run.cancel').params.task_run_id, 't-create');
  assert.equal(ipcCalls.filter((c) => c.method === 'task.run.wait').length, 0, 'no wait once aborted after create');

  server.close();
  ipcServer.close();
});

test('abort during an active wait closes the wait socket and cancels the owned task exactly once', async () => {
  const ipcCalls = [];
  const ipcSocket = testIpcPath('during-wait');
  const ipcServer = await startIpc(ipcSocket, (msg) => {
    ipcCalls.push(msg);
    // Hold task.run.wait open; respond to task.run.cancel immediately.
    if (msg.method === 'task.run.cancel') return { status: 'cancelled' };
    return new Promise(() => {});
  });
  const taskCallNames = [];
  const server = await startMcp((msg) => {
    if (msg.method === 'tools/list') return okReply(msg, { tools: CANONICAL_TOOLS });
    if (msg.method === 'tools/call') {
      taskCallNames.push(msg.params.name);
      if (msg.params.name === 'task_run') return okReply(msg, { structuredContent: { task_run_id: 't-wait' } });
    }
    return okReply(msg, {});
  });
  const ctx = makeCtx();
  await withEnv({ WRENYARD_MCP_URL: sseUrl(server), WRENYARD_IPC_PATH: ipcSocket }, () => plugin.apply(ctx));

  const runTask = ctx.registered.find((d) => d.name === 'run_task');
  const controller = new AbortController();
  const pending = runTask.execute({}, { signal: controller.signal });
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(
    () => pending,
    (err) => err.name === 'AbortError',
  );

  assert.deepEqual(taskCallNames, ['task_run'], 'create happens once, no duplicate');
  assert.equal(ipcCalls.filter((c) => c.method === 'task.run.wait').length, 1, 'exactly one wait');
  assert.equal(ipcCalls.filter((c) => c.method === 'task.run.cancel').length, 1, 'exactly one cancel');
  assert.equal(ipcCalls.find((c) => c.method === 'task.run.cancel').params.task_run_id, 't-wait');

  server.close();
  ipcServer.close();
});

test('incidental wait transport disconnect rejects without cancelling the backend task', async () => {
  const ipcCalls = [];
  const ipcSocket = testIpcPath('transport');
  const ipcServer = net.createServer((sock) => {
    sock.on('data', (chunk) => {
      const line = chunk.toString().trim();
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      ipcCalls.push(msg);
      // Disconnect the wait socket to simulate an incidental transport error;
      // do NOT respond, and never run task.run.cancel.
      if (msg.method === 'task.run.wait') sock.destroy();
    });
  });
  await new Promise((resolve) => ipcServer.listen(ipcSocket, resolve));

  const server = await startMcp((msg) => {
    if (msg.method === 'tools/list') return okReply(msg, { tools: CANONICAL_TOOLS });
    if (msg.method === 'tools/call' && msg.params.name === 'task_run') {
      return okReply(msg, { structuredContent: { task_run_id: 't-x' } });
    }
    return okReply(msg, {});
  });
  const ctx = makeCtx();
  await withEnv({ WRENYARD_MCP_URL: sseUrl(server), WRENYARD_IPC_PATH: ipcSocket }, () => plugin.apply(ctx));

  const runTask = ctx.registered.find((d) => d.name === 'run_task');
  const controller = new AbortController();
  try {
    await assert.rejects(
      () => runTask.execute({}, { signal: controller.signal }),
      (err) => err.name !== 'AbortError' && /connection closed before response/i.test(err.message),
    );

    assert.equal(controller.signal.aborted, false, 'incidental failure leaves the signal intact');
    assert.equal(ipcCalls.filter((c) => c.method === 'task.run.cancel').length, 0, 'no backend cancel on transport error');
    assert.equal(ipcCalls.filter((c) => c.method === 'task.run.wait').length, 1, 'wait opened once before disconnect');
  } finally {
    server.close();
    ipcServer.close();
  }
});

test('source-level: run_task IPC wait carries no implicit deadline and TASK_TIMEOUT_MS is gone', () => {
  const source = fs.readFileSync(new URL('../src/foreman-tools.mjs', import.meta.url), 'utf8');

  assert.ok(!/TASK_TIMEOUT_MS/.test(source), 'no TASK_TIMEOUT_MS constant may exist');

  const waitCall = source.match(/function makeRunTaskExecute[\s\S]*?return canonicalOutput\(waitPayload\);/);
  assert.ok(waitCall, 'run_task invokes ipcRequest for task.run.wait');
  assert.ok(/timeout:\s*null/.test(waitCall[0]), 'task.run.wait is called with timeout:null (no implicit deadline)');
  assert.ok(!/timeout:\s*TASK_TIMEOUT_MS|timeout:\s*\d/.test(waitCall[0]), 'task.run.wait passes no numeric IPC deadline');
});
