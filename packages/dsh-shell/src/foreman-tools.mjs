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
 *
 * Exactly seven Desktop/DSH model-visible tools are exposed under stable
 * aliases. The three task tools are mapped to canonical MCP definitions; the
 * four workspace-document tools talk only to the owner-only NDJSON IPC
 * surface:
 *   - list_task            -> task_list (MCP)
 *   - describe_task        -> task_describe (MCP)
 *   - run_task             -> task_run (MCP) + IPC task.run.wait / task.run.cancel
 *   - list_workspace_docs  -> workspace.doc.list (owner-only IPC)
 *   - read_workspace_doc   -> workspace.doc.read (owner-only IPC)
 *   - create_workspace_doc -> workspace.doc.create (owner-only IPC)
 *   - update_workspace_doc -> workspace.doc.update (owner-only IPC; expectedContent CAS)
 */

import net from 'node:net';

export const name = 'wrenyard-foreman-tools';

export const inject = ['tools'];

const DEFAULT_MCP_URL = 'http://127.0.0.1:8787/mcp';
const CATALOG_TIMEOUT_MS = 15_000;
const DEFAULT_TIMEOUT_MS = 180_000;
const IPC_TIMEOUT_MS = 5_000;

const TASK_CANONICAL = {
  list_task: 'task_list',
  describe_task: 'task_describe',
  run_task: 'task_run',
};

const IPC_WAIT_METHOD = 'task.run.wait';
const IPC_CANCEL_METHOD = 'task.run.cancel';

const DOC_ALIAS_TO_IPC = {
  list_workspace_docs: 'workspace.doc.list',
  read_workspace_doc: 'workspace.doc.read',
  create_workspace_doc: 'workspace.doc.create',
  update_workspace_doc: 'workspace.doc.update',
};

// The seven model-visible aliases keep their execution authority in the
// Wrenyard backend. Only these names may short-circuit the pre-execute
// waterfall; every other native tool must keep flowing through DSH policy.
const WRENYARD_ALIAS_NAMES = new Set([...Object.keys(TASK_CANONICAL), ...Object.keys(DOC_ALIAS_TO_IPC)]);

const DOC_DEFINITIONS = {
  list_workspace_docs: {
    description: 'List Wrenyard workspace documents, optionally under a workspace directory.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: 'Optional workspace directory whose documents should be listed.' },
      },
      additionalProperties: false,
    },
  },
  read_workspace_doc: {
    description: 'Read a single Wrenyard workspace document by workspace-relative path.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative document path.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  create_workspace_doc: {
    description: 'Create a Wrenyard workspace document at the given path with the given full content.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative document path.' },
        content: { type: 'string', description: 'Full document content.' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
  },
  update_workspace_doc: {
    description: 'Update a Wrenyard workspace document at the given path only when its current content still matches expectedContent (compare-and-set).',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative document path.' },
        content: { type: 'string', description: 'New full document content.' },
        expectedContent: { type: 'string', description: 'Expected current content; the backend rejects on CAS mismatch.' },
      },
      required: ['path', 'content', 'expectedContent'],
      additionalProperties: false,
    },
  },
};

function abortError() {
  const err = new Error('Aborted');
  err.name = 'AbortError';
  return err;
}

function boundedMessage(err) {
  return err instanceof Error ? err.message : String(err);
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
 * legacy FOREMAN_IPC_PATH is still read as a fallback. Without an override,
 * Windows uses the daemon's named pipe and Unix uses the shared socket path.
 */
export function wrenyardIpcPath(env = process.env) {
  for (const candidate of [env.WRENYARD_IPC_PATH, env.FOREMAN_IPC_PATH]) {
    const socketPath = candidate?.trim();
    if (socketPath) return socketPath;
  }
  return process.platform === 'win32' ? '\\\\.\\pipe\\wrenyard' : '/tmp/wrenyard.sock';
}

function ipcRequest(socketPath, method, params, { timeout = IPC_TIMEOUT_MS, signal } = {}) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(socketPath);
    let lineBuffer = '';
    let settled = false;

    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onOuterAbort);
      sock.destroy();
      if (err) reject(err);
      else resolve(value);
    };
    const onOuterAbort = () => finish(abortError());
    const timer = timeout == null ? null : setTimeout(() => finish(new Error('Wrenyard IPC timeout')), timeout);

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
    // An incidental daemon/socket disconnect (close without a settled response)
    // must reject the caller promptly. finish() is idempotent, so a normal
    // reply followed by the local destroy() in finish() also emits 'close'
    // without double-settling. We do NOT treat this as an AbortError and do NOT
    // trigger owned-task cancellation: only the caller AbortSignal cancels.
    sock.on('close', () => {
      if (!settled) finish(new Error('Wrenyard IPC connection closed before response'));
    });
  });
}

function makeExecute(mcpUrl, sender, canonicalName) {
  return async function execute(input, { signal } = {}) {
    const result = await callTool(mcpUrl, sender, canonicalName, input || {}, { signal });
    return canonicalOutput(result);
  };
}

/**
 * Owned-run cancellation: once this wrapper has created a task_run_id it owns
 * that backend run and must cancel it exactly once if the caller aborts. The
 * caller AbortSignal is deliberately kept out of the create request so an abort
 * mid-create cannot discard a successfully returned id, and the wait request
 * keeps the signal so Stop closes the wait socket promptly. Cancellation is
 * idempotent (attempted-flag set before the await) and its failure is swallowed
 * so the original abort stays authoritative. No cancel/status tool is exposed
 * to the model; IPC_CANCEL_METHOD is exercised only through this private
 * helper, and the four workspace-doc aliases route only to their own
 * owner-only workspace.doc.* IPC methods.
 */
