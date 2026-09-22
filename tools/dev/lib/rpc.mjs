import { createConnection } from 'node:net';
import { createFrameParser, encodeMessage } from './control.mjs';

const DAEMON_CONNECT_MS = 2_000;

/**
 * Minimal NDJSON JSON-RPC client for the business daemon IPC.
 * Intentionally independent from @wrenyard/control-client so tools/dev stays a root script.
 */
export function connectDaemonIpc(path, timeoutMs = DAEMON_CONNECT_MS) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    socket.setEncoding('utf8');
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`daemon IPC did not accept a connection within ${timeoutMs}ms`));
    }, timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      let nextId = 1;
      const pending = new Map();
      const parser = createFrameParser((message) => {
        if (message?.id == null) return;
        const waiter = pending.get(message.id);
        if (!waiter) return;
        pending.delete(message.id);
        if (message.error) {
          waiter.reject(Object.assign(new Error(message.error.message), { code: message.error.code, data: message.error.data }));
        } else {
          waiter.resolve(message.result);
        }
      });
      socket.on('data', (chunk) => parser.push(chunk));
      socket.on('close', () => {
        for (const waiter of pending.values()) waiter.reject(new Error('daemon IPC closed'));
        pending.clear();
      });
      resolve({
        request(method, params, requestTimeoutMs = 30_000) {
          const id = nextId;
          nextId += 1;
          return new Promise((resolveRequest, rejectRequest) => {
            const requestTimer = setTimeout(() => {
              pending.delete(id);
              rejectRequest(new Error(`daemon RPC timed out (${method})`));
            }, requestTimeoutMs);
            pending.set(id, {
              resolve: (result) => {
                clearTimeout(requestTimer);
                resolveRequest(result);
              },
              reject: (error) => {
                clearTimeout(requestTimer);
                rejectRequest(error);
              },
            });
            socket.write(encodeMessage({ jsonrpc: '2.0', id, method, params: params ?? {} }));
          });
        },
        close() {
          socket.end();
        },
      });
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

export async function withDaemon(path, fn, timeoutMs) {
  const client = await connectDaemonIpc(path, timeoutMs);
  try {
    return await fn(client);
  } finally {
    client.close();
  }
}

export function sourceIdentityFromHealth(health) {
  const identity = health && typeof health === 'object' ? health.identity : undefined;
  if (!identity || typeof identity !== 'object') return { mode: 'installed', verified: false };
  return {
    mode: identity.mode === 'source' ? 'source' : 'installed',
    checkout: typeof identity.checkout === 'string' ? identity.checkout : undefined,
    instanceId: typeof identity.instanceId === 'string' ? identity.instanceId : undefined,
    launchId: typeof identity.launchId === 'string' ? identity.launchId : undefined,
    node: typeof identity.node === 'string' ? identity.node : undefined,
    verified: true,
  };
}

export function identityMatchesSource(health, expected) {
  const identity = sourceIdentityFromHealth(health);
  if (!identity.verified) return false;
  if (identity.mode !== 'source') return false;
  if (expected.instanceId && identity.instanceId !== expected.instanceId) return false;
  if (expected.launchId && identity.launchId !== expected.launchId) return false;
  if (expected.checkout && identity.checkout && identity.checkout !== expected.checkout) {
    // Windows checkout compares are done by the caller with sameCheckout.
    return false;
  }
  return true;
}

/** Developer recovery hint when source-dev leaves or finds a frozen dispatcher. */
export const DISPATCH_THAW_HINT = [
  'Dispatch is frozen and will not accept new work.',
  'Keep it frozen if you did that. If leftover from pnpm dev, run: wrenyard daemon thaw',
].join('\n');

export function dispatchBlocksNewWork(health) {
  const dispatch = health && typeof health === 'object' ? health.dispatch : undefined;
  if (!dispatch || typeof dispatch !== 'object') {
    return { known: false, blocked: true, reason: 'cannot confirm dispatch admission' };
  }
  if (dispatch.recovery_required === true) {
    return { known: true, blocked: true, reason: 'daemon recovery is required' };
  }
  if (dispatch.mode === 'planned_restart') {
    return { known: true, blocked: true, reason: 'a planned restart is active' };
  }
  if (dispatch.mode === 'frozen' || dispatch.frozen === true || dispatch.accepting === false) {
    return { known: true, blocked: true, reason: 'dispatch is frozen' };
  }
  if (dispatch.mode !== 'accepting') {
    return { known: false, blocked: true, reason: `dispatch mode is ${dispatch.mode ?? 'unknown'}` };
  }
  return { known: true, blocked: false };
}
