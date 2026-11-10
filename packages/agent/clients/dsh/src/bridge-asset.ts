/**
 * Loader row id and file name the generated overlay uses to mount the
 * transcript bridge, matching the retired Go adapter's `BridgeRowID` and
 * `PluginFilename`.
 */
export const DSH_BRIDGE_ROW_ID = 'wrenyard-dsh-bridge';
export const DSH_BRIDGE_PLUGIN_FILENAME = 'wrenyard-dsh-bridge.mjs';

/**
 * The transcript bridge plugin source, copied from the retired Go adapter's
 * embedded `PluginSource` string (dsh/bridge.go). It keeps the JSONL protocol
 * name, the subagent filter, the model route evidence sources, the usage
 * partitions, and the generation sampling window.
 *
 * The bridge exports name/apply(ctx), subscribes to session/event, ignores
 * child (subagent) session streams, and emits one-line wrenyard.dsh.stream.v1
 * JSON for the root session. It understands both upstream event shapes: the
 * legacy 0.1.x live assistant/chunk deltas, and the 0.2.0 compact stream
 * records carried on assistant/message data.stream (expanded locally with
 * their original millisecond timestamps). Real first tokens, the final answer
 * from assistant/message type=text content blocks, parent tool calls/results,
 * transient per-response generation blocks forwarded at turn/end, and usage
 * partitions summed once per response at turn/end are all retained. A 0.2.0
 * assistant/attempt is a settled unsuccessful attempt: it emits no text,
 * records no usage and produces no generation sample. Secrets are scrubbed and
 * never emitted; hidden reasoning is never forwarded as visible text.
 *
 * This is a raw JavaScript asset written to disk for the native DSH loader, not
 * Wrenyard TypeScript. It is embedded with String.raw so the literal is stored
 * byte-for-byte and never interpreted as a template with interpolation.
 */
