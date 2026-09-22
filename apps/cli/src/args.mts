
import { POWERSHELL_COMMAND_LINE_ENV } from './shared.mts'

export function resolveCliArgs(argv: string[] = process.argv.slice(2), rawPowerShellLine = process.env[POWERSHELL_COMMAND_LINE_ENV]): string[] {
  if (!rawPowerShellLine) return argv
  const parsed = parsePowerShellForemanArgs(rawPowerShellLine)
  return parsed ?? argv
}

export function parsePowerShellForemanArgs(line: string): string[] | null {
  const tokens = tokenizePowerShellLine(line)
  if (tokens.length === 0) return null
  let start = 0
  if (tokens[start] === '&') start += 1
  if (tokens[start] && isForemanCommandToken(tokens[start])) return tokens.slice(start + 1)
  return null
}

function tokenizePowerShellLine(line: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quote: "'" | '"' | null = null

  function pushCurrent(): void {
    if (current.length === 0) return
    tokens.push(current)
    current = ''
  }

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i]
    if (quote === "'") {
      if (char === "'") {
        if (line[i + 1] === "'") {
          current += "'"
          i += 1
        } else {
          quote = null
        }
      } else {
        current += char
      }
      continue
    }

    if (quote === '"') {
      if (char === '`' && i + 1 < line.length) {
        current += line[i + 1]
        i += 1
      } else if (char === '"') {
        quote = null
      } else {
        current += char
      }
      continue
    }

    if (/\s/u.test(char)) {
      pushCurrent()
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      continue
    }
    if (char === '`' && i + 1 < line.length) {
      current += line[i + 1]
      i += 1
      continue
    }
    current += char
  }
  pushCurrent()
  return tokens
}

function isForemanCommandToken(token: string): boolean {
  const command = token.replace(/\\/gu, '/').split('/').pop()?.toLowerCase()
  return command === 'foreman' || command === 'foreman.ps1' || command === 'foreman.cmd' || command === 'foreman.exe'
}
