/**
 * @wrenyard/dsh-shell
 *
 * Wrenyard MCP/IPC tools bridge for DeepSeek Harness (DSH) Code Mode.
 *
 * A self-contained Cordis plugin compatible with @deepseek-ai/dsh@0.1.0-rc.6.
 * It talks only to Wrenyard's public MCP (HTTP/SSE JSON-RPC) and owner-only
 * NDJSON IPC surfaces, whose wire protocols are stable. It never imports Forge
 * or Wrenyard source, never logs credentials or raw environment values, and
 * bundles no internal provider.
 */

import net from 'node:net';

export const name = 'wrenyard-foreman-tools';

export const inject = ['tools'];

const DEFAULT_MCP_URL = 'http://127.0.0.1:8787/mcp';
const CATALOG_TIMEOUT_MS = 15_000;
const DEFAULT_TIMEOUT_MS = 180_000;
const TASK_TIMEOUT_MS = 900_000;
const TASK_POLL_MS = 100;
const IPC_TIMEOUT_MS = 5_000;

const TERMINAL_TASK_STATUSES = new Set([
  'done',
  'failed',
  'cancelled',
  'interrupted',
]);

// DSH-internal session/work plumbing and workflow_* orchestration tools are
// never exposed to the model.
const BLOCKED_TOOLS = new Set([
  'sessions_list',
  'session_send',
  'work_send',
  'work_transcript',
]);

// Read-only tools may run concurrently; everything else is serialized.
const READONLY_TOOLS = new Set([
  'project_list',
  'project_describe',
  'project_commit_log',
  'worktree_list',
  'agent_list',
  'agent_model_list',
  'workspace_doc_list',
  'workspace_doc_read',
  'task_status',
  'task_output',
  'task_wait',
]);

// Canonical public RPC methods for the owner-only Wrenyard NDJSON IPC surface.
// The wire protocol is stable; only the product naming changed.
const CANONICAL_RPC = {
  project_list: 'project.list',
  project_describe: 'project.describe',
  project_commit_log: 'project.commitLog',
  worktree_list: 'project.worktree.list',
  agent_list: 'agent.list',
  agent_model_list: 'agent.model.list',
  workspace_doc_list: 'workspace.doc.list',
  workspace_doc_read: 'workspace.doc.read',
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function abortError() {
  const err = new Error('Aborted');
  err.name = 'AbortError';
  return err;
}

function boundedMessage(err) {
  return err instanceof Error ? err.message : String(err);
}

function isBlockedTool(toolName) {
  return BLOCKED_TOOLS.has(toolName) || toolName.startsWith('workflow_');
}

const SCHEMA_KEEP = new Set([
  'type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items',
  'enum', 'const', 'description', 'title', 'default',
]);

function sanitizeSchema(node) {
  if (node === true) return {};
  if (node === false) return { type: 'object', additionalProperties: false };
  if (!node || typeof node !== 'object' || Array.isArray(node)) return {};
  const anyOf = Array.isArray(node.anyOf) ? node.anyOf.map(sanitizeSchema) : undefined;
  const oneOf = Array.isArray(node.oneOf) ? node.oneOf.map(sanitizeSchema) : undefined;
  const out = {};
  for (const key of Object.keys(node)) {
    if (!SCHEMA_KEEP.has(key) || key === 'oneOf') continue;
    out[key] = node[key];
  }
  if (typeof out.additionalProperties === 'object') out.additionalProperties = true;
  if (Array.isArray(out.type)) out.type = out.type.find((type) => type !== 'null') ?? 'string';
  if (out.properties && typeof out.properties === 'object') {
    out.properties = Object.fromEntries(
      Object.entries(out.properties).map(([key, value]) => [key, sanitizeSchema(value)]),
    );
  }
  if (out.items !== undefined) out.items = sanitizeSchema(out.items);
  if (Array.isArray(out.required)) out.required = out.required.filter((key) => typeof key === 'string');
  const variants = oneOf?.length >= 2 ? oneOf : anyOf?.length >= 2 ? anyOf : undefined;
  if (variants && !out.type) out.oneOf = variants;
  return out;
}

async function mcpRequest(mcpUrl, sender, method, params, { timeout = DEFAULT_TIMEOUT_MS, signal } = {}) {
  const target = new URL(mcpUrl);
  if (sender) target.searchParams.set('FOREMAN_MCP_SENDER', sender);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Wrenyard MCP request timeout')), timeout);
  const onOuterAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) {
      clearTimeout(timer);
      throw abortError();
    }
    signal.addEventListener('abort', onOuterAbort, { once: true });
  }
  try {
    const res = await fetch(target, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`MCP HTTP ${res.status}`);
    return parseSse(await res.text());
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onOuterAbort);
  }
}

