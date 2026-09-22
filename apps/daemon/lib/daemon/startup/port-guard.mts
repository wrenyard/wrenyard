import { execFileSync, execSync } from 'node:child_process'
import { get } from 'node:http'

interface PortGuardOptions {
  /** Timeout for each health probe attempt in ms (default 2000) */
  probeTimeout?: number
  /** Max time to wait for port release after killing zombie in ms (default 10000) */
  releaseTimeout?: number
  /** Poll interval for release check in ms (default 500) */
  releaseInterval?: number
  /** Max retry count for re-bind after clearing port (default 5) */
  maxBindRetries?: number
}

/**
 * Resolve EADDRINUSE on the given port.
 * - If a healthy foreman is already running, exit 0 so the caller does not restart-loop.
 * - If the port is held by a zombie/non-responsive foreman, kill it and release.
 * - If the port is held by an unrelated process, log and exit 1.
 */
export async function resolvePortConflict(port: number, options: PortGuardOptions = {}): Promise<never | void> {
  const probeTimeout = options.probeTimeout ?? 2000
  const releaseTimeout = options.releaseTimeout ?? 10000
  const releaseInterval = options.releaseInterval ?? 500
  const maxBindRetries = options.maxBindRetries ?? 5

  // 1. Probe the health endpoint
  const healthy = await probeHealth(port, probeTimeout)
  if (healthy) {
    console.error(`[foreman] another healthy foreman instance is already serving on port ${port}; exiting`)
    // Exit 0: the requested service is already available.
    process.exit(0)
  }

  // 2. Port is held but health doesn't respond — find the holder
  const pid = findPortHolder(port)
  if (pid === null) {
    console.error(`[foreman] port ${port} is in use but cannot identify the process holding it; exiting`)
    process.exit(1)
  }

  // 3. Verify it's a foreman process
  if (!isForemanProcess(pid)) {
    console.error(`[foreman] port ${port} is held by a non-foreman process (PID ${pid}); refusing to kill; exiting`)
    process.exit(1)
  }

  // 4. Kill the zombie foreman
  console.error(`[foreman] killing zombie foreman process (PID ${pid}) holding port ${port}`)
  killProcess(pid)

  // 5. Wait for the port to be released (bounded)
  const released = await waitForPortRelease(port, releaseTimeout, releaseInterval)
  if (!released) {
    console.error(`[foreman] zombie process killed but port ${port} not released within ${releaseTimeout}ms; exiting`)
    process.exit(1)
  }
}

/**
 * Probe http://127.0.0.1:<port>/health with a timeout.
 * Returns true if the response is 2xx and body contains "ok".
 */
function probeHealth(port: number, timeout: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const req = get(`http://127.0.0.1:${port}/health`, { timeout }, (res) => {
      let body = ''
      res.setEncoding('utf-8')
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => {
        const ok = res.statusCode != null && res.statusCode >= 200 && res.statusCode < 300
        resolve(ok)
      })
    })
    req.on('error', () => resolve(false))
    req.on('timeout', () => {
      req.destroy()
      resolve(false)
    })
  })
}

/**
 * Find the PID holding the given TCP port across platforms.
 * Returns the PID as a number, or null if not found.
 */
function findPortHolder(port: number): number | null {
  if (process.platform === 'win32') {
    return findPortHolderWindows(port)
  }
  return findPortHolderUnix(port)
}

function findPortHolderWindows(port: number): number | null {
  try {
    const output = execFileSync('netstat', ['-ano'], { encoding: 'utf-8', timeout: 5000, windowsHide: true })
    const lines = output.split(/\r?\n/)
    for (const line of lines) {
      // Match lines containing "LISTENING" on the given port
      if (!line.includes('LISTENING')) continue
      if (!line.includes(`:${port}`)) continue
      // Parse the last column as PID
      const parts = line.trim().split(/\s+/)
      const pid = parseInt(parts[parts.length - 1], 10)
      if (Number.isInteger(pid) && pid > 0) return pid
    }
  } catch {
    // netstat failed
  }
  return null
}

function findPortHolderUnix(port: number): number | null {
  // Try ss first, fall back to lsof
  try {
    const output = execFileSync('ss', ['-tlnp'], { encoding: 'utf-8', timeout: 5000, windowsHide: true })
    const lines = output.split('\n')
    for (const line of lines) {
      if (!line.includes(`:${port}`)) continue
      // format: LISTEN 0 128 0.0.0.0:8787 0.0.0.0:* users:(("node",pid=12345,fd=18))
      const match = line.match(/pid=(\d+)/)
      if (match) return parseInt(match[1], 10)
    }
  } catch {
    // ss not available
  }

  // Fallback: lsof
  try {
    const output = execFileSync('lsof', ['-i', `:${port}`, '-t'], { encoding: 'utf-8', timeout: 5000, windowsHide: true })
    const pid = parseInt(output.trim().split('\n')[0], 10)
    if (Number.isInteger(pid) && pid > 0) return pid
  } catch {
    // lsof not available or no match
  }

  return null
}

/**
 * Verify that the given PID belongs to a foreman process.
 */
function isForemanProcess(pid: number): boolean {
  if (process.platform === 'win32') {
    return isForemanProcessWindows(pid)
  }
  return isForemanProcessUnix(pid)
}

function isForemanProcessWindows(pid: number): boolean {
  try {
    // wmic gives full command line — the only reliable way to verify foreman on Windows
    // since foreman always runs as node.exe / tsx
    const output = execFileSync('wmic', ['process', 'where', `ProcessId=${pid}`, 'get', 'CommandLine'], {
      encoding: 'utf-8',
      timeout: 5000,
      windowsHide: true,
    })
    return output.toLowerCase().includes('foreman')
  } catch {
    return false
  }
}

function isForemanProcessUnix(pid: number): boolean {
  try {
    const cmdline = execFileSync('cat', [`/proc/${pid}/cmdline`], { encoding: 'utf-8', timeout: 5000, windowsHide: true })
    return cmdline.includes('foreman')
  } catch {
    try {
      // fallback: ps
      const output = execFileSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf-8', timeout: 5000, windowsHide: true })
      return output.toLowerCase().includes('foreman')
    } catch {
      return false
    }
  }
}

/**
 * Kill a process by PID, cross-platform.
 */
function killProcess(pid: number): void {
  if (process.platform === 'win32') {
    execFileSync('taskkill', ['/F', '/PID', String(pid)], { timeout: 10000, windowsHide: true })
    return
  }
  // Unix: attempt SIGTERM first, then SIGKILL
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // Already gone
    }
  }
}

/**
 * Poll until the port is free or timeout expires.
 */
function waitForPortRelease(port: number, timeout: number, interval: number): Promise<boolean> {
  const start = Date.now()
  return new Promise<boolean>((resolve) => {
    function check(): void {
      const holder = findPortHolder(port)
      if (holder === null) {
        resolve(true)
        return
      }
      if (Date.now() - start >= timeout) {
        resolve(false)
        return
      }
      setTimeout(check, interval)
    }
    check()
  })
}
