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
 * Exactly nine Desktop/DSH model-visible tools are exposed under stable
 * aliases. The three task tools are mapped to canonical MCP definitions; the
 * four workspace-document tools talk only to the owner-only NDJSON IPC
 * surface; the two discovery tools are read-only IPC projections:
 *   - list_task            -> task_list (MCP)
 *   - describe_task        -> task_describe (MCP)
 *   - run_task             -> task_run (MCP) + IPC task.run.wait / task.run.cancel
 *   - list_workspace_docs  -> workspace.doc.list (owner-only IPC)
 *   - read_workspace_doc   -> workspace.doc.read (owner-only IPC)
 *   - create_workspace_doc -> workspace.doc.create (owner-only IPC)
 *   - update_workspace_doc -> workspace.doc.update (owner-only IPC; expectedContent CAS)
 *   - list_projects        -> project.list (owner-only IPC, read-only)
 *   - list_runtimes        -> task.settings.runtimes (owner-only IPC, read-only)
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

// Read-only runtime discovery always talks to the owner-only IPC surface; it
// is never a model-driven mutation and never falls back to MCP.
const IPC_PROJECT_LIST_METHOD = 'project.list';
const IPC_RUNTIMES_METHOD = 'task.settings.runtimes';

const DISCOVERY_ALIAS_TO_IPC = {
  list_projects: IPC_PROJECT_LIST_METHOD,
  list_runtimes: IPC_RUNTIMES_METHOD,
};

// Non-negotiable routing constraints, surfaced verbatim to the model so a
// runtime target can only come from list_runtimes output.
const RUNTIMES_TARGET_RULE =
  'Each item has {target,provider,model,client,mode,available} (plus reason when unavailable). Every target MUST be copied from an item whose available=true; never invent, guess, or reuse a project/client/model from another task or from memory.';

// The nine model-visible aliases keep their execution authority in the
// Wrenyard backend. Only these names may short-circuit the pre-execute
// waterfall; every other native tool must keep flowing through DSH policy.
const WRENYARD_ALIAS_NAMES = new Set([...Object.keys(TASK_CANONICAL), ...Object.keys(DOC_ALIAS_TO_IPC), ...Object.keys(DISCOVERY_ALIAS_TO_IPC)]);

const DISCOVERY_DEFINITIONS = {
  list_projects: {
    description:
      'List registered Wrenyard projects (read-only). Discover the exact project id before dispatch when it is unknown; never invent it. Project selection does not change automatic model routing.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  list_runtimes: {
    description:
      `List the runtime targets (provider/model/client/mode) a task may be routed to, with availability (read-only). ${RUNTIMES_TARGET_RULE} ` +
      'Pass task_id of an existing task when the caller wants that task\'s effective candidates; pass project to scope discovery. ' +
      'Leave the runtime unspecified for default automatic routing; call this only for explicit discovery, a user-named runtime, or after a confirmed routing failure, then return to automatic routing.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Optional project id to scope the candidate runtimes.' },
        task_id: { type: 'string', description: 'Task whose effective runtime candidates should be listed.' },
      },
      required: ['task_id'],
      additionalProperties: false,
    },
  },
};

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

// ---------------------------------------------------------------------------
// Same-session conversation handoff
//
// run_task may attach the *current* conversation as `ctx.orchestration` so a
// dispatched task receives the dialogue that led to it without the caller
// restating it. The source is strictly the executing call's own agent session
// (`exec.agent.session`), read once per call — never a module-scoped or shared
// "current session", which would cross-talk between concurrent sessions.
//
// Only human-authored surface messages are eligible: the last `user/message`
// whose `source.kind === 'user'` (a plugin-injected or synthetic user message
// is NOT a human turn) plus the text of the assistant messages preceding it.
// Reasoning blocks and tool results are deliberately excluded, and raw tool
// output never enters the transcript. Bounded, sanitized, and only a fragment:
// the budget is whatever is left of the 16 KiB ctx allowance after the
// model-supplied keys.
// ---------------------------------------------------------------------------

/** Total serialized ctx budget the backend accepts for one run. */
const CTX_MAX_BYTES = 16 * 1024;
/** Maximum number of top-level ctx keys the backend accepts. */
const CTX_MAX_KEYS = 64;
/** Reserved key inside `ctx.orchestration` for the attached transcript. */
const ORCHESTRATION_CONVERSATION_KEY = 'source_conversation';
/** Bytes set aside for envelope keys (sessionId/callId/labels) inside the budget. */
const ORCHESTRATION_ENVELOPE_BYTES = 512;

