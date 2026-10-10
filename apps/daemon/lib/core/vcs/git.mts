/**
 * The daemon's only git runner.
 *
 * Every caller shells out to the `git` binary through `execFile` (no shell, no
 * interpolation) and inspects the returned code and stderr instead of catching
 * a thrown error. A non-zero exit is never thrown.
 */

import { execFile, spawnSync, type ExecFileException } from 'node:child_process'

/** Captured result of one `git` invocation. */
export interface GitRunResult {
  stdout: string
  stderr: string
  code: number
}

/**
 * Run `git` with an explicit `cwd` and argument vector. Resolves with the
 * process exit code and captured streams; `code` is `0` on success and the
 * process exit code otherwise.
 */
export async function runGit(
  cwd: string,
  args: readonly string[],
  opts?: { maxBuffer?: number; gitBin?: string },
): Promise<GitRunResult> {
  return new Promise((resolve) => {
    execFile(
      opts?.gitBin ?? 'git',
      args,
      {
        cwd,
        encoding: 'utf8',
        maxBuffer: opts?.maxBuffer ?? 64 * 1024 * 1024,
        windowsHide: true,
      },
      (error: ExecFileException | null, stdout: string, stderr: string) => {
        let code = 0
        if (error) {
          const rawCode = (error as { code?: unknown }).code
          code = typeof rawCode === 'number' ? rawCode : 1
        }
        resolve({ stdout: stdout ?? '', stderr: stderr ?? '', code })
      },
    )
  })
}

/**
 * Synchronous counterpart of `runGit`: run `git` with an explicit `cwd` and
 * argument vector (no shell) and return the exit code and captured streams.
 * Never throws on a non-zero exit; `code` is `0` on success and the process
 * exit code otherwise.
 */
export function runGitSync(
  cwd: string,
  args: readonly string[],
  opts?: { maxBuffer?: number; gitBin?: string },
): GitRunResult {
  const result = spawnSync(opts?.gitBin ?? 'git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: opts?.maxBuffer ?? 64 * 1024 * 1024,
    windowsHide: true,
  })
  const rawCode = result.status
  const code = typeof rawCode === 'number' ? rawCode : 1
  return {
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
    stderr: typeof result.stderr === 'string' ? result.stderr : '',
    code,
  }
}
