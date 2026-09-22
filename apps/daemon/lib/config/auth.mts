import { readFileSync } from 'node:fs'

export function resolveToken(cfg: { token_env?: string; token_file?: string }): string | null {
  if (cfg.token_env) {
    const fromEnv = process.env[cfg.token_env]?.trim()
    if (fromEnv) return fromEnv
  }
  if (cfg.token_file) {
    try {
      const fromFile = readFileSync(cfg.token_file, 'utf-8').trim()
      if (fromFile) return fromFile
    } catch {
      // File missing or unreadable; callers treat null as not configured.
    }
  }
  return null
}