const SECRET_PATTERNS = [
  // Provider-shaped tokens (OpenAI, GitHub, AWS, JWT) regardless of context.
  /sk-[A-Za-z0-9_-]{16,}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  // `name=value` / `name: value` assignments whose value looks like a secret.
  /(\b(?:api[_-]?key|apikey|access[_-]?token|auth[_-]?token|refresh[_-]?token|secret|password|passwd|passphrase|credential|private[_-]?key|bearer)\b["']?\s*[:=]\s*["']?)[^\s"',;]{8,}/gi,
  // Bare `Authorization: Bearer <token>` headers.
  /(authorization\s*[:=]\s*)(?:bearer\s+)?[^\s"',;]{8,}/gi,
];

/**
 * Redact obvious credential shapes from free text before it leaves this
 * process. Bounded and best-effort: it removes recognizable token/key
 * patterns, and callers additionally never forward raw environment values or
 * tool output.
 * @param text - untrusted free text.
 * @returns the text with credential-looking substrings replaced.
 */
export function redactTranscriptText(text) {
  if (typeof text !== 'string' || text.length === 0) return '';
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    // Patterns with a leading capture group keep their label and replace only
    // the credential value, so the transcript still reads naturally.
    out = out.replace(pattern, (...groups) =>
      (typeof groups[1] === 'string' && groups[1].length > 0 ? `${groups[1]}[redacted]` : '[redacted]'));
  }
  return out;
}

function contentText(content) {
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('\n');
}

function clipUtf8(text, maxBytes) {
  let low = 0, high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(text.slice(0, middle), 'utf8') <= maxBytes) low = middle;
    else high = middle - 1;
  }
  // Avoid cutting a surrogate pair.
  if (low > 0 && /[\uD800-\uDBFF]/.test(text[low - 1])) low -= 1;
  return text.slice(0, low);
}

/**
 * Derive the bounded prior-dialogue tail from one agent session's event log.
 * Scans backwards for the most recent human `user/message` and keeps the
 * chronological dialogue from there to the log end, so the returned transcript
 * ends on the human turn that triggered this call. Reasoning, tool results, and
 * plugin-injected user messages are all skipped.
 * @param events - `exec.agent.session.events`, in log order.
 * @returns chronological `{role,text}` turns, possibly empty.
 */
export function deriveConversationTail(events) {
  if (!Array.isArray(events) || events.length === 0) return [];

  let startIndex = -1;
  let humanTurns = 0;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === 'user/message' && event.data?.source?.kind === 'user') {
      startIndex = index;
      if (++humanTurns >= 8) break;
    }
  }
  if (startIndex < 0) return [];

  const turns = [];
  for (let index = startIndex; index < events.length; index += 1) {
    const event = events[index];
    if (!event) continue;
    if (event.type === 'user/message') {
      const message = event.data;
      if (!message || !message.source || message.source.kind !== 'user') continue;
      const text = redactTranscriptText(contentText(message.content)).trim();
      if (text) turns.push({ role: 'user', text });
    } else if (event.type === 'assistant/message') {
      // Only visible assistant text: reasoning blocks are dropped by
      // contentText(), and tool calls/results never reach this branch.
      const text = redactTranscriptText(contentText(event.data && event.data.message && event.data.message.content)).trim();
      if (text) turns.push({ role: 'assistant', text });
    }
  }
  return turns;
}

/**
 * Merge the bounded current conversation into a model-supplied ctx without
 * overriding anything the model wrote.
 *
 * `ctx.orchestration` and `ctx.orchestration.source_conversation` are always
 * preserved verbatim: when the model already supplied either, this returns the
 * caller ctx untouched and only reports a status. The transcript is fitted to
 * whatever byte budget remains under {@link CTX_MAX_BYTES} after the supplied
 * ctx, so the overall context stays valid; if there is no room, nothing is
 * attached.
 * @param inputCtx - caller-supplied `task_run` `ctx`, if any.
 * @param events - the executing call's own session events.
 * @param correlation - `{sessionId, callId}` used for correlation when budget allows.
 * @returns `{ctx, attached, status}` where `ctx` is safe to send.
 */
