// Task, stats and settings-projection IPC: the stats snapshot, task
// detail/graph windows, task-settings snapshot/save, runtime aliases, routing
// tests and the shared activity projection.
// Handler semantics are unchanged from the original inline registrations.

import type { IpcMain } from 'electron';
import { SHELL_CHANNELS } from '../../shell-contract.js';
import type { ShellIpcDeps } from './deps.js';
import {
  TASK_SETTINGS_CONTROL_CHARS,
  boundedOptionalProject,
  validateRuntimeAliasPutRequest,
  validateRuntimeAliasRemoveRequest,
  validateTaskRoutingTestParams,
  validateTaskSettingsSaveRequest,
} from './validation.js';

export function registerTasksStatsIpc(ipcMain: IpcMain, deps: ShellIpcDeps): () => void {
  const { options, assertShellSender } = deps;

  ipcMain.handle(SHELL_CHANNELS.statsSnapshot, async (event) => {
    assertShellSender(event.sender);
    return options.getStats();
  });
  ipcMain.handle(SHELL_CHANNELS.taskTranscript, async (event, taskRunId: unknown) => {
    assertShellSender(event.sender);
    if (typeof taskRunId !== 'string' || !/^task_[a-zA-Z0-9_-]{1,128}$/.test(taskRunId)) {
      throw new Error('任务运行 id 无效');
    }
    return options.openTaskTranscript(taskRunId);
  });
  ipcMain.handle(SHELL_CHANNELS.taskGraph, async (event, taskGraphId: unknown) => {
    assertShellSender(event.sender);
    if (typeof taskGraphId !== 'string' || taskGraphId.length === 0 || taskGraphId.length > 256) {
      throw new Error('任务图 id 无效');
    }
    return options.openTaskGraph(taskGraphId);
  });
  ipcMain.handle(SHELL_CHANNELS.taskSettingsSnapshot, async (event, project: unknown, taskId: unknown) => {
    assertShellSender(event.sender);
    const boundedProject = boundedOptionalProject(project);
    if (taskId !== undefined && taskId !== null) {
      if (typeof taskId !== 'string' || !taskId || taskId.length > 512) throw new Error('任务 id 无效');
    }
    return options.getTaskSettings(
      boundedProject,
      taskId === undefined || taskId === null ? undefined : taskId,
    );
  });
  ipcMain.handle(SHELL_CHANNELS.taskSettingsSave, async (event, request: unknown) => {
    assertShellSender(event.sender);
    return options.saveTaskSettings(validateTaskSettingsSaveRequest(request));
  });
  ipcMain.handle(SHELL_CHANNELS.runtimeAliasSnapshot, async (event) => {
    assertShellSender(event.sender);
    return options.runtimeAliasSnapshot();
  });
  ipcMain.handle(SHELL_CHANNELS.runtimeAliasPut, async (event, request: unknown) => {
    assertShellSender(event.sender);
    return options.runtimeAliasPut(validateRuntimeAliasPutRequest(request));
  });
  ipcMain.handle(SHELL_CHANNELS.runtimeAliasRemove, async (event, request: unknown) => {
    assertShellSender(event.sender);
    return options.runtimeAliasRemove(validateRuntimeAliasRemoveRequest(request));
  });
  ipcMain.handle(SHELL_CHANNELS.taskRoutingTest, async (event, params: unknown) => {
    assertShellSender(event.sender);
    return options.requestTaskRoutingTest(validateTaskRoutingTestParams(params));
  });
  ipcMain.handle(SHELL_CHANNELS.taskRoutingTestTasks, async (event) => {
    assertShellSender(event.sender);
    return options.requestRoutingTestTasks();
  });
  ipcMain.handle(SHELL_CHANNELS.activityStatusSnapshot, async (event) => {
    assertShellSender(event.sender);
    return options.getActivityStatus();
  });

  return () => {
    for (const channel of [
      SHELL_CHANNELS.statsSnapshot,
      SHELL_CHANNELS.taskTranscript,
      SHELL_CHANNELS.taskGraph,
      SHELL_CHANNELS.taskSettingsSnapshot,
      SHELL_CHANNELS.taskSettingsSave,
      SHELL_CHANNELS.runtimeAliasSnapshot,
      SHELL_CHANNELS.runtimeAliasPut,
      SHELL_CHANNELS.runtimeAliasRemove,
      SHELL_CHANNELS.taskRoutingTest,
      SHELL_CHANNELS.taskRoutingTestTasks,
      SHELL_CHANNELS.activityStatusSnapshot,
    ]) ipcMain.removeHandler(channel);
  };
}
