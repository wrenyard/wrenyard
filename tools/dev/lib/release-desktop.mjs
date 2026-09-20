import { execFile } from 'node:child_process';
import { homedir as osHomedir, userInfo } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { DESKTOP_KILL_WAIT_MS } from './constants.mjs';
import { pathInside } from './paths.mjs';

export const WINDOWS_DESKTOP_DIR = 'Wrenyard Desktop';
export const WINDOWS_DESKTOP_EXE = 'wrenyard-desktop.exe';
export const MAC_APP_NAME = '啾啾工坊.app';

export const RELEASE_DESKTOP_RUNNING_MESSAGE = [
  '检测到安装版 Wrenyard Desktop 正在运行。',
  '请从托盘选择“退出”后重新执行 pnpm dev；关闭窗口可能不会退出应用。',
  '如需强制终止桌面端，可执行 pnpm dev --kill-desktop。',
].join('\n');

export const RELEASE_DESKTOP_KILL_WARNING = '将强制终止安装版 Desktop，可能中断对话并丢失未保存状态。';

const LIST_PROCESSES_PS = [
  '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false',
  "@(Get-CimInstance -ClassName Win32_Process -Property ProcessId,ParentProcessId,ExecutablePath,SessionId,Name | Select-Object ProcessId,ParentProcessId,ExecutablePath,SessionId,Name) | ConvertTo-Json -Compress -Depth 2",
].join('; ');

/**
 * Parse extra argv for `pnpm dev`. Unknown flags fail before the supervisor starts.
 * @param {string[]} argv
 */
export function parseDevArgs(argv) {
  let killDesktop = false;
  const unknown = [];
  for (const arg of argv) {
    if (arg === '--' || arg === '') continue;
    if (arg === '--kill-desktop') {
      killDesktop = true;
      continue;
    }
    unknown.push(arg);
  }
  return { killDesktop, unknown };
}

export function formatProcessLines(processes) {
  return processes.map((proc) => `  pid ${proc.pid}  ${proc.exe || proc.name || '(unknown)'}`).join('\n');
}

export function formatQueryFailed(error) {
  return `无法确认安装版 Wrenyard Desktop 是否在运行（${error}）。请从托盘选择“退出”后重试。`;
}

export function desktopRootFromBin(bin, platform = 'win32') {
  const trimmed = String(bin).replace(/[\\/]+$/u, '');
  if (platform === 'darwin' || /\.app(?:[\\/]|$)/iu.test(trimmed)) {
    const match = trimmed.match(/^(.*\.app)/iu);
    if (match) return match[1];
  }
  return dirname(trimmed);
}

/**
 * Default and override Desktop install roots. Never uses a hardcoded personal directory.
 * Checkout-owned paths (source Electron) are excluded.
 */
export function resolveInstalledDesktopRoots(options) {
  const platform = options.platform;
  const env = options.env ?? {};
  const home = options.home ?? osHomedir();
  const checkout = options.checkout;
  const pathOptions = { platform, exists: () => false };
  const roots = [];
  const add = (root) => {
    if (!root) return;
    if (checkout && pathInside(root, checkout, platform, pathOptions)) return;
    if (roots.some((existing) => pathInside(root, existing, platform, pathOptions) && pathInside(existing, root, platform, pathOptions))) {
      return;
    }
    roots.push(root);
  };

  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA?.trim() || join(home, 'AppData', 'Local');
    add(join(localAppData, 'Programs', WINDOWS_DESKTOP_DIR));
  } else if (platform === 'darwin') {
    add(join('/Applications', MAC_APP_NAME));
    add(join(home, 'Applications', MAC_APP_NAME));
  }

  const override = env.WRENYARD_DESKTOP_BIN?.trim();
  if (override) add(desktopRootFromBin(override, platform));
  return roots;
}

export function isDesktopProcessName(name, exe, platform) {
  const base = String(name || basename(exe || '')).toLowerCase();
  if (platform === 'win32') return base === WINDOWS_DESKTOP_EXE;
  if (platform === 'darwin') {
    return base === '啾啾工坊' || base.startsWith('啾啾工坊 helper');
  }
  return false;
}

export function isDesktopMainExecutable(exe, platform) {
  if (!exe) return false;
  const normalized = exe.replaceAll('\\', '/');
  if (platform === 'win32') return basename(exe).toLowerCase() === WINDOWS_DESKTOP_EXE;
  if (platform === 'darwin') return /\/Contents\/MacOS\//u.test(normalized);
  return false;
}

