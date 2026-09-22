import type { ShellOpts, ShellResult } from '../../../types.mts'

export type ShellPrimitive = (command: string, opts?: ShellOpts) => Promise<ShellResult>

let shellPrimitive: ShellPrimitive | undefined

export function setShellPrimitive(implementation: ShellPrimitive | undefined): void {
  shellPrimitive = implementation
}

export function getShellPrimitive(): ShellPrimitive {
  if (!shellPrimitive) {
    throw new Error(
      'Shell primitive has not been injected. Foreman runtime must inject a shell implementation before using shell().',
    )
  }
  return shellPrimitive
}

export function createShellPrimitive(implementation: ShellPrimitive): ShellPrimitive {
  return (command, opts = {}) => implementation(command, opts)
}

export async function shell(command: string, opts: ShellOpts = {}): Promise<ShellResult> {
  return getShellPrimitive()(command, opts)
}
