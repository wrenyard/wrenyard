import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import plugin, { wrenyardIpcPath, deriveConversationTail, mergeOrchestrationContext } from '../src/foreman-tools.mjs';

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
  const events = new Map();
  return {
    tools: {
      register(definition) {
        registered.push(definition);
      },
    },
    on(event, listener) {
      if (!events.has(event)) events.set(event, []);
      events.get(event).push(listener);
    },
    logger: { info() {}, warn() {}, error() {} },
    registered,
    events,
  };
}

// Runs the captured tools/pre-execute waterfall in registration order. Once the
// listeners are exhausted, `terminal` stands in for DSH's own downstream
// approval/sandbox decision, so tests can tell allow short-circuits from
// forwarded calls.
async function runPreExecute(ctx, exec, terminal) {
  const listeners = ctx.events.get('tools/pre-execute') || [];
  let index = 0;
  let downstream = false;
  const next = async () => {
    const listener = listeners[index++];
    if (!listener) {
      downstream = true;
      return terminal;
    }
    return listener(exec, next);
  };
  const decision = await next();
  return { decision, downstream };
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
  { name: 'task_run', description: 'Run a task', inputSchema: { type: 'object', properties: { command: { type: 'string' }, invocation_settings: { type: 'object', properties: { mode: { type: 'string' }, explicit_runtime: { type: 'string' }, timeout_ms: { type: 'number' }, additional_instructions: { type: 'string' }, automatic: { type: 'object' } }, additionalProperties: false } }, additionalProperties: false } },
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

test('registers exactly the nine canonical task, workspace-doc, and discovery aliases with the correct contract', async () => {
  const server = await startMcp(canonicalListFixture);
  const ctx = makeCtx();
  await withEnv({ WRENYARD_MCP_URL: sseUrl(server), WRENYARD_IPC_PATH: deadIpc() }, () => plugin.apply(ctx));
  server.close();

  const names = ctx.registered.map((definition) => definition.name).sort();
  assert.deepEqual(names, [
    'create_workspace_doc',
    'describe_task',
    'list_projects',
    'list_runtimes',
    'list_task',
    'list_workspace_docs',
    'read_workspace_doc',
    'run_task',
    'update_workspace_doc',
  ]);

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

  // The canonical task_run schema exposes the shared one-shot Task settings
  // layer. run_task must surface it on its sanitized parameters and keep it
  // optional; there is no DSH-owned settings field or merge logic.
  const runSettings = runTask.parameters.properties && runTask.parameters.properties.invocation_settings;
  assert.ok(runSettings, 'run_task parameters expose invocation_settings from the canonical schema');
  assert.equal(runSettings.type, 'object');
  assert.equal(runSettings.properties.timeout_ms.type, 'number');
  assert.equal(runSettings.properties.automatic.type, 'object');
  assert.ok(
    runTask.parameters.required === undefined || !runTask.parameters.required.includes('invocation_settings'),
    'invocation_settings is never required on run_task',
  );

  // The model-facing description must send target resolution through
  // list_runtimes and forbid invented project/client/runtime values.
  assert.match(runTask.description, /list_runtimes/, 'run_task description points at list_runtimes for targets');
  assert.match(runTask.description, /available=true/, 'run_task description requires an available target');
  assert.match(runTask.description, /never invent|never guess|MUST be copied/i, 'run_task description forbids invented targets');
  assert.match(runTask.description, /list_projects|list_runtimes/, 'run_task description teaches explicit discovery');

  const listProjects = ctx.registered.find((d) => d.name === 'list_projects');
  const listRuntimes = ctx.registered.find((d) => d.name === 'list_runtimes');

  assert.equal(listProjects.parameters.type, 'object');
  assert.equal(listProjects.parameters.required, undefined, 'list_projects takes no required parameters');
  assert.deepEqual(listProjects.parameters.properties, {}, 'list_projects exposes no parameters');
  assert.match(listProjects.description, /read-only/i);
  assert.match(listProjects.description, /never invent|never guess|MUST be copied/i);

  assert.equal(listRuntimes.parameters.type, 'object');
  assert.deepEqual(listRuntimes.parameters.required, ['task_id'], 'list_runtimes requires task_id');
  assert.equal(listRuntimes.parameters.properties.project.type, 'string');
  assert.equal(listRuntimes.parameters.properties.task_id.type, 'string');
  assert.match(listRuntimes.description, /read-only/i);
  assert.match(listRuntimes.description, /available=true/, 'list_runtimes teaches the available contract');
  assert.match(listRuntimes.description, /never invent|never guess|MUST be copied/i);

  const listDocs = ctx.registered.find((d) => d.name === 'list_workspace_docs');
  const readDoc = ctx.registered.find((d) => d.name === 'read_workspace_doc');
  const createDoc = ctx.registered.find((d) => d.name === 'create_workspace_doc');
  const updateDoc = ctx.registered.find((d) => d.name === 'update_workspace_doc');

  assert.equal(listDocs.parameters.type, 'object');
  assert.equal(listDocs.parameters.required, undefined, 'list_workspace_docs takes an optional directory, nothing is required');
  assert.equal(listDocs.parameters.properties.directory.type, 'string');

  assert.deepEqual(readDoc.parameters.required, ['path']);
  assert.deepEqual(createDoc.parameters.required, ['path', 'content']);
  assert.deepEqual(updateDoc.parameters.required, ['path', 'content', 'expectedContent']);
  assert.equal(updateDoc.parameters.properties.expectedContent.type, 'string');
});

test('pre-execute waterfall allows the nine Wrenyard aliases only; bash/read/web_search flow to the downstream ask/deny policy', async () => {
  const server = await startMcp(canonicalListFixture);
  const ctx = makeCtx();
  await withEnv({ WRENYARD_MCP_URL: sseUrl(server), WRENYARD_IPC_PATH: deadIpc() }, () => plugin.apply(ctx));
  server.close();

  assert.equal((ctx.events.get('tools/pre-execute') || []).length, 1, 'the bridge registers exactly one pre-execute listener');

  const aliases = [
    'list_task',
    'describe_task',
    'run_task',
    'list_workspace_docs',
    'read_workspace_doc',
    'create_workspace_doc',
    'update_workspace_doc',
    'list_projects',
    'list_runtimes',
  ];
  for (const name of aliases) {
    const { decision, downstream } = await runPreExecute(ctx, { name, input: {} }, { kind: 'deny' });
    assert.deepEqual(decision, { kind: 'allow' }, `${name} is allowed at the bridge`);
    assert.equal(downstream, false, `${name} must not reach the downstream policy`);
  }

  for (const name of ['bash', 'read', 'web_search']) {
    const ask = await runPreExecute(ctx, { name, input: {} }, { kind: 'ask' });
    assert.equal(ask.downstream, true, `${name} flows through to the downstream policy`);
    assert.deepEqual(ask.decision, { kind: 'ask' }, `${name} keeps the downstream ask decision unchanged`);

    const deny = await runPreExecute(ctx, { name, input: {} }, { kind: 'deny' });
    assert.equal(deny.downstream, true, `${name} flows through to the downstream policy`);
    assert.deepEqual(deny.decision, { kind: 'deny' }, `${name} keeps the downstream deny decision unchanged`);
  }
});

test('workspace-doc aliases route unchanged params to exactly one owner-only IPC method each, with no MCP fallback', async () => {
  const ipcCalls = [];
  const ipcSocket = testIpcPath('doc-routing');
  const ipcServer = await startIpc(ipcSocket, (msg) => {
    ipcCalls.push(msg);
    return { ok: true, method: msg.method };
  });
  const mcpCallNames = [];
  const server = await startMcp((msg) => {
    if (msg.method === 'tools/list') return okReply(msg, { tools: CANONICAL_TOOLS });
    if (msg.method === 'tools/call') {
      mcpCallNames.push(msg.params.name);
      return okReply(msg, { content: [{ type: 'text', text: 'unexpected MCP fallback' }] });
    }
    return okReply(msg, {});
  });
  const ctx = makeCtx();
  await withEnv({ WRENYARD_MCP_URL: sseUrl(server), WRENYARD_IPC_PATH: ipcSocket }, () => plugin.apply(ctx));

  const cases = [
    { alias: 'list_workspace_docs', args: { directory: 'guide' }, method: 'workspace.doc.list', params: { directory: 'guide' } },
    { alias: 'read_workspace_doc', args: { path: 'guide/start.md' }, method: 'workspace.doc.read', params: { path: 'guide/start.md' } },
    { alias: 'create_workspace_doc', args: { path: 'guide/new.md', content: 'hello' }, method: 'workspace.doc.create', params: { path: 'guide/new.md', content: 'hello' } },
    { alias: 'update_workspace_doc', args: { path: 'guide/new.md', content: 'hello v2', expectedContent: 'hello' }, method: 'workspace.doc.update', params: { path: 'guide/new.md', content: 'hello v2', expectedContent: 'hello' } },
  ];

  for (const c of cases) {
    const tool = ctx.registered.find((d) => d.name === c.alias);
    const output = await tool.execute(c.args, {});
    assert.ok(typeof output === 'string' && output.includes('ok'), `${c.alias} returns the IPC result`);
  }

  assert.deepEqual(ipcCalls.map((m) => m.method), cases.map((c) => c.method), 'each alias calls exactly its own IPC method');
  assert.deepEqual(ipcCalls.map((m) => m.params), cases.map((c) => c.params), 'IPC params are forwarded unchanged, including update expectedContent CAS');
  assert.deepEqual(mcpCallNames, [], 'doc aliases never fall back to MCP tools/call');

  server.close();
  ipcServer.close();
});

test('discovery aliases hit project.list and task.settings.runtimes over owner-only IPC with shaped params and no MCP fallback', async () => {
  const ipcCalls = [];
  const RUNTIMES_RESULT = {
    items: [
      { target: 'auto', provider: 'deepseek', model: 'deepseek-v4.1-flash', client: 'codebuddy', mode: 'auto', available: true },
      { target: 'pinned', provider: 'deepseek', model: 'deepseek-v4.1-flash', client: 'cli', mode: 'pinned', available: false, reason: 'no capacity' },
    ],
  };
  const ipcSocket = testIpcPath('discovery');
  const ipcServer = await startIpc(ipcSocket, (msg) => {
    ipcCalls.push(msg);
    if (msg.method === 'task.settings.runtimes') return RUNTIMES_RESULT;
    return { projects: [{ id: 'p1', name: 'Wrenyard' }] };
  });
  const mcpCallNames = [];
  const server = await startMcp((msg) => {
    if (msg.method === 'tools/list') return okReply(msg, { tools: CANONICAL_TOOLS });
    if (msg.method === 'tools/call') {
      mcpCallNames.push(msg.params.name);
      return okReply(msg, { content: [{ type: 'text', text: 'unexpected MCP fallback' }] });
    }
    return okReply(msg, {});
  });
  const ctx = makeCtx();
  await withEnv({ WRENYARD_MCP_URL: sseUrl(server), WRENYARD_IPC_PATH: ipcSocket }, () => plugin.apply(ctx));

  const listProjects = ctx.registered.find((d) => d.name === 'list_projects');
  const listRuntimes = ctx.registered.find((d) => d.name === 'list_runtimes');

  const projectsOut = await listProjects.execute({}, {});
  assert.match(projectsOut, /p1/, 'list_projects returns the IPC payload');
  assert.equal(ipcCalls[0].method, 'project.list');
  assert.deepEqual(ipcCalls[0].params, {}, 'list_projects sends an empty params object');

  // An unexpected model-supplied key must never reach the daemon.
  const runtimesOut = await listRuntimes.execute({ task_id: 't-1', project: 'p1', bogus: 'drop-me' }, {});
  assert.match(runtimesOut, /available/, 'list_runtimes returns the read-only availability contract');
  assert.match(runtimesOut, /"available":\s*false/, 'unavailable candidates stay visible with their reason');
  assert.equal(ipcCalls[1].method, 'task.settings.runtimes');
  assert.deepEqual(
    ipcCalls[1].params,
    { project: 'p1', task_id: 't-1' },
    'list_runtimes forwards only the declared project/task_id params',
  );

  assert.deepEqual(mcpCallNames, [], 'discovery aliases never fall back to MCP tools/call');

  server.close();
  ipcServer.close();
});

test('discovery IPC errors propagate as bounded rejections', async () => {
  const ipcSocket = testIpcPath('discovery-error');
  const ipcServer = net.createServer((sock) => {
    sock.on('data', (chunk) => {
      const line = chunk.toString().trim();
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      sock.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'unknown task_id: t-missing' } })}\n`);
    });
  });
  await new Promise((resolve) => ipcServer.listen(ipcSocket, resolve));

  const server = await startMcp(canonicalListFixture);
  const ctx = makeCtx();
  await withEnv({ WRENYARD_MCP_URL: sseUrl(server), WRENYARD_IPC_PATH: ipcSocket }, () => plugin.apply(ctx));

  const listRuntimes = ctx.registered.find((d) => d.name === 'list_runtimes');
  await assert.rejects(
    () => listRuntimes.execute({ task_id: 't-missing' }, {}),
    /Wrenyard IPC error:.*unknown task_id/,
  );

  server.close();
  ipcServer.close();
});

// A real-shaped DSH session event log: user/plugin turns, assistant text plus
// reasoning, and tool results, exactly as `exec.agent.session.events` carries
// them (SessionEvent = {type, seq, time, data}).
function userEvent(seq, kind, text, extra = {}) {
  return {
    type: 'user/message',
    seq,
    time: 1_700_000_000_000 + seq,
    data: { role: 'user', source: kind === 'user' ? { kind: 'user' } : { kind: 'plugin', plugin: 'dsh-x', form: 'notice' }, content: [{ type: 'text', text }] },
    ...extra,
  };
}

function assistantEvent(seq, text, reasoning) {
  const content = [];
  if (reasoning) content.push({ type: 'reasoning', text: reasoning });
  if (text) content.push({ type: 'text', text });
  content.push({ type: 'tool-call', id: `c${seq}`, name: 'bash', arguments: '{"cmd":"ls"}' });
  return {
    type: 'assistant/message',
    seq,
    time: 1_700_000_000_000 + seq,
    data: { turn: 1, step: seq, message: { role: 'assistant', source: { kind: 'model', provider: 'deepseek' }, content } },
  };
}

function toolResultEvent(seq, callId, text) {
  return {
    type: 'tool/result',
    seq,
    time: 1_700_000_000_000 + seq,
    data: {
      turn: 1,
      step: seq,
      message: { role: 'user', source: { kind: 'tool', callId }, content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text }] }] },
    },
  };
}

function realSessionEvents() {
  return [
    userEvent(1, 'plugin', 'injected file-change notice'),
    userEvent(2, 'user', 'please refactor the parser'),
    assistantEvent(3, 'Looking at the parser now.', 'SECRET_INTERNAL_REASONING'),
    toolResultEvent(4, 'c3', 'RAW_TOOL_OUTPUT_SHOULD_NEVER_APPEAR'),
    userEvent(5, 'user', 'now dispatch the fix'),
  ];
}

test('deriveConversationTail keeps recent human dialogue, dropping reasoning, plugin injections, and tool output', () => {
  const tail = deriveConversationTail(realSessionEvents());

  assert.deepEqual(
    tail.map((turn) => turn.role),
    ['user', 'assistant', 'user'],
    'recent context and the triggering request are retained',
  );
  const joined = JSON.stringify(tail);
  assert.ok(joined.includes('now dispatch the fix'), 'the pending human request is kept');
  assert.ok(!joined.includes('injected file-change notice'), 'plugin-injected user messages are excluded');
  assert.ok(!joined.includes('SECRET_INTERNAL_REASONING'), 'reasoning blocks are excluded');
  assert.ok(!joined.includes('RAW_TOOL_OUTPUT_SHOULD_NEVER_APPEAR'), 'tool results are excluded');
  assert.ok(!joined.includes('tool-call'), 'tool calls are excluded');
});

test('deriveConversationTail keeps a chronological dialogue across human turns and redacts credential-shaped text', () => {
  const events = [
    userEvent(1, 'plugin', 'noise before the dialogue'),
    userEvent(2, 'user', 'first question'),
    assistantEvent(3, 'first answer'),
    userEvent(4, 'user', 'second question with ' + 'sk-' + 'a'.repeat(24)),
    assistantEvent(5, 'second answer'),
    userEvent(6, 'user', 'third question'),
  ];
  const tail = deriveConversationTail(events);

  assert.deepEqual(
    tail.map((turn) => turn.role),
    ['user', 'assistant', 'user', 'assistant', 'user'],
    'dialogue stays chronological',
  );
  assert.equal(tail.at(-1).text, 'third question', 'the pending human request ends the tail');

  // A dialogue spanning several turns stays chronological, ending on the
  // triggering human turn.
  const dialogue = deriveConversationTail([
    userEvent(1, 'user', 'alpha question'),
    assistantEvent(2, 'alpha answer'),
    userEvent(3, 'user', 'beta question'),
    assistantEvent(4, 'beta answer'),
    userEvent(5, 'user', 'gamma question'),
  ]);
  assert.deepEqual(
    dialogue.map((turn) => turn.role),
    ['user', 'assistant', 'user', 'assistant', 'user'],
    'the prior dialogue remains available',
  );

  const redacted = deriveConversationTail([
    userEvent(1, 'user', 'question with ' + 'sk-' + 'a'.repeat(24)),
  ]);
  assert.match(redacted[0].text, /\[redacted\]/, 'credential-shaped strings are redacted');
  assert.ok(!redacted[0].text.includes('sk-' + 'a'.repeat(24)), 'the raw token never leaves the process');
  assert.deepEqual(deriveConversationTail([]), [], 'an empty log yields no tail');
  assert.deepEqual(
    deriveConversationTail([assistantEvent(1, 'only model output')]),
    [],
    'a session with no human turn yields no tail',
  );
});

test('mergeOrchestrationContext attaches a bounded same-session transcript and preserves the model-supplied ctx keys', () => {
  const supplied = { orchestration: { mine: 'keep' }, note: 'model wrote this' };
  const suppliedSnapshot = JSON.parse(JSON.stringify(supplied));
  const preserved = mergeOrchestrationContext(supplied, realSessionEvents(), { sessionId: 's1', callId: 'call-1' });

  assert.equal(preserved.ctx, supplied, 'a model-supplied ctx.orchestration is never overridden');
  assert.equal(preserved.attached, false);
  assert.deepEqual(supplied, suppliedSnapshot, 'the supplied ctx is not mutated');
  assert.match(preserved.status, /preserved/);

  const merged = mergeOrchestrationContext({ note: 'keep me' }, realSessionEvents(), { sessionId: 'sess-42', callId: 'call-42' });
  assert.equal(merged.attached, true);
  assert.equal(merged.ctx.note, 'keep me', 'existing ctx keys survive the merge');
  assert.ok(Array.isArray(merged.ctx.orchestration.source_conversation), 'the transcript rides ctx.orchestration.source_conversation');
  assert.equal(merged.ctx.orchestration.sessionId, 'sess-42', 'sessionId is included for correlation');
  assert.equal(merged.ctx.orchestration.callId, 'call-42', 'callId is included for correlation');
  assert.ok(Buffer.byteLength(JSON.stringify(merged.ctx), 'utf8') <= 16 * 1024, 'the merged ctx stays inside the 16 KiB budget');
});

test('mergeOrchestrationContext keeps the merged ctx inside the 16 KiB / 64-key budget and skips when there is no room', () => {
  const huge = [];
  for (let index = 0; index < 40; index += 1) {
    huge.push(userEvent(index * 2 + 1, 'user', `question ${index} ${'x'.repeat(2000)}`));
    huge.push(assistantEvent(index * 2 + 2, `answer ${index} ${'y'.repeat(2000)}`));
  }
  const merged = mergeOrchestrationContext({ small: 1 }, huge, { sessionId: 's-huge', callId: 'c-huge' });
  assert.equal(merged.attached, true);
  const bytes = Buffer.byteLength(JSON.stringify(merged.ctx), 'utf8');
  assert.ok(bytes <= 16 * 1024, `oversized dialogue is clipped to the budget (got ${bytes}B)`);
  assert.ok(merged.ctx.orchestration.source_conversation.length >= 1, 'at least the newest turn survives the budget');

  const manyKeys = {};
  for (let index = 0; index < 64; index += 1) manyKeys[`k${index}`] = index;
  const keyCapped = mergeOrchestrationContext(manyKeys, realSessionEvents(), {});
  assert.equal(keyCapped.attached, false);
  assert.equal(keyCapped.ctx, manyKeys, 'the caller ctx is returned untouched at the key ceiling');
  assert.match(keyCapped.status, /key budget/);

  const byteCapped = mergeOrchestrationContext({ blob: 'z'.repeat(16 * 1024) }, realSessionEvents(), {});
  assert.equal(byteCapped.attached, false);
  assert.match(byteCapped.status, /byte budget/);

  const noHuman = mergeOrchestrationContext({}, [assistantEvent(1, 'model only')], {});
  assert.equal(noHuman.attached, false);
  assert.match(noHuman.status, /no human turn/);
});

test('run_task derives ctx.orchestration from its own exec.agent.session.events', async () => {
  const createArguments = [];
  const ipcSocket = testIpcPath('ctx-handoff');
  const ipcServer = await startIpc(ipcSocket, () => ({ status: 'done' }));
  const server = await startMcp((msg) => {
    if (msg.method === 'tools/list') return okReply(msg, { tools: CANONICAL_TOOLS });
    if (msg.method === 'tools/call' && msg.params.name === 'task_run') {
      createArguments.push(msg.params.arguments);
      return okReply(msg, { structuredContent: { task_run_id: 't-ctx', status: 'queued' } });
    }
    return okReply(msg, {});
  });
  const ctx = makeCtx();
  await withEnv({ WRENYARD_MCP_URL: sseUrl(server), WRENYARD_IPC_PATH: ipcSocket }, () => plugin.apply(ctx));

  const runTask = ctx.registered.find((d) => d.name === 'run_task');
  const session = { id: 'session-abc', events: realSessionEvents() };
  await runTask.execute({ task_id: 't-1' }, { signal: undefined, callId: 'call-abc', agent: { session } });

  assert.equal(createArguments.length, 1);
  const forwarded = createArguments[0];
  assert.equal(forwarded.task_id, 't-1', 'the task arguments are forwarded unchanged');
  assert.equal(forwarded.ctx.orchestration.sessionId, 'session-abc');
  assert.equal(forwarded.ctx.orchestration.callId, 'call-abc');
  assert.deepEqual(forwarded.ctx.orchestration.source_conversation.map((t) => t.role), ['user', 'assistant', 'user']);
  assert.ok(
    JSON.stringify(forwarded.ctx).includes('now dispatch the fix'),
    'the pending human request reaches the dispatcher',
  );
  assert.ok(
    !JSON.stringify(forwarded.ctx).includes('RAW_TOOL_OUTPUT_SHOULD_NEVER_APPEAR'),
    'raw tool output never reaches the dispatcher',
  );

  const withCtx = [...createArguments];
  await runTask.execute({ task_id: 't-2', ctx: { orchestration: { mine: true } } }, { callId: 'call-2', agent: { session } });
  const second = createArguments[createArguments.length - 1];
  assert.deepEqual(second.ctx, { orchestration: { mine: true } }, 'a model-supplied ctx.orchestration is passed through untouched');
  assert.equal(withCtx.length, 1);

  server.close();
  ipcServer.close();
});

test('run_task with no agent session still dispatches without inventing ctx', async () => {
  const createArguments = [];
  const ipcSocket = testIpcPath('ctx-none');
  const ipcServer = await startIpc(ipcSocket, () => ({ status: 'done' }));
  const server = await startMcp((msg) => {
    if (msg.method === 'tools/list') return okReply(msg, { tools: CANONICAL_TOOLS });
    if (msg.method === 'tools/call' && msg.params.name === 'task_run') {
      createArguments.push(msg.params.arguments);
      return okReply(msg, { structuredContent: { task_run_id: 't-plain', status: 'queued' } });
    }
    return okReply(msg, {});
  });
  const ctx = makeCtx();
  await withEnv({ WRENYARD_MCP_URL: sseUrl(server), WRENYARD_IPC_PATH: ipcSocket }, () => plugin.apply(ctx));

  const runTask = ctx.registered.find((d) => d.name === 'run_task');
  await runTask.execute({ task_id: 't-plain' }, {});
  assert.deepEqual(createArguments[0], { task_id: 't-plain' }, 'no ctx is added when the call has no agent session');

  server.close();
  ipcServer.close();
});

test('concurrent run_task calls on different sessions never cross-talk in ctx.orchestration', async () => {
  const createArguments = [];
  const ipcSocket = testIpcPath('ctx-isolation');
  const ipcServer = await startIpc(ipcSocket, (msg) => ({ task_run_id: msg.params.task_run_id, status: 'done' }));
  const server = await startMcp((msg) => {
    if (msg.method === 'tools/list') return okReply(msg, { tools: CANONICAL_TOOLS });
    if (msg.method === 'tools/call' && msg.params.name === 'task_run') {
      createArguments.push(msg.params.arguments);
      const id = msg.params.arguments.task_id;
      return okReply(msg, { structuredContent: { task_run_id: id, status: 'queued' } });
    }
    return okReply(msg, {});
  });
  const ctx = makeCtx();
  await withEnv({ WRENYARD_MCP_URL: sseUrl(server), WRENYARD_IPC_PATH: ipcSocket }, () => plugin.apply(ctx));

  const runTask = ctx.registered.find((d) => d.name === 'run_task');
  const sessionA = { id: 'sess-A', events: [userEvent(1, 'user', 'alpha-only-request'), assistantEvent(2, 'alpha answer')] };
  const sessionB = { id: 'sess-B', events: [userEvent(1, 'user', 'beta-only-request'), assistantEvent(2, 'beta answer')] };

  const [oa, ob] = await Promise.all([
    runTask.execute({ task_id: 't-a' }, { callId: 'call-a', agent: { session: sessionA } }),
    runTask.execute({ task_id: 't-b' }, { callId: 'call-b', agent: { session: sessionB } }),
  ]);

  const callA = createArguments.find((args) => args.task_id === 't-a');
  const callB = createArguments.find((args) => args.task_id === 't-b');
  const ctxA = JSON.stringify(callA.ctx);
  const ctxB = JSON.stringify(callB.ctx);

  assert.equal(callA.ctx.orchestration.sessionId, 'sess-A');
  assert.equal(callB.ctx.orchestration.sessionId, 'sess-B');
  assert.equal(callA.ctx.orchestration.callId, 'call-a');
  assert.equal(callB.ctx.orchestration.callId, 'call-b');
  assert.ok(ctxA.includes('alpha-only-request') && !ctxA.includes('beta-only-request'), 'session A carries only its own dialogue');
  assert.ok(ctxB.includes('beta-only-request') && !ctxB.includes('alpha-only-request'), 'session B carries only its own dialogue');
  assert.ok(oa.includes('t-a') && ob.includes('t-b'), 'each call still receives its own terminal envelope');

  server.close();
  ipcServer.close();
});

test('workspace-doc IPC errors (e.g. expectedContent CAS conflict) propagate as bounded rejections', async () => {
  const ipcCalls = [];
  const ipcSocket = testIpcPath('doc-error');
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
      sock.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'CAS conflict: content no longer matches expectedContent' } })}\n`);
    });
  });
  await new Promise((resolve) => ipcServer.listen(ipcSocket, resolve));

  const server = await startMcp(canonicalListFixture);
  const ctx = makeCtx();
  await withEnv({ WRENYARD_MCP_URL: sseUrl(server), WRENYARD_IPC_PATH: ipcSocket }, () => plugin.apply(ctx));

  const updateDoc = ctx.registered.find((d) => d.name === 'update_workspace_doc');
  await assert.rejects(
    () => updateDoc.execute({ path: 'guide/new.md', content: 'v2', expectedContent: 'stale' }, {}),
    /Wrenyard IPC error:.*CAS conflict/,
  );
  assert.equal(ipcCalls.length, 1, 'exactly one workspace.doc.update call');
  assert.equal(ipcCalls[0].method, 'workspace.doc.update');
  assert.deepEqual(ipcCalls[0].params, { path: 'guide/new.md', content: 'v2', expectedContent: 'stale' });

  server.close();
  ipcServer.close();
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
    const createArguments = [];
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
          createArguments.push(msg.params.arguments);
          return okReply(msg, { structuredContent: { task_run_id: 't-1', status: 'queued' } });
        }
      }
      return okReply(msg, {});
    });
    const ctx = makeCtx();
    await withEnv({ WRENYARD_MCP_URL: sseUrl(server), WRENYARD_IPC_PATH: ipcSocket }, () => plugin.apply(ctx));

    const runTask = ctx.registered.find((d) => d.name === 'run_task');
    const invocationSettings = {
      timeout_ms: 90_000,
      automatic: { minimum_tps: 2 },
      additional_instructions: 'be terse',
    };
    const output = await runTask.execute({ command: 'build', invocation_settings: invocationSettings }, {});
    assert.match(output, new RegExp(envelope.status));

    assert.equal(ipcCalls.length, 1, `exactly one task.run.wait for ${envelope.status}`);
    assert.equal(ipcCalls[0].method, 'task.run.wait');
    assert.equal(ipcCalls[0].params.task_run_id, 't-1');
    assert.deepEqual(taskCallNames, ['task_run'], 'no task_status/task_output polling calls');
    assert.deepEqual(
      createArguments,
      [{ command: 'build', invocation_settings: invocationSettings }],
      'run_task forwards the caller input, including the nested invocation_settings object, unchanged to the canonical task_run create call',
    );

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