export function treeRoots(processes) {
  const pids = new Set(processes.map((proc) => proc.pid));
  return processes.filter((proc) => !pids.has(proc.ppid));
}

export function sameProcessIdentity(left, right, platform) {
  if (!left || !right) return false;
  if (left.pid !== right.pid) return false;
  if (!left.exe || !right.exe) return false;
  const pathOptions = { platform, exists: () => false };
  return pathInside(left.exe, right.exe, platform, pathOptions)
    && pathInside(right.exe, left.exe, platform, pathOptions);
}

/**
 * @param {Array<{ pid: number, ppid: number, exe: string, name?: string, sessionId?: number|null, user?: string }>} processes
 */
export function matchReleaseDesktopProcesses(processes, options) {
  const platform = options.platform;
  const roots = options.roots ?? [];
  const checkout = options.checkout;
  const pathOptions = { platform, exists: () => false };
  const matched = [];
  let unverified = null;

  for (const proc of processes) {
    if (options.sessionId != null && proc.sessionId != null && proc.sessionId !== options.sessionId) continue;
    if (options.user && proc.user && proc.user !== options.user) continue;

    const named = isDesktopProcessName(proc.name, proc.exe, platform);
    if (named && !proc.exe) {
      unverified = proc;
      continue;
    }
    if (!proc.exe) continue;
    if (checkout && pathInside(proc.exe, checkout, platform, pathOptions)) continue;
    const inRoot = roots.some((root) => pathInside(proc.exe, root, platform, pathOptions));
    if (!inRoot) continue;
    if (!isDesktopMainExecutable(proc.exe, platform)) continue;
    matched.push(proc);
  }

  if (unverified) {
    return {
      ok: false,
      error: `process ${unverified.pid} (${unverified.name || 'wrenyard-desktop'}) has no executable path`,
    };
  }
  return { ok: true, processes: matched };
}

export function decodeProcessQueryOutput(buffer) {
  if (buffer == null) return '';
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(String(buffer));
  if (bytes.length === 0) return '';
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.toString('utf16le');
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    const copy = Buffer.from(bytes);
    copy.swap16();
    return copy.toString('utf16le');
  }
  if (bytes.length >= 4 && bytes[1] === 0 && bytes[3] === 0 && bytes[0] !== 0) {
    return bytes.toString('utf16le');
  }
  return bytes.toString('utf8');
}

export function parseCimProcessJson(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return [];
  const parsed = JSON.parse(trimmed);
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows.map((row) => ({
    pid: Number(row.ProcessId),
    ppid: Number(row.ParentProcessId),
    exe: row.ExecutablePath ? String(row.ExecutablePath) : '',
    sessionId: row.SessionId == null || row.SessionId === '' ? null : Number(row.SessionId),
    name: row.Name ? String(row.Name) : '',
  })).filter((row) => Number.isInteger(row.pid) && row.pid > 0);
}

export function parsePsProcesses(text) {
  const processes = [];
  for (const line of String(text ?? '').split(/\r?\n/u)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/u.exec(line);
    if (!match) continue;
    const command = match[4].trim();
    const exe = executableFromCommand(command);
    processes.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      user: match[3],
      exe,
      name: basename(exe),
      sessionId: null,
    });
  }
  return processes;
}

function executableFromCommand(command) {
  if (command.startsWith('"')) {
    const end = command.indexOf('"', 1);
    return end > 0 ? command.slice(1, end) : command;
  }
  return command.split(/\s/u)[0] || command;
}

export function runExecFile(command, args, options = {}) {
  return new Promise((resolve) => {
    execFile(command, args, {
      windowsHide: true,
      timeout: options.timeoutMs ?? 15_000,
      maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024,
      encoding: 'buffer',
      env: options.env,
    }, (error, stdout, stderr) => {
      const out = stdout ?? Buffer.alloc(0);
      const err = stderr ?? Buffer.alloc(0);
      if (error && error.code === 'ENOENT') {
        resolve({
          status: 127,
          stdout: out,
          stderr: err,
          error: 'not-found',
        });
        return;
      }
      const status = error
        ? (typeof error.status === 'number' ? error.status : (typeof error.code === 'number' ? error.code : 1))
        : 0;
      resolve({ status, stdout: out, stderr: err });
    });
  });
}

