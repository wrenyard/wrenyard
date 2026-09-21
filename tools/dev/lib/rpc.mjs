import { createConnection } from 'node:net';
import { CONTROL_CONNECT_MS } from './constants.mjs';
import { createFrameParser, encodeMessage } from './protocol.mjs';

/**
 * Minimal NDJSON JSON-RPC client for the business daemon IPC.
 * Intentionally independent from @wrenyard/control-client so tools/dev stays a root script.
 */
export function connectDaemonIpc(path, timeoutMs = CONTROL_CONNECT_MS) {
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
    runtimeBin: typeof identity.runtimeBin === 'string' ? identity.runtimeBin : undefined,
    verified: true,
  };
}

export function daemonBusy(health) {
  const dispatch = health && typeof health === 'object' ? health.dispatch : undefined;
  if (!dispatch || typeof dispatch !== 'object') return { known: false, busy: true };
  const tasks = Number(dispatch.activeTaskCount ?? dispatch.active_task_count ?? 0);
  const workflows = Number(dispatch.activeWorkflowCount ?? dispatch.active_workflow_count ?? 0);
  const executions = Number(dispatch.activeExecutionCount ?? dispatch.active_execution_count ?? 0);
  if (![tasks, workflows, executions].every(Number.isFinite)) return { known: false, busy: true };
  return {
    known: true,
    busy: tasks > 0 || workflows > 0 || executions > 0,
    tasks,
    workflows,
    executions,
    mode: dispatch.mode,
    frozen: dispatch.frozen === true,
  };
}
