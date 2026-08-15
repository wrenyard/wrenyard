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
// session: assistant text/reasoning deltas, a final fallback assistant/message,
// parent tool calls/results (including nested subagent calls), and usage with
// duration and terminal status at turn/end. Usage is buffered until turn/end
// and secrets are scrubbed and never emitted.
const PluginSource = `export const name = 'forge-dsh-bridge';

const PROTOCOL = 'forge.dsh.stream.v1';
const SENSITIVE = /KEY|PASSWORD|SECRET|TOKEN/i;

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

function stateFor(sessions, id) {
  let s = sessions.get(id);
  if (!s) {
    s = { usage: null, startedAt: Date.now(), text: '', messageEmitted: false };
    sessions.set(id, s);
  }
  return s;
}

export function apply(ctx) {
  const sessions = new Map();

  ctx.on('session/event', (session, event) => {
    if (!session || !session.header) return;
    // Child (subagent) sessions inherit the parent provider/model and their
    // streams are intentionally ignored; subagent tool calls surface nested
    // inside parent tool/call events emitted below.
    if (session.header.origin === 'subagent') return;

    const sessionId = session.id || session.sessionId || 'root';
    const s = stateFor(sessions, sessionId);
    const base = { protocol: PROTOCOL, sessionId: sessionId, ts: Date.now() };

    switch (event.type) {
      case 'turn/start':
        emit(Object.assign({}, base, { event: 'turn/start' }));
        break;

      case 'assistant/chunk': {
        const text = event.delta || event.text || event.content || '';
        if (!text) break;
        s.text += text;
        emit(Object.assign({}, base, {
          event: 'assistant/chunk',
          kind: event.reasoning ? 'reasoning' : 'text',
          text: text
        }));
        break;
      }

      case 'assistant/message': {
        const text = event.message || event.text || event.content || '';
        if (!text) break;
        s.text += text;
        s.messageEmitted = true;
        // Usage is buffered here and only emitted once at turn/end.
        if (event.usage) s.usage = event.usage;
        emit(Object.assign({}, base, { event: 'assistant/message', text: text }));
        break;
      }

      case 'tool/call':
        emit(Object.assign({}, base, {
          event: 'tool/call',
          tool: event.tool || event.name || null,
          callId: event.callId || null,
          input: scrub(event.input || event.arguments || null)
        }));
        break;

      case 'tool/result':
        emit(Object.assign({}, base, {
          event: 'tool/result',
          tool: event.tool || event.name || null,
          callId: event.callId || null
        }));
        break;

      case 'turn/end': {
        // Final fallback: guarantee exactly one assistant/message line for the
        // turn even when it only streamed chunks.
        if (!s.messageEmitted && s.text) {
          emit(Object.assign({}, base, {
            event: 'assistant/message',
            text: s.text,
            fallback: true
          }));
        }
        const usage = event.usage || s.usage || null;
        const duration = typeof event.duration === 'number' ? event.duration : Date.now() - s.startedAt;
        emit(Object.assign({}, base, {
          event: 'turn/end',
          status: event.status || 'complete',
          usage: usage,
          duration: duration
        }));
        sessions.delete(sessionId);
        break;
      }
    }
  });
}
`
