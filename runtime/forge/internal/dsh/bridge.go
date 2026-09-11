package dsh

// BridgeProtocol is the JSONL stream protocol name emitted by the embedded
// bridge plugin.
const BridgeProtocol = "forge.dsh.stream.v1"

// PluginName is the ESM plugin name exported by the embedded bridge.
const PluginName = "forge-dsh-bridge"

// PluginFilename is the recommended file name for the embedded plugin inside
// the isolated per-run DSH_HOME.
const PluginFilename = "forge-dsh-bridge.mjs"

// PluginSource is the embedded ESM Cordis plugin for headless DSH. It exports
// name/apply(ctx), subscribes to session/event, ignores child (subagent)
// session streams, and emits one-line forge.dsh.stream.v1 JSON for the root
// session: real first tokens from assistant/chunk deltas, the final answer
// from assistant/message type=text content blocks, parent tool calls/results,
// and response-paired TPS samples with usage partitions summed once per
// response at turn/end. Model route evidence comes only from request/header
// and request/context and is retained across turns. Secrets are scrubbed and
// never emitted.
const PluginSource = `export const name = 'forge-dsh-bridge';

const PROTOCOL = 'forge.dsh.stream.v1';
const SENSITIVE = /KEY|PASSWORD|SECRET|TOKEN/i;
const EXECUTION_ID = String(Date.now()) + '-' + Math.random().toString(36).slice(2);

function emit(line) {
  process.stdout.write(JSON.stringify(line) + '\n');
}

function scrub(value, depth) {
  depth = depth || 0;
  if (depth > 8) return null;
  if (Array.isArray(value)) {
    const out = [];
    for (const item of value) out.push(scrub(item, depth + 1));
    return out;
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value)) {
      if (SENSITIVE.test(key)) continue;
      out[key] = scrub(value[key], depth + 1);
    }
    return out;
  }
  return value;
}

function dataOf(event) {
  return event && event.data && typeof event.data === 'object' ? event.data : {};
}

function timeMs(event) {
  const value = event && event.time;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function identity(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (typeof value === 'object') {
    if (value.id !== undefined) return identity(value.id);
    if (value.index !== undefined) return identity(value.index);
    if (value.seq !== undefined) return identity(value.seq);
    try { return JSON.stringify(value); } catch (_) { return ''; }
  }
  return '';
}

function responseIdentity(data) {
  const turn = identity(data.turn);
  const step = identity(data.step);
  if (!turn || !step) return null;
  return { turn: turn, step: step, key: turn + '/' + step };
}

// routeModel reads the request/header config model or the request/context
// model. These are the only model sources declared by dsh-session types.d.ts;
// model is never guessed from assistant events.
function routeModel(header, context) {
  const candidates = [
    header && header.config && header.config.model,
    context && context.model
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return '';
}

function nonnegativeSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function usagePart(usage, key) {
  const value = usage && usage[key];
  return nonnegativeSafeInteger(value);
}

// tokenUsageOf validates the separate TokenUsage partitions. A partition that
// is missing or invalid is left null and never fabricated. Usage is returned
// only when at least one input/output partition is present.
function tokenUsageOf(data) {
  const usage = data && data.usage;
  if (!usage || typeof usage !== 'object') return null;
  const input = usagePart(usage, 'inputTokens');
  const output = usagePart(usage, 'outputTokens');
  const cacheRead = usagePart(usage, 'cacheReadTokens');
  const cacheWrite = usagePart(usage, 'cacheWriteTokens');
  if (input === null && output === null && cacheRead === null && cacheWrite === null) return null;
  return { input: input, output: output, cacheRead: cacheRead, cacheWrite: cacheWrite };
}

function stateFor(sessions, id) {
  let s = sessions.get(id);
  if (!s) {
    s = { turn: null, seenSeq: new Set(), model: '', pendingModel: '' };
    sessions.set(id, s);
  }
  return s;
}

function newTurn(id, startedAt) {
  return {
    id: id || '',
    startedAt: startedAt === null ? Date.now() : startedAt,
    responses: new Map(),
    usageObserved: false,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    inputComplete: true, outputComplete: true, cacheReadComplete: true, cacheWriteComplete: true
  };
}

function responseKey(sessionId, response) {
  return sessionId + ':' + response.turn + ':' + response.step;
}

function responseFor(turn, response, sessionId) {
  const key = responseKey(sessionId, response);
  let item = turn.responses.get(key);
  if (!item) {
    item = {
      responseId: EXECUTION_ID + ':' + key,
      model: '',
      firstTokenAt: null,
      completedAt: null,
      completed: false,
      usage: null,
      usageCounted: false,
      invalidSample: false,
      messageSeen: false
    };
    turn.responses.set(key, item);
  }
  return item;
}

// applyPendingModel snapshots the most recent pending route model onto a
// response that first becomes known after the request header/context arrived.
function applyPendingModel(s, item) {
  if (!item || item.model || !s.pendingModel) return;
  item.model = s.pendingModel;
}

// rememberUsage accumulates one response's token partitions exactly once.
// Duplicate same-id usage and conflicting later usage are ignored safely; a
// partition absent on the wire is never fabricated.
function rememberUsage(turn, item, usage) {
  if (!usage || item.usageCounted) return;
  item.usage = usage;
  item.usageCounted = true;
  turn.usageObserved = true;
  if (usage.input === null) turn.inputComplete = false;
  if (usage.output === null) turn.outputComplete = false;
  if (usage.cacheRead === null) turn.cacheReadComplete = false;
  if (usage.cacheWrite === null) turn.cacheWriteComplete = false;
  if (usage.input !== null) turn.inputTokens += usage.input;
  if (usage.output !== null) turn.outputTokens += usage.output;
  if (usage.cacheRead !== null) turn.cacheReadTokens += usage.cacheRead;
  if (usage.cacheWrite !== null) turn.cacheWriteTokens += usage.cacheWrite;
}

// isFirstTokenChunk reports whether an assistant/chunk carries a real first
// token: a text-delta or reasoning-delta with nonempty text, or a
// tool-call-delta with nonempty argumentsDelta or a defined tool name.
function firstTokenOf(data) {
  const chunk = data && data.chunk;
  if (!chunk || typeof chunk !== 'object') return null;
  const type = typeof chunk.type === 'string' ? chunk.type : '';
  if (type === 'text-delta' || type === 'reasoning-delta') {
    return typeof chunk.text === 'string' && chunk.text !== '' ? { kind: type === 'reasoning-delta' ? 'reasoning' : 'text', text: chunk.text } : null;
  }
  if (type === 'tool-call-delta') {
    const args = chunk.argumentsDelta;
    if ((typeof args === 'string' && args !== '') || chunk.name !== undefined) return { kind: 'tool', text: '' };
  }
  return null;
}

// assistantMessageText extracts only type=text content blocks from an
// AssistantMessage. Reasoning blocks are never final visible text.
function assistantMessageText(data) {
  const message = data && data.message;
  if (!message || typeof message !== 'object') return '';
  const content = message.content;
  if (!Array.isArray(content)) return '';
  let out = '';
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type !== 'text') continue;
    if (typeof block.text === 'string') out += block.text;
  }
  return out;
}

// finishSamples pairs each response's own first token, completion and usage.
// Responses with
// no first token, no usage, no model, or non-increasing timestamps are
// skipped rather than fabricated.
function finishSamples(turn) {
  const samples = [];
  for (const item of turn.responses.values()) {
    if (!item.completed) continue;
    const first = item.firstTokenAt;
    if (first === null) continue;
    if (!item.usage || item.usage.output === null) continue;
    if (!item.model || item.invalidSample) continue;
    if (!Number.isFinite(item.completedAt) || item.completedAt <= first) continue;
    samples.push({
      response_id: item.responseId,
      model: item.model,
      output_tokens: item.usage.output,
      first_token_at_ms: first,
      completed_at_ms: item.completedAt
    });
  }
  return samples;
}

export function apply(ctx) {
  const sessions = new Map();

  ctx.on('session/event', (session, event) => {
    if (!session || !session.header || !event) return;
    if (session.header.origin === 'subagent' || session.header.parentSessionId) return;

    const sessionId = session.id || session.sessionId || 'root';
    const s = stateFor(sessions, sessionId);
    const data = dataOf(event);
    const sequence = event.seq !== undefined ? event.seq : data.seq;
    if (sequence !== undefined && sequence !== null) {
      const sequenceKey = String(sequence);
      if (s.seenSeq.has(sequenceKey)) return;
      s.seenSeq.add(sequenceKey);
    }

    const type = typeof event.type === 'string' ? event.type : '';
    const base = { protocol: PROTOCOL, sessionId: sessionId, ts: Date.now() };

    // request/header and request/context are the declared model route sources.
    // The route is stored on the session across turns and snapshotted per
    // response when it arrives or at the first chunk.
    if (type === 'request/header') {
      const model = routeModel(data.header, null);
      if (model) {
        if (s.model && s.model !== model && s.turn) {
          for (const item of s.turn.responses.values()) if (!item.completed && item.firstTokenAt !== null) item.invalidSample = true;
        }
        s.model = model;
      }
      s.pendingModel = model || s.pendingModel;
      return;
    }
    if (type === 'request/context') {
      const model = routeModel(null, data);
      if (model) {
        if (s.model && s.model !== model && s.turn) {
          for (const item of s.turn.responses.values()) if (!item.completed && item.firstTokenAt !== null) item.invalidSample = true;
        }
        s.model = model;
      }
      s.pendingModel = model || s.pendingModel;
      return;
    }

    const turnIdentity = identity(data.turn);
    if (type === 'turn/start') {
      s.turn = newTurn(turnIdentity, timeMs(event));
      emit(Object.assign({}, base, { event: 'turn/start' }));
      return;
    }
    if (!s.turn || (turnIdentity && s.turn.id && s.turn.id !== turnIdentity)) {
      s.turn = newTurn(turnIdentity, timeMs(event));
    }
    const turn = s.turn;
    const response = responseIdentity(data);
    const item = response ? responseFor(turn, response, sessionId) : null;

    if (type === 'turn/end') {
      // Real terminal event: data.reason.kind decides success. A cancelled or
      // interrupted turn is never defaulted to success. Only the session
      // route is retained after turn/end; the response buffers are dropped.
      const reason = data.reason && typeof data.reason === 'object' ? data.reason : {};
      const kind = typeof reason.kind === 'string' ? reason.kind : '';
      let status;
      if (kind === 'completed') status = 'complete';
      else status = 'failed';
      const samples = status === 'complete' ? finishSamples(turn) : [];
      const out = Object.assign({}, base, {
        event: 'turn/end',
        status: status,
        // Retained for additive accounting only; never used for TPS.
        duration: Math.max(0, (timeMs(event) === null ? Date.now() : timeMs(event)) - turn.startedAt),
        tps_sampling_contract: 'response_v1',
        tps_samples: samples
      });
      if (turn.usageObserved) {
        const usageOut = {};
        if (turn.inputComplete) usageOut.input_tokens = turn.inputTokens;
        if (turn.outputComplete) usageOut.output_tokens = turn.outputTokens;
        if (turn.cacheReadComplete) usageOut.cache_read_input_tokens = turn.cacheReadTokens;
        if (turn.cacheWriteComplete) usageOut.cache_creation_input_tokens = turn.cacheWriteTokens;
        out.usage = usageOut;
      }
      emit(out);
      s.turn = null;
      return;
    }

    if (item && type === 'assistant/chunk') {
      const first = firstTokenOf(data);
      if (first) {
        const at = timeMs(event);
        if (at !== null && (item.firstTokenAt === null || at < item.firstTokenAt)) item.firstTokenAt = at;
        applyPendingModel(s, item);
      }
    }

    if (type === 'assistant/chunk') {
      const first = firstTokenOf(data);
      if (first && first.kind !== 'reasoning' && first.text) {
        emit(Object.assign({}, base, { event: 'assistant/chunk', kind: 'text', text: first.text }));
      }
      // Reasoning deltas remain reasoning and are never surfaced as text.
      return;
    }
    if (type === 'assistant/message') {
      if (data.interrupted === true) return;
      if (item) {
        // Duplicate same-id final messages are ignored.
        if (item.messageSeen) {
          const duplicateUsage = tokenUsageOf(data);
          if (JSON.stringify(duplicateUsage) !== JSON.stringify(item.usage)) item.invalidSample = true;
          return;
        }
        item.messageSeen = true;
        item.completed = true;
        item.completedAt = timeMs(event);
        applyPendingModel(s, item);
      }
      rememberUsage(turn, item || { usageCounted: false }, tokenUsageOf(data));
      const text = assistantMessageText(data);
      if (text) emit(Object.assign({}, base, { event: 'assistant/message', text: text }));
      return;
    }
    if (type === 'tool/call') {
      emit(Object.assign({}, base, {
        event: 'tool/call',
        tool: data.name || data.tool || null,
        callId: data.callId || data.call_id || data.id || null,
        input: scrub(data.arguments || data.input || null)
      }));
      return;
    }
    if (type === 'tool/result') {
      emit(Object.assign({}, base, {
        event: 'tool/result',
        tool: data.name || data.tool || null,
        callId: (data.message && data.message.callId) || data.callId || data.id || null
      }));
    }
  });
}
`