export const DSH_BRIDGE_PLUGIN_SOURCE = String.raw`export const name = 'wrenyard-dsh-bridge';

const PROTOCOL = 'wrenyard.dsh.stream.v1';
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
      messageSeen: false,
      chunkStreamSeen: false,
      gen: new Map(),
      genFirstAt: null,
      genLastAt: null,
      genInvalid: false
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

// finiteNumber accepts only a finite numeric timestamp or gap; anything else is
// treated as absent so no timestamp is ever fabricated.
function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

// memberChunks expands one packed stream record's members into legacy-shape
// deltas carrying their own reconstructed timestamp. Member k's time is time0
// plus the sum of the preceding gap entries; if time0 is absent or a gap is
// missing/non-numeric the later members are dropped rather than guessed.
function memberChunks(record, values, build) {
  const out = [];
  if (!Array.isArray(values)) return out;
  const time0 = finiteNumber(record.time0);
  if (time0 === null) return out;
  const dt = Array.isArray(record.dt) ? record.dt : [];
  let at = time0;
  for (let k = 0; k < values.length; k += 1) {
    if (at === null) break;
    out.push({ at: at, chunk: build(values[k]) });
    const gap = k < dt.length ? finiteNumber(dt[k]) : null;
    at = gap === null ? null : at + gap;
  }
  return out;
}

// streamChunks expands the compact 0.2.0 stream records into the legacy
// StreamChunk delta shapes the first-token and generation helpers already
// understand, preserving each member's original millisecond timestamp. Unknown
// or malformed records are skipped.
function streamChunks(stream) {
  const out = [];
  if (!Array.isArray(stream)) return out;
  for (const record of stream) {
    if (!record || typeof record !== 'object') continue;
    const type = typeof record.type === 'string' ? record.type : '';
    if (type === 'chunk') {
      const at = finiteNumber(record.time);
      if (at !== null && record.chunk && typeof record.chunk === 'object') out.push({ at: at, chunk: record.chunk });
      continue;
    }
    if (type === 'text-chunks') {
      const index = record.index;
      out.push.apply(out, memberChunks(record, record.texts, (value) => ({ type: 'text-delta', index: index, text: value })));
      continue;
    }
    if (type === 'reasoning-chunks') {
      const index = record.index;
      out.push.apply(out, memberChunks(record, record.texts, (value) => ({ type: 'reasoning-delta', index: index, text: value })));
      continue;
    }
    if (type === 'tool-call-chunks') {
      const index = record.index;
      const id = record.id;
      const name = record.name;
      out.push.apply(out, memberChunks(record, record.args, (value) => ({ type: 'tool-call-delta', index: index, id: id, name: name, argumentsDelta: value })));
      continue;
    }
  }
  return out;
}

// applyStream feeds reconstructed stream deltas through the same first-token
// and generation bookkeeping as the legacy assistant/chunk path, emitting text
// deltas as assistant/chunk records. Reasoning deltas feed accounting only and
// are never surfaced as visible text.
function applyStream(s, item, base, stream) {
  const deltas = streamChunks(stream);
  for (const delta of deltas) {
    const data = { chunk: delta.chunk };
    const first = firstTokenOf(data);
    if (first && item) {
      if (delta.at !== null && (item.firstTokenAt === null || delta.at < item.firstTokenAt)) item.firstTokenAt = delta.at;
      applyPendingModel(s, item);
      observeGeneration(item, generationDeltaOf(data), delta.at);
    }
    if (first && first.kind !== 'reasoning' && first.text) {
      emit(Object.assign({}, base, { event: 'assistant/chunk', kind: 'text', text: first.text }));
    }
  }
}

// blockKeyOf names one content channel so deltas concatenate per block and
// the later token count never depends on how the stream is split.
function blockKeyOf(chunk, fallback) {
  if (chunk.id !== undefined) return fallback + ':id:' + identity(chunk.id);
  if (chunk.callId !== undefined) return fallback + ':call:' + identity(chunk.callId);
  if (chunk.index !== undefined) return fallback + ':index:' + identity(chunk.index);
  return fallback;
}

// generationDeltaOf extracts one chunk's actually generated content for the
// approximate tokenizer speed: text-delta text and tool-call argument
// fragments and observed reasoning, keyed per content block. These transient
// strings are converted to counts by the adapter; reasoning is never UI text.
function generationDeltaOf(data) {
  const chunk = data && data.chunk;
  if (!chunk || typeof chunk !== 'object') return null;
  const type = typeof chunk.type === 'string' ? chunk.type : '';
  if (type === 'text-delta' || type === 'reasoning-delta') {
    if (typeof chunk.text === 'string' && chunk.text !== '') {
      return { key: blockKeyOf(chunk, type === 'reasoning-delta' ? 'reasoning' : 'text'), text: chunk.text };
    }
    return null;
  }
  if (type === 'tool-call-delta') {
    if (typeof chunk.argumentsDelta === 'string' && chunk.argumentsDelta !== '') {
      return { key: blockKeyOf(chunk, 'tool'), text: chunk.argumentsDelta };
    }
    return null;
  }
  return null;
}

// observeGeneration accumulates countable generation content per response.
// Deltas concatenate per block, and the window runs from the first to the
// last nonempty delta, so completion latency and tool waits never stretch it.
// Out-of-order timestamps invalidate only this response's window.
function observeGeneration(item, delta, at) {
  if (!delta || at === null) return;
  if (item.genLastAt !== null && at < item.genLastAt) {
    item.genInvalid = true;
    return;
  }
  if (item.genFirstAt === null) item.genFirstAt = at;
  item.gen.set(delta.key, (item.gen.get(delta.key) || '') + delta.text);
  item.genLastAt = at;
}

// finishGenerations forwards each successful response's accumulated
// generation blocks with its first-to-last delta window so the Go adapter
// can count tokens. The strings are transient: only the adapter's canonical
// samples are persisted. Responses that never completed, lost their model,
// were invalidated, or produced no two-timestamp window are skipped without
// poisoning the rest.
function finishGenerations(turn) {
  const generations = [];
  for (const item of turn.responses.values()) {
    if (!item.completed || item.invalidSample) continue;
    if (!item.model || item.genInvalid) continue;
    if (item.genFirstAt === null || item.genLastAt === null || item.genLastAt <= item.genFirstAt) continue;
    if (item.gen.size === 0) continue;
    const blocks = {};
    for (const entry of item.gen) blocks[entry[0]] = entry[1];
    generations.push({
      response_id: item.responseId,
      model: item.model,
      blocks: blocks,
      first_delta_at_ms: item.genFirstAt,
      last_delta_at_ms: item.genLastAt
    });
  }
  return generations;
}

export function apply(ctx) {
  const sessions = new Map();

  ctx.on('session/event', (session, event) => {
    if (!session || !session.header || !event) return;
    if (session.header.origin === 'subagent' || session.header.parentSessionId || session.header.parentSession) return;

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
      const generations = status === 'complete' ? finishGenerations(turn) : [];
      const out = Object.assign({}, base, {
        event: 'turn/end',
        status: status,
        // Retained for additive accounting only; never used for TPS.
        duration: Math.max(0, (timeMs(event) === null ? Date.now() : timeMs(event)) - turn.startedAt),
        // Transient generation blocks; the Go adapter counts them into
        // speed samples and never persists the raw strings.
        tps_generation: generations
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
      const chunk = data.chunk;
      if (chunk && chunk.type === 'finish' && chunk.reason && ['error', 'aborted'].includes(chunk.reason.kind)) item.invalidSample = true;
      const first = firstTokenOf(data);
      if (first) {
        const at = timeMs(event);
        if (at !== null && (item.firstTokenAt === null || at < item.firstTokenAt)) item.firstTokenAt = at;
        applyPendingModel(s, item);
        observeGeneration(item, generationDeltaOf(data), at);
        // Mark the response so a 0.2.0 assistant/message stream is not also
        // accumulated for the same deltas.
        item.chunkStreamSeen = true;
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
    if (type === 'assistant/attempt') {
      // A settled unsuccessful attempt: it emits no final text, records no
      // usage and yields no generation sample. Its stream is deliberately not
      // accumulated so it cannot contaminate a later successful
      // assistant/message for the same turn/step.
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
        // 0.2.0 carries the response stream here instead of live
        // assistant/chunk events. Reconstruct it only when the same response
        // was not already accumulated from legacy deltas, so a delta is never
        // counted twice.
        if (!item.chunkStreamSeen) applyStream(s, item, base, data.stream);
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
`;
