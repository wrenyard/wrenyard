import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ChildProcess, SpawnOptions } from 'node:child_process';
import crossSpawn from 'cross-spawn';

type ParsedWindowsCommand = {
  command: string;
  args: string[];
  options: { windowsVerbatimArguments?: boolean };
};

type CrossSpawnWithParser = typeof crossSpawn & {
  _parse(command: string, args: readonly string[], options: SpawnOptions): ParsedWindowsCommand;
};

type LaunchConfig = {
  commandLine: string;
  cwd?: string;
  env: Record<string, string>;
};

const POWERSHELL_LAUNCHER = String.raw`
$ErrorActionPreference = 'Stop'
$configPath = $args[0]
$stopPath = $args[1]
$resultPath = $args[2]
$confirmed = $false
$exitCode = 1
$safeError = $null
try {
  $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
  Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class OwnedExecution {
  const uint CREATE_SUSPENDED = 0x00000004;
  const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
  const uint CREATE_NO_WINDOW = 0x08000000;
  const uint STARTF_USESTDHANDLES = 0x00000100;
  const uint HANDLE_FLAG_INHERIT = 1;
  const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
  const int JobObjectBasicAccountingInformation = 1;
  const uint WAIT_OBJECT_0 = 0;
  const uint WAIT_TIMEOUT = 258;
  const uint INFINITE = 0xffffffff;

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct STARTUPINFO {
    public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
    public uint dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
    public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public uint dwProcessId, dwThreadId; }
  [StructLayout(LayoutKind.Sequential)]
  struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
    public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
    public uint LimitFlags; public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
    public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass, SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct IO_COUNTERS { public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount; }
  [StructLayout(LayoutKind.Sequential)]
  struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION {
    public long TotalUserTime, TotalKernelTime, ThisPeriodTotalUserTime, ThisPeriodTotalKernelTime;
    public uint TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses;
  }

  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref JOBOBJECT_BASIC_LIMIT_INFORMATION info, uint length);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int infoClass, out JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info, uint length, IntPtr returned);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool CreateProcessW(string app, StringBuilder command, IntPtr procAttrs, IntPtr threadAttrs, bool inherit, uint flags, IntPtr environment, string cwd, ref STARTUPINFO startup, out PROCESS_INFORMATION process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process, uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint ms);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr GetStdHandle(int id);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr source, IntPtr targetProcess, out IntPtr duplicate, uint access, bool inherit, uint options);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);

  static Exception WinError() { return new Win32Exception(Marshal.GetLastWin32Error()); }
  static void Need(bool ok) { if (!ok) throw WinError(); }
  static Dictionary<string,string> ReadEnv(Dictionary<string,string> source) {
    var result = new Dictionary<string,string>(StringComparer.OrdinalIgnoreCase);
    foreach (System.Collections.DictionaryEntry item in Environment.GetEnvironmentVariables()) result[(string)item.Key] = (string)item.Value;
    if (source != null) foreach (var item in source) { if (item.Value == null) result.Remove(item.Key); else result[item.Key] = item.Value; }
    return result;
  }
  static IntPtr MakeInheritableDuplicate(int stdId) {
    IntPtr source = GetStdHandle(stdId);
    if (source == IntPtr.Zero || source == new IntPtr(-1)) return IntPtr.Zero;
    IntPtr duplicate;
    Need(DuplicateHandle(GetCurrentProcess(), source, GetCurrentProcess(), out duplicate, 0, true, 2));
    return duplicate;
  }

  public static int Run(string commandLine, string cwd, Dictionary<string,string> env, string stopPath, string resultPath) {
    IntPtr job = IntPtr.Zero, input = IntPtr.Zero, output = IntPtr.Zero, error = IntPtr.Zero;
    PROCESS_INFORMATION process = new PROCESS_INFORMATION();
    bool assigned = false, resumed = false;
    int targetCode = 1;
    try {
      job = CreateJobObjectW(IntPtr.Zero, null); Need(job != IntPtr.Zero);
      var limits = new JOBOBJECT_BASIC_LIMIT_INFORMATION(); limits.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
      Need(SetInformationJobObject(job, 2, ref limits, (uint)Marshal.SizeOf(limits)));
      input = MakeInheritableDuplicate(-10); output = MakeInheritableDuplicate(-11); error = MakeInheritableDuplicate(-12);
      var startup = new STARTUPINFO(); startup.cb = Marshal.SizeOf(typeof(STARTUPINFO)); startup.dwFlags = STARTF_USESTDHANDLES;
      startup.hStdInput = input; startup.hStdOutput = output; startup.hStdError = error;
      var merged = ReadEnv(env); var entries = new List<string>();
      foreach (var key in merged.Keys) entries.Add(key + "=" + merged[key]);
      entries.Sort(StringComparer.OrdinalIgnoreCase);
      string block = String.Join("\0", entries.ToArray()) + "\0\0";
      IntPtr environment = Marshal.StringToHGlobalUni(block);
      try {
        var command = new StringBuilder(commandLine);
        Need(CreateProcessW(null, command, IntPtr.Zero, IntPtr.Zero, true,
          CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW, environment, cwd, ref startup, out process));
      } finally { Marshal.FreeHGlobal(environment); }
      Need(AssignProcessToJobObject(job, process.hProcess)); assigned = true;
      uint resumeResult = ResumeThread(process.hThread); if (resumeResult == 0xffffffff) throw WinError(); resumed = true;
      bool stopRequested = false;
      while (true) {
        if (File.Exists(stopPath)) { stopRequested = true; break; }
        uint wait = WaitForSingleObject(process.hProcess, 50);
        if (wait == WAIT_OBJECT_0) break;
        if (wait != WAIT_TIMEOUT) throw WinError();
      }
      if (stopRequested) { Need(TerminateJobObject(job, 1)); }
      else { uint code; Need(GetExitCodeProcess(process.hProcess, out code)); targetCode = unchecked((int)code); Need(TerminateJobObject(job, 1)); }
      var deadline = DateTime.UtcNow.AddSeconds(5);
      while (DateTime.UtcNow < deadline) {
        JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting;
        Need(QueryInformationJobObject(job, JobObjectBasicAccountingInformation, out accounting,
          (uint)Marshal.SizeOf(typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)), IntPtr.Zero));
        if (accounting.ActiveProcesses == 0) { WriteAck(resultPath, true, targetCode, null); return targetCode; }
        Thread.Sleep(50);
      }
      WriteAck(resultPath, false, targetCode, "termination confirmation timed out"); return 1;
    } catch (Exception ex) {
      int code = ex is Win32Exception ? ((Win32Exception)ex).NativeErrorCode : 0;
      try { WriteAck(resultPath, false, 1, code == 0 ? "launcher failure" : "Win32 error " + code.ToString(System.Globalization.CultureInfo.InvariantCulture)); } catch {}
      return 1;
    } finally {
      if (process.hProcess != IntPtr.Zero && !assigned) { TerminateProcess(process.hProcess, 1); WaitForSingleObject(process.hProcess, 5000); }
      if (job != IntPtr.Zero) CloseHandle(job);
      if (process.hThread != IntPtr.Zero) CloseHandle(process.hThread);
      if (process.hProcess != IntPtr.Zero) CloseHandle(process.hProcess);
      if (input != IntPtr.Zero) CloseHandle(input); if (output != IntPtr.Zero) CloseHandle(output); if (error != IntPtr.Zero) CloseHandle(error);
    }
  }
  static void WriteAck(string path, bool confirmed, int code, string error) {
    string json = "{\"confirmed\":" + (confirmed ? "true" : "false") + ",\"exitCode\":" + code.ToString(System.Globalization.CultureInfo.InvariantCulture) + (error == null ? "" : ",\"error\":\"" + error.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"") + "}";
    string temp = path + ".tmp"; File.WriteAllText(temp, json, new UTF8Encoding(false)); if (File.Exists(path)) File.Delete(path); File.Move(temp, path);
  }
}
'@
  $env = [System.Collections.Generic.Dictionary[string,string]]::new([System.StringComparer]::OrdinalIgnoreCase)
  foreach ($property in $config.env.PSObject.Properties) {
    if ($null -ne $property.Value) { $env[$property.Name] = [string]$property.Value }
  }
  $exitCode = [OwnedExecution]::Run($config.commandLine, $config.cwd, $env, $stopPath, $resultPath)
  exit $exitCode
} catch {
  $safeError = 'launcher failure'
  try { $ack = '{"confirmed":false,"exitCode":1,"error":"launcher failure"}'; $tmp = "$resultPath.tmp"; [IO.File]::WriteAllText($tmp, $ack); Move-Item -LiteralPath $tmp -Destination $resultPath -Force } catch {}
  exit 1
}
`;

