/**
 * @wrenyard/dsh-shell
 *
 * Wrenyard owner-only IPC tools bridge for DeepSeek Harness (DSH) Code Mode.
 *
 * A self-contained Cordis plugin compatible with @deepseek-ai/dsh@0.1.0-rc.6.
 * It talks only to Wrenyard's owner-only NDJSON IPC surface, whose wire protocol
 * is stable. It never imports Wrenyard or Wrenyard source, never logs credentials
 * or raw environment values, and bundles no internal provider.
 *
 * Exactly nine Desktop/DSH model-visible tools are exposed under stable aliases.
 * Every tool is a read-only projection or a bounded mutation over the owner-only
 * NDJSON IPC surface:
 *   - list_task            -> task.definition.list (IPC, read-only)
 *   - describe_task        -> task.definition.describe (IPC, read-only)
 *   - run_task             -> task.run.create + task.run.wait / task.run.cancel (IPC)
 *   - list_workspace_docs  -> workspace.doc.list (IPC)
 *   - read_workspace_doc   -> workspace.doc.read (IPC)
 *   - create_workspace_doc -> workspace.doc.create (IPC)
 *   - update_workspace_doc -> workspace.doc.update (IPC; expectedContent CAS)
 *   - list_projects        -> project.list (IPC, read-only)
 *   - list_runtimes        -> task.settings.runtimes (IPC, read-only)
 */

import net from 'node:net';

export const name = 'wrenyard-foreman-tools';

export const inject = ['tools'];

const DEFAULT_TIMEOUT_MS = 180_000;
const IPC_TIMEOUT_MS = 5_000;

// Every fresh owner-only IPC connection must complete a version-tagged
// health.ping handshake before any business request; the daemon rejects a
// business method sent first. This standalone plugin cannot import the
// TypeScript control-client, so the wire version and the mismatch text are
// mirrored locally and must stay in lockstep with WRENYARD_PROTOCOL_VERSION
// and protocolVersionMismatchMessage in @wrenyard/control-client. The handshake
// is IPC-only and never invokes a task, so it adds no recursion.
const IPC_HANDSHAKE_METHOD = 'health.ping';
const WRENYARD_PROTOCOL_VERSION = 1;

// Owner-only NDJSON IPC methods. run_task is create + wait/cancel; the two task
// read aliases are the definition list/describe projections.
const IPC_TASK_LIST_METHOD = 'task.definition.list';
const IPC_TASK_DESCRIBE_METHOD = 'task.definition.describe';
const IPC_RUN_CREATE_METHOD = 'task.run.create';
const IPC_WAIT_METHOD = 'task.run.wait';
const IPC_CANCEL_METHOD = 'task.run.cancel';

// Desktop-only opt-in: with WRENYARD_DESKTOP_ASYNC_TASKS=1 run_task returns
// the launch identity immediately and Desktop delivers the terminal result
// through session.prompt; every other client keeps the blocking wait.
const DESKTOP_ASYNC_ENV = 'WRENYARD_DESKTOP_ASYNC_TASKS';

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
const TASK_ALIAS_NAMES = ['list_task', 'describe_task', 'run_task'];
const WRENYARD_ALIAS_NAMES = new Set([...TASK_ALIAS_NAMES, ...Object.keys(DOC_ALIAS_TO_IPC), ...Object.keys(DISCOVERY_ALIAS_TO_IPC)]);

// Local task-tool definitions: the aliases talk straight to the daemon's
// owner-only IPC methods, so their descriptions and input schemas live here
// instead of being projected from a remote tool catalog.
const TASK_DEFINITIONS = {
  list_task: {
    description:
      'List available Wrenyard task definitions (read-only). Without a project, returns only generic/common tasks; with a project, returns generic plus that project\'s task definitions.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Optional project id to include project-specific task definitions.' },
      },
      additionalProperties: false,
    },
  },
  describe_task: {
    description:
      'Get the detailed schema and contract for one Wrenyard task definition (read-only).',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Task definition name.' },
        project: { type: 'string', description: 'Optional project scope for the definition.' },
      },
      required: ['task_id'],
      additionalProperties: false,
    },
  },
};