export function taskkillAlreadyGone(result) {
  const text = `${decodeProcessQueryOutput(result.stdout)}\n${decodeProcessQueryOutput(result.stderr)}`;
  return result.status === 128 || /not found/i.test(text);
}

function failGate(message) {
  return { action: 'fail', message };
}

/**
 * Start-time gate: refuse by default, optionally terminate a verified install Desktop tree.
 * Must run before daemon freeze/drain. Does not touch independent daemons.
 */
export async function gateReleaseDesktop(input) {
  const inspect = input.inspect;
  const stdout = input.stdout ?? (() => {});
  const timeoutMs = input.timeoutMs ?? DESKTOP_KILL_WAIT_MS;
  const sleep = input.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = input.now ?? Date.now;

  const first = await inspect();
  if (!first.ok) return failGate(formatQueryFailed(first.error));
  if (first.processes.length === 0) return { action: 'continue', processes: [] };

  const listed = formatProcessLines(first.processes);
  if (!input.killDesktop) {
    return failGate(`${RELEASE_DESKTOP_RUNNING_MESSAGE}\n${listed}`);
  }

  stdout(`${RELEASE_DESKTOP_KILL_WARNING}\n${listed}`);

  const verified = await inspect();
  if (!verified.ok) return failGate(formatQueryFailed(verified.error));
  if (verified.processes.length === 0) return { action: 'continue', processes: [], killed: false };

  const terminated = await input.terminate(verified.processes);
  if (!terminated?.ok) return failGate(terminated?.message || '终止安装版 Desktop 失败。');

  const deadline = now() + timeoutMs;
  const maxPasses = Math.max(2, Math.ceil(timeoutMs / 200) + 2);
  for (let pass = 0; pass < maxPasses; pass += 1) {
    const current = await inspect();
    if (!current.ok) return failGate(formatQueryFailed(current.error));
    if (current.processes.length === 0) return { action: 'continue', killed: true, processes: [] };
    if (now() >= deadline) {
      return failGate(`安装版 Desktop 未能在 ${Math.round(timeoutMs / 1000)} 秒内退出。请从托盘选择“退出”后重试。\n${formatProcessLines(current.processes)}`);
    }
    const remaining = deadline - now();
    if (remaining <= 0) {
      return failGate(`安装版 Desktop 未能在 ${Math.round(timeoutMs / 1000)} 秒内退出。请从托盘选择“退出”后重试。\n${formatProcessLines(current.processes)}`);
    }
    await sleep(Math.min(200, remaining));
  }

  const leftover = await inspect();
  if (!leftover.ok) return failGate(formatQueryFailed(leftover.error));
  if (leftover.processes.length === 0) return { action: 'continue', killed: true, processes: [] };
  return failGate(`安装版 Desktop 未能在 ${Math.round(timeoutMs / 1000)} 秒内退出。请从托盘选择“退出”后重试。\n${formatProcessLines(leftover.processes)}`);
}

export async function listPlatformProcesses(options) {
  const platform = options.platform;
  const run = options.run ?? runExecFile;
  const env = options.env ?? process.env;
  if (platform === 'win32') return listWindowsProcesses(run, env);
  if (platform === 'darwin') return listDarwinProcesses(run, env);
  return { ok: true, processes: [] };
}

export function createInspectReleaseDesktop(options) {
  const platform = options.platform;
  const run = options.run ?? runExecFile;
  const env = options.env ?? process.env;
  const home = options.home ?? osHomedir();
  const checkout = options.checkout;
  const currentPid = options.currentPid ?? process.pid;

  return async function inspectReleaseDesktop() {
    const listed = await listPlatformProcesses({ platform, run, env });
    if (!listed.ok) return listed;

    const roots = resolveInstalledDesktopRoots({ platform, env, home, checkout });
    const self = listed.processes.find((proc) => proc.pid === currentPid);
    const currentUser = platform === 'darwin'
      ? (options.user ?? safeUsername())
      : undefined;
    return matchReleaseDesktopProcesses(listed.processes, {
      platform,
      roots,
      checkout,
      sessionId: self?.sessionId ?? null,
      user: currentUser,
    });
  };
}

