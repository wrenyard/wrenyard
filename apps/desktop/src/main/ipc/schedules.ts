// Scheduled-task IPC: the schedule list plus pause/resume, run-now and delete.
// Handler semantics mirror the other domain registrars: assert the shell sender
// first, validate the bounded arguments, then delegate to the shell options.

import type { IpcMain } from 'electron';
import { SHELL_CHANNELS } from '../../shell-contract.js';
import type { ShellIpcDeps } from './deps.js';

/** A schedule id is exactly 8 lowercase hex characters. */
const SCHEDULE_ID = /^[0-9a-f]{8}$/;

export function registerSchedulesIpc(ipcMain: IpcMain, deps: ShellIpcDeps): () => void {
  const { options, assertShellSender } = deps;

  ipcMain.handle(SHELL_CHANNELS.scheduleList, async (event) => {
    assertShellSender(event.sender);
    return options.listSchedules();
  });
  ipcMain.handle(SHELL_CHANNELS.scheduleUpdate, async (event, id: unknown, state: unknown) => {
    assertShellSender(event.sender);
    if (typeof id !== 'string' || !SCHEDULE_ID.test(id)) throw new Error('定时任务 id 无效');
    if (state !== 'active' && state !== 'paused') throw new Error('定时任务状态无效');
    return options.updateSchedule(id, state);
  });
  ipcMain.handle(SHELL_CHANNELS.scheduleRun, async (event, id: unknown) => {
    assertShellSender(event.sender);
    if (typeof id !== 'string' || !SCHEDULE_ID.test(id)) throw new Error('定时任务 id 无效');
    return options.runSchedule(id);
  });
  ipcMain.handle(SHELL_CHANNELS.scheduleDelete, async (event, id: unknown) => {
    assertShellSender(event.sender);
    if (typeof id !== 'string' || !SCHEDULE_ID.test(id)) throw new Error('定时任务 id 无效');
    return options.deleteSchedule(id);
  });

  return () => {
    for (const channel of [
      SHELL_CHANNELS.scheduleList,
      SHELL_CHANNELS.scheduleUpdate,
      SHELL_CHANNELS.scheduleRun,
      SHELL_CHANNELS.scheduleDelete,
    ]) ipcMain.removeHandler(channel);
  };
}