function parseSse(raw) {
  const chunks = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith('data:')) chunks.push(line.slice(5).trim());
  }
  for (const chunk of chunks) {
    if (!chunk) continue;
    let msg;
    try {
      msg = JSON.parse(chunk);
    } catch {
      continue;
    }
    if (msg.error) {
      const err = new Error(`MCP error: ${msg.error.message || 'unknown'}`);
      err.code = msg.error.code;
      throw err;
    }
    if (msg.result !== undefined) return msg.result;
  }
  throw new Error('MCP returned no usable SSE payload');
}

function extractText(result) {
  if (result === null || result === undefined) return '';
  if (typeof result === 'string') return result;
  if (typeof result !== 'object') return String(result);
  if (result.structuredContent !== undefined) {
    return typeof result.structuredContent === 'string'
      ? result.structuredContent
      : JSON.stringify(result.structuredContent, null, 2);
  }
  if (Array.isArray(result.content)) {
    return result.content
      .filter((item) => item && item.type === 'text' && typeof item.text === 'string')
      .map((item) => item.text)
      .join('\n');
  }
  return JSON.stringify(result, null, 2);
}

function pick(result, keys) {
  if (!result || typeof result !== 'object') return undefined;
  const structured = result.structuredContent;
  if (structured && typeof structured === 'object') {
    for (const key of keys) {
      if (structured[key] !== undefined) return structured[key];
    }
  }
  for (const key of keys) {
    if (result[key] !== undefined) return result[key];
  }
  try {
    const parsed = JSON.parse(extractText(result));
    if (parsed && typeof parsed === 'object') {
      for (const key of keys) {
        if (parsed[key] !== undefined) return parsed[key];
      }
    }
  } catch {
    // Non-JSON text output; nothing to pick.
  }
  return undefined;
}

function canonicalOutput(result) {
  if (result && result.isError) {
    const err = new Error(extractText(result) || 'Wrenyard tool reported an error');
    err.isToolError = true;
    throw err;
  }
  return extractText(result);
}

function dshOutput() {
  return {
    schema: {},
    render(_args, result) {
      const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
      return [{ type: 'text', text }];
    },
  };
}

async function listTools(mcpUrl, sender) {
  const result = await mcpRequest(mcpUrl, sender, 'tools/list', {}, { timeout: CATALOG_TIMEOUT_MS });
  return Array.isArray(result && result.tools) ? result.tools : [];
}

async function callTool(mcpUrl, sender, toolName, args, { signal } = {}) {
  return mcpRequest(mcpUrl, sender, 'tools/call', { name: toolName, arguments: args }, { signal });
}

/**
 * Resolve the Wrenyard NDJSON IPC socket. WRENYARD_IPC_PATH is primary, the
 * legacy FOREMAN_IPC_PATH is still read as a fallback, and the shared
 * wrenyard.sock default (same as @wrenyard/control-client and the desktop app)
 * is used when neither is set.
 */
export function wrenyardIpcPath(env = process.env) {
  if (env.WRENYARD_IPC_PATH) return env.WRENYARD_IPC_PATH;
  if (env.FOREMAN_IPC_PATH) return env.FOREMAN_IPC_PATH;
  return process.platform === 'win32' ? '\\\\.\\pipe\\wrenyard.sock' : '/tmp/wrenyard.sock';
}