export function createTerminateReleaseDesktop(options) {
  const platform = options.platform;
  const run = options.run ?? runExecFile;
  const env = options.env ?? process.env;

  return async function terminateReleaseDesktop(processes) {
    const listed = await listPlatformProcesses({ platform, run, env });
    if (!listed.ok) return { ok: false, message: formatQueryFailed(listed.error) };

    const liveByPid = new Map(listed.processes.map((proc) => [proc.pid, proc]));
    const stillLive = [];
    for (const proc of processes) {
      const live = liveByPid.get(proc.pid);
      if (!live) continue;
      if (!sameProcessIdentity(live, proc, platform)) {
        return { ok: false, message: `无法确认进程身份（pid ${proc.pid}），已停止。请从托盘选择“退出”后重试。` };
      }
      stillLive.push(live);
    }

    const roots = treeRoots(stillLive);
    for (const proc of roots) {
      const killed = platform === 'win32'
        ? await killWindowsTree(run, proc.pid)
        : await killPosixTree(run, proc, stillLive);
      if (!killed.ok) return killed;
    }
    return { ok: true };
  };
}

function safeUsername() {
  try {
    return userInfo().username;
  } catch {
    return process.env.USER || process.env.LOGNAME || undefined;
  }
}

async function listWindowsProcesses(run, env) {
  const result = await run('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    LIST_PROCESSES_PS,
  ], { env, timeoutMs: 15_000 });
  if (result.status === 127 || result.error === 'not-found') {
    return { ok: false, error: 'powershell.exe is not available' };
  }
  if (result.status !== 0) {
    const detail = decodeProcessQueryOutput(result.stderr).trim() || `exit ${result.status}`;
    return { ok: false, error: detail };
  }
  try {
    return { ok: true, processes: parseCimProcessJson(decodeProcessQueryOutput(result.stdout)) };
  } catch (error) {
    return { ok: false, error: `process query returned invalid data (${error instanceof Error ? error.message : String(error)})` };
  }
}

async function listDarwinProcesses(run, env) {
  const result = await run('ps', ['-axo', 'pid=', '-o', 'ppid=', '-o', 'user=', '-o', 'command='], {
    env,
    timeoutMs: 10_000,
  });
  if (result.status === 127 || result.error === 'not-found') {
    return { ok: false, error: 'ps is not available' };
  }
  if (result.status !== 0) {
    const detail = decodeProcessQueryOutput(result.stderr).trim() || `exit ${result.status}`;
    return { ok: false, error: detail };
  }
  return { ok: true, processes: parsePsProcesses(decodeProcessQueryOutput(result.stdout)) };
}

async function killWindowsTree(run, pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return { ok: false, message: `无法确认进程身份（pid ${pid}），已停止。请从托盘选择“退出”后重试。` };
  }
  const result = await run('taskkill.exe', ['/PID', String(pid), '/T', '/F']);
  if (result.status === 0 || taskkillAlreadyGone(result)) return { ok: true };
  const detail = decodeProcessQueryOutput(result.stderr).trim() || decodeProcessQueryOutput(result.stdout).trim() || `exit ${result.status}`;
  return { ok: false, message: `终止 Desktop 失败（pid ${pid}）：${detail}` };
}

async function killPosixTree(run, root, processes) {
  const pids = [root.pid, ...descendants(root.pid, processes).map((proc) => proc.pid)];
  for (const pid of [...pids].reverse()) {
    if (!Number.isInteger(pid) || pid <= 0) {
      return { ok: false, message: `无法确认进程身份（pid ${pid}），已停止。请从托盘选择“退出”后重试。` };
    }
    const result = await run('kill', ['-KILL', String(pid)]);
    if (result.status !== 0 && !/no such process/i.test(decodeProcessQueryOutput(result.stderr))) {
      const detail = decodeProcessQueryOutput(result.stderr).trim() || `exit ${result.status}`;
      return { ok: false, message: `终止 Desktop 失败（pid ${pid}）：${detail}` };
    }
  }
  return { ok: true };
}

function descendants(rootPid, processes) {
  const children = new Map();
  for (const proc of processes) {
    const list = children.get(proc.ppid) ?? [];
    list.push(proc);
    children.set(proc.ppid, list);
  }
  const out = [];
  const stack = [...(children.get(rootPid) ?? [])];
  while (stack.length > 0) {
    const current = stack.pop();
    out.push(current);
    stack.push(...(children.get(current.pid) ?? []));
  }
  return out;
}
