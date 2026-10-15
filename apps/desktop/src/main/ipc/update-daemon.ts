// Update/daemon-adjacent IPC and the remaining shell settings utilities: the
// update snapshot/check/install surface, pet-settings and workspace saves, and
// the settings-file / logs-directory / reveal-workspace helpers. The daemon
// lifecycle channels (`daemonSnapshot`/`daemonStart`/`daemonRestart`) are
// registered directly in `main.ts`, not here. Handler semantics are unchanged
// from the original inline registrations.

import type { IpcMain } from 'electron';
import {
  SHELL_CHANNELS,
  type OperationComponentAction,
  type OperationComponentId,
  type PetCompanionSettings,
} from '../../shell-contract.js';
import type { ShellIpcDeps } from './deps.js';

/** The two machine-local operation components a renderer may address. */
const OPERATION_COMPONENT_IDS: readonly OperationComponentId[] = ['browser', 'desktop'];

/** The complete set of user-triggered component actions the daemon accepts. */
const OPERATION_COMPONENT_ACTIONS: readonly OperationComponentAction[] = [
  'refresh',
  'install',
  'update',
  'repair',
  'authorize',
  'uninstall',
  'enable',
  'disable',
];

function isOperationComponentId(value: unknown): value is OperationComponentId {
  return typeof value === 'string' && (OPERATION_COMPONENT_IDS as readonly string[]).includes(value);
}

function isOperationComponentAction(value: unknown): value is OperationComponentAction {
  return typeof value === 'string' && (OPERATION_COMPONENT_ACTIONS as readonly string[]).includes(value);
}

export function registerUpdateDaemonIpc(ipcMain: IpcMain, deps: ShellIpcDeps): () => void {
  const { options, assertShellSender } = deps;

  ipcMain.handle(SHELL_CHANNELS.updateSnapshot, async (event) => {
    assertShellSender(event.sender);
    return options.getUpdate();
  });
  ipcMain.handle(SHELL_CHANNELS.checkUpdate, async (event) => {
    assertShellSender(event.sender);
    return options.checkUpdate();
  });
  ipcMain.handle(SHELL_CHANNELS.requestInstall, async (event) => {
    assertShellSender(event.sender);
    return options.requestInstall();
  });
  ipcMain.handle(SHELL_CHANNELS.savePetSettings, async (event, settings: PetCompanionSettings) => {
    assertShellSender(event.sender);
    return options.savePetSettings(settings);
  });
  ipcMain.handle(SHELL_CHANNELS.saveWorkspace, async (event, path: unknown, create: unknown) => {
    assertShellSender(event.sender);
    if (typeof path !== 'string' || path.length > 4_096) throw new Error('Workspace 路径无效');
    if (create !== undefined && create !== null && typeof create !== 'boolean') throw new Error('Workspace 创建参数无效');
    return options.saveWorkspace(path, create === true);
  });
  ipcMain.handle(SHELL_CHANNELS.openSettingsFile, async (event) => {
    assertShellSender(event.sender);
    return options.openSettingsFile();
  });
  ipcMain.handle(SHELL_CHANNELS.openLogsDirectory, async (event) => {
    assertShellSender(event.sender);
    return options.openLogsDirectory();
  });
  ipcMain.handle(SHELL_CHANNELS.revealWorkspace, async (event, path: unknown) => {
    assertShellSender(event.sender);
    if (typeof path !== 'string' || path.length === 0 || path.length > 4_096) throw new Error('工作区路径无效');
    return options.revealWorkspace(path);
  });
  ipcMain.handle(SHELL_CHANNELS.operationComponents, async (event) => {
    assertShellSender(event.sender);
    return options.getOperationComponents();
  });
  ipcMain.handle(SHELL_CHANNELS.operationComponentAction, async (event, id: unknown, action: unknown) => {
    assertShellSender(event.sender);
    if (!isOperationComponentId(id) || !isOperationComponentAction(action)) {
      throw new Error('操作组件参数无效');
    }
    return options.runOperationComponentAction(id, action);
  });

  return () => {
    for (const channel of [
      SHELL_CHANNELS.updateSnapshot,
      SHELL_CHANNELS.checkUpdate,
      SHELL_CHANNELS.requestInstall,
      SHELL_CHANNELS.savePetSettings,
      SHELL_CHANNELS.saveWorkspace,
      SHELL_CHANNELS.openSettingsFile,
      SHELL_CHANNELS.openLogsDirectory,
      SHELL_CHANNELS.revealWorkspace,
      SHELL_CHANNELS.operationComponents,
      SHELL_CHANNELS.operationComponentAction,
    ]) ipcMain.removeHandler(channel);
  };
}
