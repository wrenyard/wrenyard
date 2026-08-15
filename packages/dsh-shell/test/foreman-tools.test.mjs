import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import plugin, { wrenyardIpcPath } from '../src/foreman-tools.mjs';

const tmpDirs = [];

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
    req.on('end', () => {
      let msg = {};
      try {
        msg = JSON.parse(body || '{}');
      } catch {
        // malformed request: answer nothing useful
      }
      const reply = handler(msg);
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
    sock.on('data', (chunk) => {
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
        sock.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: handler(msg) })}\n`);
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

const deadIpc = () => path.join(mkTmp(), 'no-ipc.sock');

test('filters session/work/workflow_* tools and registers the remaining catalog', async () => {
  const server = await startMcp((msg) => {
    if (msg.method === 'tools/list') {
      return okReply(msg, {
        tools: [
          { name: 'sessions_list', description: 'blocked' },
          { name: 'session_send', description: 'blocked' },
          { name: 'work_send', description: 'blocked' },
          { name: 'work_transcript', description: 'blocked' },
          { name: 'workflow_run', description: 'blocked' },
          { name: 'task_run', description: 'Run a task', inputSchema: { type: 'object', properties: { task_id: { type: 'string' } } } },
          { name: 'task_status', description: 'Task status', inputSchema: { type: 'object' } },
          { name: 'task_output', description: 'Task output', inputSchema: { type: 'object' } },
          { name: 'project_list', description: 'List projects', inputSchema: { type: 'object' } },
        ],
      });
    }
    return okReply(msg, { content: [{ type: 'text', text: '{}' }] });
  });
  const ctx = makeCtx();
  await withEnv({ WRENYARD_MCP_URL: sseUrl(server), WRENYARD_IPC_PATH: deadIpc() }, () => plugin.apply(ctx));
  server.close();

  const names = ctx.registered.map((definition) => definition.name).sort();
  for (const blocked of ['sessions_list', 'session_send', 'work_send', 'work_transcript', 'workflow_run']) {
    assert.ok(!names.includes(blocked), `${blocked} must be filtered out`);
  }
  for (const kept of ['task_run', 'task_status', 'task_output', 'project_list', 'task_wait']) {
    assert.ok(names.includes(kept), `${kept} must be registered`);
  }
  assert.equal(names.filter((n) => n === 'task_wait').length, 1, 'task_wait synthesized exactly once');

  const taskRun = ctx.registered.find((d) => d.name === 'task_run');
  const projectList = ctx.registered.find((d) => d.name === 'project_list');
  assert.equal(taskRun.isConcurrencySafe(), false, 'task_run is not concurrency safe');
  assert.equal(projectList.isConcurrencySafe(), true, 'project_list is concurrency safe');
  assert.ok(taskRun.output && typeof taskRun.output.render === 'function');
  assert.equal(taskRun.parameters.type, 'object');
});

test('tools/call unwraps structuredContent/content and surfaces isError', async () => {
  const server = await startMcp((msg) => {
    if (msg.method === 'tools/list') {
      return okReply(msg, { tools: [{ name: 'project_list', description: 'List projects', inputSchema: { type: 'object' } }] });
    }
    if (msg.method === 'tools/call') {
      if (msg.params.arguments && msg.params.arguments.fail) {
        return okReply(msg, { isError: true, content: [{ type: 'text', text: 'boom: project exploded' }] });
      }
      return okReply(msg, { structuredContent: { projects: [{ name: 'alpha' }] }, content: [{ type: 'text', text: 'alpha' }] });
    }
    return okReply(msg, {});
  });
  const ctx = makeCtx();
  await withEnv({ WRENYARD_MCP_URL: sseUrl(server), WRENYARD_IPC_PATH: deadIpc() }, () => plugin.apply(ctx));

  const execute = ctx.registered.find((d) => d.name === 'project_list').execute;
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

test('fails loudly when Wrenyard MCP lists no usable tools', async () => {
  const server = await startMcp((msg) => okReply(msg, { tools: [] }));
  const ctx = makeCtx();
  await assert.rejects(
    withEnv({ WRENYARD_MCP_URL: sseUrl(server), WRENYARD_IPC_PATH: deadIpc() }, () => plugin.apply(ctx)),
    /Wrenyard: MCP listed no usable tools/,
  );
  server.close();
});

test('wrenyardIpcPath prefers WRENYARD_IPC_PATH, falls back to legacy, then shared wrenyard.sock', () => {
  assert.equal(
    wrenyardIpcPath({ WRENYARD_IPC_PATH: '/run/wrenyard.sock', FOREMAN_IPC_PATH: '/run/foreman.sock' }),
    '/run/wrenyard.sock',
  );
  assert.equal(wrenyardIpcPath({ FOREMAN_IPC_PATH: '/run/foreman.sock' }), '/run/foreman.sock');
  const fallback = wrenyardIpcPath({});
  assert.ok(fallback.endsWith('wrenyard.sock'), `shared default ends with wrenyard.sock: ${fallback}`);
});

test('WRENYARD_MCP_URL takes precedence over legacy FOREMAN_MCP_URL', async () => {
  const server = await startMcp((msg) => {
    if (msg.method === 'tools/list') {
      return okReply(msg, { tools: [{ name: 'project_list', description: 'List projects', inputSchema: { type: 'object' } }] });
    }
    return okReply(msg, {});
  });
  const ctx = makeCtx();
  await withEnv({
    WRENYARD_MCP_URL: sseUrl(server),
    FOREMAN_MCP_URL: 'http://127.0.0.1:9/mcp',
    WRENYARD_IPC_PATH: deadIpc(),
  }, () => plugin.apply(ctx));
  const names = ctx.registered.map((definition) => definition.name);
  assert.ok(names.includes('project_list'), 'WRENYARD_MCP_URL must win over FOREMAN_MCP_URL');
  server.close();
});

test('legacy FOREMAN_* env vars remain honored when WRENYARD_* are absent', async () => {
  const server = await startMcp((msg) => {
    if (msg.method === 'tools/list') {
      return okReply(msg, { tools: [{ name: 'project_list', description: 'List projects', inputSchema: { type: 'object' } }] });
    }
    return okReply(msg, {});
  });
  const ctx = makeCtx();
  await withEnv({ FOREMAN_MCP_URL: sseUrl(server), FOREMAN_IPC_PATH: deadIpc() }, () => plugin.apply(ctx));
  const names = ctx.registered.map((definition) => definition.name);
  assert.ok(names.includes('project_list'), 'legacy FOREMAN_* env must still configure the bridge');
  server.close();
});

test('task_run waits by default and returns terminal output', async () => {
  let statusCalls = 0;
  const server = await startMcp((msg) => {
    if (msg.method === 'tools/list') {
      return okReply(msg, {
        tools: [
          { name: 'task_run', description: 'Run a task', inputSchema: { type: 'object' } },
          { name: 'task_status', description: 'Task status', inputSchema: { type: 'object' } },
          { name: 'task_output', description: 'Task output', inputSchema: { type: 'object' } },
        ],
      });
    }
    if (msg.method === 'tools/call') {
      if (msg.params.name === 'task_run') {
        return okReply(msg, { structuredContent: { task_run_id: 't-1', status: 'queued' } });
      }
      if (msg.params.name === 'task_status') {
        statusCalls += 1;
        assert.equal(msg.params.arguments.task_run_id, 't-1');
        return okReply(msg, { structuredContent: { task_run_id: 't-1', status: statusCalls >= 3 ? 'done' : 'running' } });
      }
      if (msg.params.name === 'task_output') {
        assert.equal(msg.params.arguments.task_run_id, 't-1');
        return okReply(msg, { structuredContent: { task_run_id: 't-1', status: 'done', stdout: 'built ok' } });
      }
    }
    return okReply(msg, {});
  });
  const ctx = makeCtx();
  await withEnv({ WRENYARD_MCP_URL: sseUrl(server), WRENYARD_IPC_PATH: deadIpc() }, () => plugin.apply(ctx));

  const taskRun = ctx.registered.find((d) => d.name === 'task_run');
  const output = await taskRun.execute({ command: 'build' }, {});
  assert.match(output, /built ok/);
  assert.match(output, /done/);
  assert.ok(statusCalls >= 3, 'task_status polled until terminal');
  server.close();
});

test('AbortSignal cancels an in-flight task wait', async () => {
  const server = await startMcp((msg) => {
    if (msg.method === 'tools/list') {
      return okReply(msg, {
        tools: [
          { name: 'task_run', description: 'Run a task', inputSchema: { type: 'object' } },
          { name: 'task_status', description: 'Task status', inputSchema: { type: 'object' } },
          { name: 'task_output', description: 'Task output', inputSchema: { type: 'object' } },
        ],
      });
    }
    if (msg.method === 'tools/call' && msg.params.name === 'task_run') {
      return okReply(msg, { structuredContent: { task_run_id: 't-9' } });
    }
    if (msg.method === 'tools/call' && msg.params.name === 'task_status') {
      return okReply(msg, { structuredContent: { task_run_id: 't-9', status: 'running' } });
    }
    return okReply(msg, {});
  });
  const ctx = makeCtx();
  await withEnv({ WRENYARD_MCP_URL: sseUrl(server), WRENYARD_IPC_PATH: deadIpc() }, () => plugin.apply(ctx));

  const taskRun = ctx.registered.find((d) => d.name === 'task_run');
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(
    () => taskRun.execute({}, { signal: controller.signal }),
    (err) => err.name === 'AbortError',
  );
  server.close();
});

test('registers NDJSON IPC extras only when absent from the MCP catalog', async () => {
  const ipcSocket = path.join(mkTmp(), 'foreman.sock');
  const ipcServer = await startIpc(ipcSocket, (msg) => {
    if (msg.method === 'health.ping') return { ok: true, pid: 42 };
    if (msg.method === 'project.list') return { projects: [{ name: 'demo' }] };
    if (msg.method === 'workspace.doc.list') return { documents: [{ id: 'd1' }] };
    return { ok: true };
  });
  const server = await startMcp((msg) => {
    if (msg.method === 'tools/list') {
      return okReply(msg, {
        tools: [
          { name: 'task_run', description: 'Run a task', inputSchema: { type: 'object' } },
          { name: 'task_status', description: 'Task status', inputSchema: { type: 'object' } },
          { name: 'task_output', description: 'Task output', inputSchema: { type: 'object' } },
          { name: 'workspace_doc_list', description: 'MCP version', inputSchema: { type: 'object' } },
        ],
      });
    }
    return okReply(msg, {});
  });
  const ctx = makeCtx();
  await withEnv({ WRENYARD_MCP_URL: sseUrl(server), WRENYARD_IPC_PATH: ipcSocket }, () => plugin.apply(ctx));

  const names = ctx.registered.map((definition) => definition.name);
  for (const extra of ['project_list', 'project_describe', 'project_commit_log', 'worktree_list', 'agent_list', 'agent_model_list', 'workspace_doc_read']) {
    assert.ok(names.includes(extra), `${extra} registered via IPC`);
  }
  const docList = ctx.registered.find((d) => d.name === 'workspace_doc_list');
  assert.match(docList.description, /MCP version/, 'MCP-provided tool is not overridden');

  const projectList = ctx.registered.find((d) => d.name === 'project_list');
  const output = await projectList.execute({}, {});
  assert.match(output, /demo/);
  server.close();
  ipcServer.close();
});