function makeRunTaskExecute(mcpUrl, sender, socketPath) {
  return async function execute(input, { signal } = {}) {
    if (signal && signal.aborted) throw abortError();

    let taskRunId;
    let cancelAttempted = false;
    const cancelOwned = async () => {
      if (taskRunId === undefined || cancelAttempted) return;
      cancelAttempted = true;
      try {
        await ipcRequest(
          socketPath,
          IPC_CANCEL_METHOD,
          { task_run_id: taskRunId },
          { timeout: IPC_TIMEOUT_MS },
        );
      } catch {
        // Cancellation cleanup failure must not override the original abort.
      }
    };

    // The caller signal is not passed here: an abort during create must not
    // discard a successfully created task_run_id. The bounded MCP timeout is
    // preserved via the existing callTool default.
    const launch = await callTool(mcpUrl, sender, TASK_CANONICAL.run_task, input || {}, {});
    taskRunId = pick(launch, ['task_run_id', 'task_id', 'taskRunId', 'id']);
    if (taskRunId === undefined) return canonicalOutput(launch);

    if (signal && signal.aborted) {
      await cancelOwned();
      throw abortError();
    }

    try {
      const waitPayload = await ipcRequest(
        socketPath,
        IPC_WAIT_METHOD,
        { task_run_id: taskRunId },
        { timeout: null, signal },
      );
      return canonicalOutput(waitPayload);
    } catch (err) {
      if (signal && signal.aborted) {
        await cancelOwned();
        throw abortError();
      }
      throw err;
    }
  };
}

/**
 * Workspace-document aliases route straight to the owner-only NDJSON IPC
 * surface: params are forwarded unchanged to the canonical workspace.doc.*
 * method and the daemon applies its workspace-root path restriction and
 * expectedContent CAS. There is no MCP fallback and no generic filesystem or
 * delete/rename surface; backend IPC errors surface as bounded rejections.
 */
function makeDocExecute(socketPath, ipcMethod) {
  return async function execute(input, { signal } = {}) {
    const result = await ipcRequest(socketPath, ipcMethod, input || {}, { signal });
    if (typeof result === 'string') return result;
    return JSON.stringify(result === undefined ? null : result, null, 2);
  };
}

function registerTool(tools, aliasName, canonicalTool, execute) {
  const definition = {
    name: aliasName,
    description: typeof canonicalTool.description === 'string' ? canonicalTool.description : '',
    parameters: sanitizeSchema(canonicalTool.inputSchema || canonicalTool.schema),
    output: dshOutput(),
    isConcurrencySafe: () => true,
    execute,
  };
  if (aliasName !== 'run_task') definition.timeoutMs = DEFAULT_TIMEOUT_MS;
  tools.register(definition);
}

export async function apply(ctx) {
  const { tools } = ctx;
  if (typeof ctx.on === 'function') {
    ctx.on('tools/pre-execute', async (exec, next) => {
      // Authority for the seven Wrenyard aliases lives in the Wrenyard backend,
      // so those are allowed here. Every other native tool (bash, fs, browser,
      // ...) must continue through DSH's own approval/sandbox policy via next()
      // and is never short-circuited.
      if (exec && typeof exec.name === 'string' && WRENYARD_ALIAS_NAMES.has(exec.name)) {
        return { kind: 'allow' };
      }
      return next();
    });
  }

  const mcpUrl = process.env.WRENYARD_MCP_URL || process.env.FOREMAN_MCP_URL || DEFAULT_MCP_URL;
  const sender = process.env.WRENYARD_MCP_SENDER || process.env.FOREMAN_MCP_SENDER || undefined;

  let catalog;
  try {
    catalog = await listTools(mcpUrl, sender);
  } catch (err) {
    throw new Error(`Wrenyard: MCP is unavailable: ${boundedMessage(err)}`);
  }

  const byName = new Map(
    catalog.filter((tool) => tool && typeof tool.name === 'string').map((tool) => [tool.name, tool]),
  );

  const taskList = byName.get(TASK_CANONICAL.list_task);
  const taskDescribe = byName.get(TASK_CANONICAL.describe_task);
  const taskRun = byName.get(TASK_CANONICAL.run_task);
  if (!taskList || !taskDescribe || !taskRun) {
    throw new Error('Wrenyard: MCP catalog missing required task tool (task_list/task_describe/task_run)');
  }

  registerTool(tools, 'list_task', taskList, makeExecute(mcpUrl, sender, TASK_CANONICAL.list_task));
  registerTool(tools, 'describe_task', taskDescribe, makeExecute(mcpUrl, sender, TASK_CANONICAL.describe_task));

  const socketPath = wrenyardIpcPath();
  registerTool(tools, 'run_task', taskRun, makeRunTaskExecute(mcpUrl, sender, socketPath));

  // The four workspace-doc aliases depend only on the owner-only IPC socket,
  // not on the MCP task catalog, and inherit the same bounded-error path.
  for (const alias of Object.keys(DOC_ALIAS_TO_IPC)) {
    registerTool(tools, alias, DOC_DEFINITIONS[alias], makeDocExecute(socketPath, DOC_ALIAS_TO_IPC[alias]));
  }
}

export default { name, inject, apply };
