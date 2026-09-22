import type { ShellOpts, ShellResult } from '../../types.mts'
import { spawnShellProcess } from './process.mts'

export async function executeShell(command: string, opts: ShellOpts = {}): Promise<ShellResult> {
  return new Promise<ShellResult>((resolve) => {
    const child = spawnShellProcess(command, [], {
      cwd: opts.cwd ?? process.cwd(),
      env: opts.env ?? process.env,
      shell: true,
      windowsHide: true,
    })

    let stdout = ''
    let stderr = ''
    let settled = false
    let timer: NodeJS.Timeout | undefined

    const finish = (exitCode: number): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve({ exitCode, stdout, stderr })
    }

    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString()
    })

    if (opts.timeout && opts.timeout > 0) {
      timer = setTimeout(() => {
        stderr += `\nCommand timed out after ${opts.timeout}ms`
        child.kill()
        finish(124)
      }, opts.timeout)
    }

    child.on('error', (error) => {
      stderr += error.message
      finish(1)
    })
    child.on('close', (code) => {
      finish(code ?? 1)
    })
  })
}