function ipcRequest(socketPath, method, params, { timeout = IPC_TIMEOUT_MS, signal } = {}) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(socketPath);
    let lineBuffer = '';
    let settled = false;

    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onOuterAbort);
      sock.destroy();
      if (err) reject(err);
      else resolve(value);
    };
    const onOuterAbort = () => finish(abortError());
    const timer = setTimeout(() => finish(new Error('Wrenyard IPC timeout')), timeout);

    if (signal) {
      if (signal.aborted) return finish(abortError());
      signal.addEventListener('abort', onOuterAbort, { once: true });
    }

    sock.on('connect', () => {
      sock.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })}\n`);
    });
    sock.on('data', (chunk) => {
      lineBuffer += chunk.toString();
      let index;
      while ((index = lineBuffer.indexOf('\n')) >= 0) {
        const line = lineBuffer.slice(0, index).trim();
        lineBuffer = lineBuffer.slice(index + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.error) {
          finish(new Error(`Wrenyard IPC error: ${msg.error.message || msg.error || 'unknown'}`));
          return;
        }
        if (msg.id === 1) {
          finish(null, msg.result !== undefined ? msg.result : msg);
          return;
        }
      }
    });
    sock.on('error', (err) => finish(err));
  });
}

async function waitForTask(mcpUrl, sender, taskRunId, signal) {
  const deadline = Date.now() + TASK_TIMEOUT_MS;
  let status;
  for (;;) {
    if (signal && signal.aborted) throw abortError();
    if (Date.now() >= deadline) {
      throw new Error(`Wrenyard: task ${taskRunId} exceeded ${TASK_TIMEOUT_MS}ms deadline`);
    }
    const statusResult = await callTool(mcpUrl, sender, 'task_status', { task_run_id: taskRunId }, { signal });
    status = pick(statusResult, ['status', 'state']) || 'running';
    if (TERMINAL_TASK_STATUSES.has(status)) {
      const outputResult = await callTool(mcpUrl, sender, 'task_output', { task_run_id: taskRunId }, { signal });
      return { task_run_id: taskRunId, status, ...outputResult };
    }
    await sleep(TASK_POLL_MS);
  }
}

function makeExecute(mcpUrl, sender, toolName) {
  return async function execute(input, { signal } = {}) {
    const result = await callTool(mcpUrl, sender, toolName, input || {}, { signal });
    return canonicalOutput(result);
  };
}

function makeTaskRunExecute(mcpUrl, sender) {
  return async function execute(input, { signal } = {}) {
    const launch = await callTool(mcpUrl, sender, 'task_run', input || {}, { signal });
    const taskRunId = pick(launch, ['task_run_id', 'task_id', 'taskRunId', 'id']);
    if (taskRunId === undefined) return canonicalOutput(launch);
    return canonicalOutput(await waitForTask(mcpUrl, sender, taskRunId, signal));
  };
}

function makeTaskWaitExecute(mcpUrl, sender) {
  return async function execute(input, { signal } = {}) {
    const taskRunId = pick(input || {}, ['task_run_id', 'task_id', 'taskRunId', 'id']);
    if (taskRunId === undefined) throw new Error('task_wait requires task_run_id');
    return canonicalOutput(await waitForTask(mcpUrl, sender, taskRunId, signal));
  };
}

function makeIpcExecute(socketPath, method) {
  return async function execute(input, { signal } = {}) {
    const result = await ipcRequest(socketPath, method, input || {}, {
      timeout: DEFAULT_TIMEOUT_MS,
      signal,
    });
    return canonicalOutput(result);
  };
}

function registerTool(tools, tool, execute) {
  const readonly = READONLY_TOOLS.has(tool.name);
  tools.register({
    name: tool.name,
    description: typeof tool.description === 'string' ? tool.description : '',
    parameters: sanitizeSchema(tool.inputSchema || tool.schema),
    timeoutMs: tool.name === 'task_run' || tool.name === 'task_wait' || tool.name === 'taskgraph_wait'
      ? TASK_TIMEOUT_MS
      : DEFAULT_TIMEOUT_MS,
    output: dshOutput(),
    isConcurrencySafe: () => readonly,
    execute,
  });
}

export async function apply(ctx) {
  const { tools } = ctx;
  const warn = (...args) => ctx.logger && ctx.logger.warn(...args);
  if (typeof ctx.on === 'function') ctx.on('tools/pre-execute', async () => ({ kind: 'allow' }));

  const mcpUrl = process.env.WRENYARD_MCP_URL || process.env.FOREMAN_MCP_URL || DEFAULT_MCP_URL;
  const sender = process.env.WRENYARD_MCP_SENDER || process.env.FOREMAN_MCP_SENDER || undefined;

  let catalog;
  try {
    catalog = await listTools(mcpUrl, sender);
  } catch (err) {
    throw new Error(`Wrenyard: MCP is unavailable: ${boundedMessage(err)}`);
  }

  const filtered = catalog.filter(
    (tool) => tool && typeof tool.name === 'string' && !isBlockedTool(tool.name),
  );
  if (filtered.length === 0) {
    throw new Error('Wrenyard: MCP listed no usable tools');
  }

  const byName = new Map(filtered.map((tool) => [tool.name, tool]));

  for (const tool of filtered) {
    if (tool.name === 'task_run') continue; // wrapped below
    registerTool(tools, tool, makeExecute(mcpUrl, sender, tool.name));
  }
  if (byName.has('task_run')) {
    registerTool(tools, byName.get('task_run'), makeTaskRunExecute(mcpUrl, sender));
  }
  if (!byName.has('task_wait')) {
    registerTool(tools, {
      name: 'task_wait',
      description:
        'Wait for a Wrenyard task run until it reaches a terminal status. One call; do not poll.',
      inputSchema: {
        type: 'object',
        properties: { task_run_id: { type: 'string' } },
        required: ['task_run_id'],
        additionalProperties: false,
      },
    }, makeTaskWaitExecute(mcpUrl, sender));
  }

  // Owner-only NDJSON IPC: bounded and non-fatal. When reachable it registers
  // public extras the MCP catalog did not already provide.
  let ipcAvailable = false;
  const activeIpcPath = wrenyardIpcPath();
  try {
    const health = await ipcRequest(activeIpcPath, 'health.ping', {});
    ipcAvailable = Boolean(health && health.ok !== false);
  } catch (err) {
    warn(`Wrenyard: IPC unavailable (${boundedMessage(err)}); continuing in MCP-only mode`);
  }
  if (ipcAvailable) {
    for (const [toolName, method] of Object.entries(CANONICAL_RPC)) {
      if (byName.has(toolName)) continue;
      registerTool(tools, {
        name: toolName,
        description: `Wrenyard ${method} (owner NDJSON IPC)`,
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      }, makeIpcExecute(activeIpcPath, method));
    }
  }
}

export default { name, inject, apply };
