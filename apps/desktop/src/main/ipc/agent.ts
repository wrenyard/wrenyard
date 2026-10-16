// Bot-agent IPC: one channel forwarding an allowlisted set of `agent.*` and
// `routine.*` daemon methods. Handler semantics mirror the other domain
// registrars: assert the shell sender first, validate the method against the
// allowlist, then delegate to the shell options. Desktop never wakes a bot or
// manages a routine itself; it only transports the call.

import type { IpcMain } from 'electron';
import { AGENT_METHODS, SHELL_CHANNELS } from '../../shell-contract.js';
import type { AgentMethod } from '../../shell-contract.js';
import type { ShellIpcDeps } from './deps.js';

/** Whether a renderer-supplied string is one of the allowed agent methods. */
function isAgentMethod(value: unknown): value is AgentMethod {
  return typeof value === 'string' && (AGENT_METHODS as readonly string[]).includes(value);
}

export function registerAgentIpc(ipcMain: IpcMain, deps: ShellIpcDeps): () => void {
  const { options, assertShellSender } = deps;

  ipcMain.handle(SHELL_CHANNELS.agentRequest, async (event, method: unknown, params: unknown) => {
    assertShellSender(event.sender);
    if (!isAgentMethod(method)) throw new Error(`不支持的机器人方法：${String(method)}`);
    return options.requestAgent(method, params);
  });

  return () => {
    ipcMain.removeHandler(SHELL_CHANNELS.agentRequest);
  };
}