// run_task forwards its input unchanged to task.run.create, so its parameters
// mirror that method's schema: the one-shot invocation_settings layer (routing,
// timeout, automatic dispatch) plus the optional bounded ctx. Runtime selection
// is expressed only through invocation_settings / the mutually exclusive
// mode/automatic/explicit_runtime top-level forms.
const RUN_TASK_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    task_id: { type: 'string', description: 'Task definition name to run.' },
    project: { type: 'string', description: 'Project id that owns the task definition.' },
    worktree: { type: 'string', description: 'Optional managed worktree id.' },
    input: { description: 'Task input payload, validated against the definition input schema.' },
    ctx: { type: 'object', additionalProperties: true, description: 'Bounded JSON-safe KV context inherited by this task run.' },
    invocation_settings: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['automatic', 'explicit'] },
        explicit_runtime: { type: 'object', additionalProperties: true },
        timeout_ms: { type: 'number' },
        automatic: { type: 'object', additionalProperties: true },
        max_auto_output_usd_per_million: { type: 'number' },
        routing_weights: { type: 'object', additionalProperties: true },
      },
      additionalProperties: true,
      description: 'One-shot invocation settings for this run only; applies to this run and is never persisted.',
    },
    mode: { type: 'string', enum: ['automatic', 'explicit'] },
    automatic: { type: 'object', additionalProperties: true },
    explicit_runtime: { type: 'object', additionalProperties: true },
  },
  required: ['task_id', 'project'],
  additionalProperties: false,
};

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

/** Render one owner-only IPC result as stable text for the model. */
function ipcText(result) {
  if (typeof result === 'string') return result;
  return JSON.stringify(result === undefined ? null : result, null, 2);
}