function quoteWindowsArgument(value: string): string {
  if (value.length > 0 && !/[\s"]/u.test(value)) return value;
  let result = '"';
  let slashes = 0;
  for (const character of value) {
    if (character === '\\') { slashes += 1; continue; }
    if (character === '"') result += '\\'.repeat(slashes * 2 + 1) + '"';
    else result += '\\'.repeat(slashes) + character;
    slashes = 0;
  }
  return result + '\\'.repeat(slashes * 2) + '"';
}

function quoteWindowsCommand(value: string): string {
  return `"${value.replace(/"/gu, '\\"')}"`;
}

export async function prepareWindowsOwnedLaunch(
  command: string,
  args: readonly string[],
  options: SpawnOptions,
): Promise<{ child: ChildProcess; cleanup(): Promise<void> }> {
  const parsed = (crossSpawn as CrossSpawnWithParser)._parse(command, args, options);
  const targetArgs = parsed.options.windowsVerbatimArguments
    ? parsed.args.join(' ')
    : parsed.args.map(quoteWindowsArgument).join(' ');
  const commandLine = `${quoteWindowsCommand(parsed.command)}${targetArgs ? ` ${targetArgs}` : ''}`;
  const cwd: string | undefined = options.cwd === undefined
    ? undefined
    : typeof options.cwd === 'string'
      ? options.cwd
      : fileURLToPath(options.cwd);
  const directory = await mkdtemp(join(tmpdir(), 'wrenyard-owned-'));
  const configPath = join(directory, 'config.json');
  const launcherPath = join(directory, 'launcher.ps1');
  const stopPath = join(directory, 'stop.request');
  const resultPath = join(directory, 'result.json');
  let wrapper: ChildProcess | undefined;
  let wrapperClosed = false;
  let wrapperError: Error | undefined;
  let resolveClose!: () => void;
  const closed = new Promise<void>((resolve) => { resolveClose = resolve; });
  let cleanupPromise: Promise<void> | undefined;

  try {
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(options.env ?? {})) {
      if (value !== undefined) env[name] = value;
    }
    await writeFile(configPath, JSON.stringify({ commandLine, cwd, env } satisfies LaunchConfig), { mode: 0o600 });
    await writeFile(launcherPath, POWERSHELL_LAUNCHER, { mode: 0o600 });
    wrapper = crossSpawn('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', launcherPath,
      configPath, stopPath, resultPath,
    ], { stdio: options.stdio, windowsHide: true, shell: false, env: options.env });
    wrapper.once('error', (error) => { wrapperError = error; });
    wrapper.once('close', () => { wrapperClosed = true; resolveClose(); });
    const child = wrapper;
    return {
      child,
      cleanup(): Promise<void> {
        if (cleanupPromise) return cleanupPromise;
        cleanupPromise = (async () => {
          if (!wrapperClosed && child.pid !== undefined) await writeFile(stopPath, 'stop', { mode: 0o600 });
          if (!wrapperClosed) {
            let timeout: ReturnType<typeof setTimeout> | undefined;
            try {
              const timedOut = new Promise<never>((_, reject) => {
                timeout = setTimeout(() => reject(new Error('owned launcher close timed out')), 10_000);
              });
              await Promise.race([closed, timedOut]);
            } finally {
              if (timeout) clearTimeout(timeout);
            }
          }
          if (wrapperError) throw new Error('owned launcher failed');
          let ack: { confirmed?: boolean; exitCode?: number; error?: string };
          try { ack = JSON.parse(await readFile(resultPath, 'utf8')) as typeof ack; }
          catch { throw new Error('owned launcher did not provide termination confirmation'); }
          if (ack.confirmed !== true || typeof ack.exitCode !== 'number') throw new Error('owned launcher termination was not confirmed');
          await rm(directory, { recursive: true, force: true });
        })();
        return cleanupPromise;
      },
    };
  } catch {
    if (wrapper && !wrapperClosed) wrapper.kill();
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    throw new Error('owned launcher setup failed');
  }
}