export function mergeOrchestrationContext(inputCtx, events, correlation = {}) {
  const supplied = inputCtx && typeof inputCtx === 'object' && !Array.isArray(inputCtx) ? inputCtx : {};
  if (supplied.orchestration !== undefined) {
    return { ctx: supplied, attached: false, status: 'preserved: caller supplied ctx.orchestration' };
  }
  if (Object.keys(supplied).length >= CTX_MAX_KEYS) {
    return { ctx: supplied, attached: false, status: 'skipped: ctx key budget exhausted' };
  }

  const turns = deriveConversationTail(events);
  if (turns.length === 0) return { ctx: supplied, attached: false, status: 'skipped: no human turn in this session' };

  const usedBytes = Buffer.byteLength(JSON.stringify(supplied), 'utf8');
  let budget = CTX_MAX_BYTES - usedBytes - ORCHESTRATION_ENVELOPE_BYTES;
  if (budget <= 0) return { ctx: supplied, attached: false, status: 'skipped: ctx byte budget exhausted' };

  // Reserve the triggering user request before fitting recent dialogue.
  // Large assistant messages must not evict the request they are answering.
  const currentUser = turns.findLastIndex((turn) => turn.role === 'user');
  const selected = new Map();
  let transcriptBytes = 0;
  const add = (index) => {
    const room = budget - transcriptBytes - 64;
    if (room <= 0) return;
    const turn = turns[index];
    let text = clipUtf8(turn.text, Math.min(room, 6000));
    while (text && Buffer.byteLength(JSON.stringify({ role: turn.role, text }), 'utf8') + 1 > room) {
      text = text.slice(0, Math.floor(text.length * 0.8));
    }
    if (!text) return;
    const clipped = { role: turn.role, text };
    selected.set(index, clipped);
    transcriptBytes += Buffer.byteLength(JSON.stringify(clipped), 'utf8') + 1;
  };
  if (currentUser >= 0) add(currentUser);
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    if (index !== currentUser) add(index);
  }
  const kept = [...selected.entries()].sort(([a], [b]) => a - b).map(([, turn]) => turn);
  if (!kept.length) return { ctx: supplied, attached: false, status: 'skipped: ctx byte budget exhausted' };

  const orchestration = { [ORCHESTRATION_CONVERSATION_KEY]: kept };
  if (typeof correlation.sessionId === 'string' && correlation.sessionId) {
    orchestration.sessionId = correlation.sessionId;
  }
  if (typeof correlation.callId === 'string' && correlation.callId) {
    orchestration.callId = correlation.callId;
  }

  const next = { ...supplied, orchestration };
  if (Buffer.byteLength(JSON.stringify(next), 'utf8') > CTX_MAX_BYTES) {
    delete orchestration.callId;
    if (Buffer.byteLength(JSON.stringify(next), 'utf8') > CTX_MAX_BYTES) {
      return { ctx: supplied, attached: false, status: 'skipped: ctx byte budget exhausted' };
    }
  }

  return {
    ctx: next,
    attached: true,
    status: `attached: ${kept.length} turn(s), ${transcriptBytes}B`,
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
  return async function execute(input, exec = {}) {
    const { signal } = exec;
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

    // Same-session handoff: read THIS call's own agent session (never a shared
    // module-scoped "current session") and attach the bounded dialogue tail the
    // model did not already supply. Deriving the ctx is pure local work — no
    // model call, no extra IPC, no polling.
    const session = exec.agent && exec.agent.session;
    const sessionEvents = session && Array.isArray(session.events) ? session.events : [];
    const modelCtx = input && typeof input === 'object' ? input.ctx : undefined;
    const merged = mergeOrchestrationContext(modelCtx, sessionEvents, {
      sessionId: session && typeof session.id === 'string' ? session.id : undefined,
      callId: typeof exec.callId === 'string' ? exec.callId : undefined,
    });
    const payload = input && typeof input === 'object' ? { ...input } : {};
    if (merged.attached) payload.ctx = merged.ctx;
    else if (merged.ctx !== modelCtx && modelCtx === undefined) delete payload.ctx;

    // The caller signal is not passed here: an abort during create must not
    // discard a successfully created task_run_id. The bounded MCP timeout is
    // preserved via the existing callTool default.
    const launch = await callTool(mcpUrl, sender, TASK_CANONICAL.run_task, payload, {});
    taskRunId = pick(launch, ['task_run_id', 'task_id', 'taskRunId', 'id']);
    if (taskRunId === undefined) {
      // Surface the real backend error but keep whatever run metadata arrived.
      const text = canonicalOutput(launch);
      if (merged.status.startsWith('skipped:')) {
        const err = new Error(`${text}\n[current conversation was not attached to ctx.orchestration — ${merged.status}]`);
        err.isToolError = true;
        throw err;
      }
      return text;
    }

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

/**
 * Read-only discovery aliases. list_projects takes no parameters; list_runtimes
 * takes an optional project scope and a required task_id. Params are shaped
 * explicitly (never forwarded blindly) so an unknown model-supplied key can
 * never reach the daemon, and the read-only contract
 * `{items:[{target,provider,model,client,mode,available,reason?}]}` is what the
 * model is taught to read. No MCP fallback, no mutation.
 */
function makeDiscoveryExecute(socketPath, ipcMethod) {
  return async function execute(input, { signal } = {}) {
    const source = input && typeof input === 'object' ? input : {};
    let params = {};
    if (ipcMethod === IPC_RUNTIMES_METHOD) {
      if (typeof source.project === 'string') params.project = source.project;
      if (typeof source.task_id === 'string') params.task_id = source.task_id;
    }
    const result = await ipcRequest(socketPath, ipcMethod, params, { signal });
    if (typeof result === 'string') return result;
    return JSON.stringify(result === undefined ? null : result, null, 2);
  };
}

function registerTool(tools, aliasName, canonicalTool, execute) {
  // run_task owns its own schema so the model-facing description can carry the
  // "canonical target from list_runtimes" rule; everything else inherits the
  // canonical MCP description verbatim.
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

function registerRunTask(tools, canonicalTool, execute) {
  const definition = {
    name: 'run_task',
    description:
      'Dispatch one Wrenyard Task and wait for its terminal result (no polling). ' +
      `When you need to name a target, runtime, provider, model, or client, call list_runtimes first and use an entry with available=true exactly as returned — ${RUNTIMES_TARGET_RULE} ` +
      'Prefer the default automatic routing and omit any runtime target unless the user explicitly named one or routing already failed. ' +
      `The caller\'s recent conversation in this session is attached to ctx.orchestration automatically (key \`${ORCHESTRATION_CONVERSATION_KEY}\`), so pass only the necessary delta in the task arguments — do not restate the whole chat, and do not write ctx.orchestration yourself. ` +
      'A failed run reports its real error and any task_run_id metadata; there is no implicit retry or fallback.',
    parameters: sanitizeSchema(canonicalTool.inputSchema || canonicalTool.schema),
    output: dshOutput(),
    isConcurrencySafe: () => true,
    execute,
  };
  tools.register(definition);
}

export async function apply(ctx) {
  const { tools } = ctx;
  if (typeof ctx.on === 'function') {
    ctx.on('tools/pre-execute', async (exec, next) => {
      // Authority for the nine Wrenyard aliases lives in the Wrenyard backend,
      // so those are allowed here. Every other native tool (bash, fs, browser,
      // ...) must continue through DSH's native execution chain via next().
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
  registerRunTask(tools, taskRun, makeRunTaskExecute(mcpUrl, sender, socketPath));

  // The four workspace-doc aliases depend only on the owner-only IPC socket,
  // not on the MCP task catalog, and inherit the same bounded-error path.
  for (const alias of Object.keys(DOC_ALIAS_TO_IPC)) {
    registerTool(tools, alias, DOC_DEFINITIONS[alias], makeDocExecute(socketPath, DOC_ALIAS_TO_IPC[alias]));
  }

  // Read-only discovery aliases: same owner-only IPC surface, explicit
  // definitions (not MCP-derived), no mutation and no MCP fallback.
  for (const alias of Object.keys(DISCOVERY_ALIAS_TO_IPC)) {
    registerTool(tools, alias, DISCOVERY_DEFINITIONS[alias], makeDiscoveryExecute(socketPath, DISCOVERY_ALIAS_TO_IPC[alias]));
  }
}

export default { name, inject, apply };