function pick(result, keys) {
  if (!result || typeof result !== 'object') return undefined;
  for (const key of keys) {
    if (result[key] !== undefined) return result[key];
  }
  return undefined;
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

/**
 * Resolve the Wrenyard NDJSON IPC socket. WRENYARD_IPC_PATH overrides the
 * platform default when set to a non-blank value. Without an override,
 * Windows uses the daemon's named pipe and Unix uses the shared socket path.
 */
export function wrenyardIpcPath(env = process.env) {
  const socketPath = env.WRENYARD_IPC_PATH?.trim();
  if (socketPath) return socketPath;
  return process.platform === 'win32' ? '\\\\.\\pipe\\wrenyard' : '/tmp/wrenyard.sock';
}

/**
 * Exact operator-facing text for a missing or different daemon protocol
 * version, mirrored from the control-client so DSH and the CLI report the same
 * actionable message. A non-numeric daemon version renders as 未知, matching
 * the client-side helper's fail-closed behavior.
 */
function protocolVersionMismatchMessage(cliVersion, daemonVersion) {
  const daemon = typeof daemonVersion === 'number' ? String(daemonVersion) : '未知';
  return `CLI 与 daemon 协议版本不一致（CLI ${cliVersion}，daemon ${daemon}），请使用同一版本`;
}

function ipcRequest(socketPath, method, params, { timeout = IPC_TIMEOUT_MS, signal } = {}) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(socketPath);
    let lineBuffer = '';
    let settled = false;
    // False until the version-tagged health.ping reply is accepted; the
    // business request is only written after that, so no business method can
    // ever be the first frame on a fresh connection.
    let handshaken = false;

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

    const writeLine = (message) => {
      sock.write(`${JSON.stringify(message)}\n`);
    };

    // Decode once at the socket boundary so a multi-byte UTF-8 character split
    // across chunks is reassembled by the stream decoder, not corrupted by a
    // per-chunk toString().
    sock.setEncoding('utf8');
    sock.on('connect', () => {
      writeLine({
        jsonrpc: '2.0',
        id: 0,
        method: IPC_HANDSHAKE_METHOD,
        params: { protocolVersion: WRENYARD_PROTOCOL_VERSION },
      });
    });
    sock.on('data', (chunk) => {
      lineBuffer += chunk;
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
        if (!handshaken) {
          // Validate correlation before interpreting any error: only the
          // pending handshake reply (id 0) may settle the connection.
          if (msg.id !== 0) continue;
          if (msg.error) {
            finish(new Error(`Wrenyard IPC handshake error: ${msg.error.message || msg.error || 'unknown'}`));
            return;
          }
          const result = msg.result && typeof msg.result === 'object' ? msg.result : undefined;
          const daemonVersion = result ? result.protocolVersion : undefined;
          if (daemonVersion !== WRENYARD_PROTOCOL_VERSION) {
            finish(new Error(protocolVersionMismatchMessage(WRENYARD_PROTOCOL_VERSION, daemonVersion)));
            return;
          }
          if (result.ok !== true) {
            finish(new Error('Wrenyard IPC handshake failed'));
            return;
          }
          handshaken = true;
          writeLine({ jsonrpc: '2.0', id: 1, method, params });
          continue;
        }
        // Same correlation rule for the business reply (id 1).
        if (msg.id !== 1) continue;
        if (msg.error) {
          finish(new Error(`Wrenyard IPC error: ${msg.error.message || msg.error || 'unknown'}`));
          return;
        }
        finish(null, msg.result !== undefined ? msg.result : msg);
        return;
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

/**
 * Task read aliases route straight to the owner-only NDJSON IPC surface with
 * explicitly shaped params, so an unknown model-supplied key can never reach the
 * daemon's task-definition methods.
 */
function makeTaskExecute(socketPath, ipcMethod) {
  return async function execute(input, { signal } = {}) {
    const source = input && typeof input === 'object' ? input : {};
    const params = {};
    if (ipcMethod === IPC_TASK_DESCRIBE_METHOD && typeof source.task_id === 'string') params.task_id = source.task_id;
    if (typeof source.project === 'string') params.project = source.project;
    const result = await ipcRequest(socketPath, ipcMethod, params, { signal, timeout: DEFAULT_TIMEOUT_MS });
    return ipcText(result);
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
    if (event?.type === 'user/message' && event.data?.source?.kind === 'user'
      && !contentText(event.data.content).trimStart().startsWith('[wrenyard:task-results]')) {
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
      // DSH session.prompt labels internal result delivery as user input.
      // Do not forward that system envelope as a fresh human request.
      const rawText = contentText(message.content).trim();
      if (rawText.startsWith('[wrenyard:task-results]')) continue;
      const text = redactTranscriptText(rawText).trim();
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
/**
 * Exact exec.agent/session identity for yield-after-dispatch tracking. The
 * Agent type documents `agent.id` as the single identity shared with its
 * session, so the session id is the fallback when a bare session object is
 * supplied; a module-scoped "current session" is deliberately never used.
 */
function agentYieldKey(agent) {
  const id = agent && typeof agent.id === 'string' && agent.id ? agent.id : undefined;
  if (id) return id;
  const session = agent && agent.session;
  const sessionId = session && typeof session.id === 'string' ? session.id : undefined;
  return sessionId || undefined;
}

/** Actual queued input must never be discarded by the yield guard. */
function stepHasNewInputOrResult(messages) {
  return Array.isArray(messages) && messages.length > 0;
}

function makeRunTaskExecute(socketPath, { desktopAsync = false, pendingYields } = {}) {
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
    // discard a successfully created task_run_id. A bounded IPC deadline still
    // applies to the create request.
    const launch = await ipcRequest(socketPath, IPC_RUN_CREATE_METHOD, payload, { timeout: DEFAULT_TIMEOUT_MS });
    taskRunId = pick(launch, ['task_run_id', 'task_id', 'taskRunId', 'id']);
    if (taskRunId === undefined) {
      // Surface the real backend error but keep whatever run metadata arrived.
      const text = ipcText(launch);
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

    if (desktopAsync) {
      // Nonblocking Desktop dispatch: return the canonical launch/run identity
      // as soon as the run is durably created. The terminal result is pending
      // and is delivered by Desktop through session.prompt; there is no wait,
      // no polling, and no fabricated terminal outcome. The yield flag is
      // keyed by this call's exact agent/session identity so the pre-step
      // waterfall can refuse the empty continuation step this dispatch would
      // otherwise trigger, while a later real wake still reaches the model.
      const yieldKey = agentYieldKey(exec.agent);
      if (yieldKey !== undefined && pendingYields) pendingYields.set(yieldKey, taskRunId);
      const launchText = ipcText(launch);
      return (
        `${launchText}\n` +
        `[async dispatch: task_run_id=${JSON.stringify(taskRunId)} is running. ` +
        'The terminal result is pending and will be delivered automatically to this conversation; ' +
        'do not poll, do not call task.run.wait, and do not fabricate a result.]'
      );
    }

    try {
      const waitPayload = await ipcRequest(
        socketPath,
        IPC_WAIT_METHOD,
        { task_run_id: taskRunId },
        { timeout: null, signal },
      );
      return ipcText(waitPayload);
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

function registerTool(tools, aliasName, aliasDefinition, execute) {
  // run_task owns its own schema so the model-facing description can carry the
  // "canonical target from list_runtimes" rule; every other alias is described
  // by its own local definition.
  const definition = {
    name: aliasName,
    description: typeof aliasDefinition.description === 'string' ? aliasDefinition.description : '',
    parameters: aliasDefinition.inputSchema || aliasDefinition.schema || { type: 'object', additionalProperties: false },
    output: dshOutput(),
    isConcurrencySafe: () => true,
    execute,
  };
  if (aliasName !== 'run_task') definition.timeoutMs = DEFAULT_TIMEOUT_MS;
  tools.register(definition);
}

function registerRunTask(tools, parameters, execute, { desktopAsync = false } = {}) {
  const definition = {
    name: 'run_task',
    description: desktopAsync
      ? 'Dispatch one Wrenyard Task and return immediately with its launch identity (task_run_id); do NOT wait, poll, or invent an outcome — the terminal result is pending and is delivered automatically to this conversation. ' +
        `When you need to name a target, runtime, provider, model, or client, call list_runtimes first and use an entry with available=true exactly as returned — ${RUNTIMES_TARGET_RULE} ` +
        'Prefer the default automatic routing and omit any runtime target unless the user explicitly named one or routing already failed. ' +
        `The caller\'s recent conversation in this session is attached to ctx.orchestration automatically (key \`${ORCHESTRATION_CONVERSATION_KEY}\`), so pass only the necessary delta in the task arguments — do not restate the whole chat, and do not write ctx.orchestration yourself. ` +
        'Continue with other work after dispatch; a failed run reports its real error when delivered, and there is no implicit retry or fallback.'
      : 'Dispatch one Wrenyard Task and wait for its terminal result (no polling). ' +
      `When you need to name a target, runtime, provider, model, or client, call list_runtimes first and use an entry with available=true exactly as returned — ${RUNTIMES_TARGET_RULE} ` +
      'Prefer the default automatic routing and omit any runtime target unless the user explicitly named one or routing already failed. ' +
      `The caller\'s recent conversation in this session is attached to ctx.orchestration automatically (key \`${ORCHESTRATION_CONVERSATION_KEY}\`), so pass only the necessary delta in the task arguments — do not restate the whole chat, and do not write ctx.orchestration yourself. ` +
      'A failed run reports its real error and any task_run_id metadata; there is no implicit retry or fallback.',
    parameters,
    output: dshOutput(),
    isConcurrencySafe: () => true,
    execute,
  };
  tools.register(definition);
}

export async function apply(ctx) {
  const { tools } = ctx;
  const desktopAsync = process.env[DESKTOP_ASYNC_ENV] === '1';
  // Yield-after-dispatch registry, keyed by exact exec.agent/session identity.
  const pendingYields = new Map();
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

    if (desktopAsync) {
      // Documented DSH agent/pre-step waterfall (dsh 0.1.1-rc.2): when this
      // agent dispatched a task in the previous step and the proposed step
      // carries no new input or tool result, consume its yield flag and
      // reject the empty continuation before the next model request. New
      // input and other agents always flow through via next().
      ctx.on('agent/pre-step', async (payload, next) => {
        const key = payload && agentYieldKey(payload.agent);
        if (key === undefined || !pendingYields.has(key)) return next();
        pendingYields.delete(key);
        if (stepHasNewInputOrResult(payload && payload.messages)) return next();
        return { kind: 'reject' };
      });
    }
  }

  // Every alias is IPC-only; there is no remote tool catalog to fetch, so
  // registration is synchronous and never depends on daemon availability.
  const socketPath = wrenyardIpcPath();

  registerTool(tools, 'list_task', TASK_DEFINITIONS.list_task, makeTaskExecute(socketPath, IPC_TASK_LIST_METHOD));
  registerTool(tools, 'describe_task', TASK_DEFINITIONS.describe_task, makeTaskExecute(socketPath, IPC_TASK_DESCRIBE_METHOD));
  registerRunTask(tools, RUN_TASK_INPUT_SCHEMA, makeRunTaskExecute(socketPath, { desktopAsync, pendingYields }), { desktopAsync });

  // The four workspace-doc aliases depend only on the owner-only IPC socket.
  for (const alias of Object.keys(DOC_ALIAS_TO_IPC)) {
    registerTool(tools, alias, DOC_DEFINITIONS[alias], makeDocExecute(socketPath, DOC_ALIAS_TO_IPC[alias]));
  }

  // Read-only discovery aliases: same owner-only IPC surface, explicit
  // definitions, no mutation.
  for (const alias of Object.keys(DISCOVERY_ALIAS_TO_IPC)) {
    registerTool(tools, alias, DISCOVERY_DEFINITIONS[alias], makeDiscoveryExecute(socketPath, DISCOVERY_ALIAS_TO_IPC[alias]));
  }
}

export default { name, inject, apply };
