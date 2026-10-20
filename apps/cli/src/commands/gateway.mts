import { parseArgs } from 'node:util'
import { connectConfiguredForemanClient, errorMessage } from '../shared.mts'

const USAGE = 'Usage: wrenyard gateway health [--config path] [--json]'

interface HealthWindow {
  requests: number
  successes: number
  failures: Record<string, number>
  cancelled: number
  callerErrors: number
  admissionRefusals: number
  medianFirstResponseMs?: number
  medianTps?: number
  lastSuccessAt?: string
  lastFailure?: { at: string; class: string; reason: string }
}

function failureTotal(window: HealthWindow): number {
  return Object.values(window.failures).reduce((sum, count) => sum + count, 0)
}

function formatFailureBreakdown(failures: Record<string, number>): string {
  const entries = Object.entries(failures).filter(([, count]) => count > 0)
  if (entries.length === 0) return ''
  return ` (${entries.map(([className, count]) => `${className}:${count}`).join(', ')})`
}

function formatWindowSummary(label: string, window: HealthWindow): string {
  const parts = [
    `${label}: ${window.requests} req, ${window.successes} ok, ${failureTotal(window)} fail${formatFailureBreakdown(window.failures)}`,
  ]
  if (window.cancelled > 0) parts.push(`${window.cancelled} cancelled`)
  if (window.callerErrors > 0) parts.push(`${window.callerErrors} caller errors`)
  if (window.admissionRefusals > 0) parts.push(`${window.admissionRefusals} admission refusals`)
  if (window.medianFirstResponseMs !== undefined) {
    parts.push(`median first response ${window.medianFirstResponseMs} ms`)
  }
  if (window.medianTps !== undefined) {
    parts.push(`median tps ${window.medianTps.toFixed(1)}`)
  }
  return parts.join('; ')
}

function formatLastEvents(window: HealthWindow): string {
  const parts: string[] = []
  if (window.lastSuccessAt) parts.push(`last success ${window.lastSuccessAt}`)
  if (window.lastFailure) {
    const { at, class: failureClass, reason } = window.lastFailure
    parts.push(`last failure ${at} [${failureClass}] ${reason}`)
  }
  return parts.join('; ')
}

function printHealthSummary(result: { generatedAt: string; routes: Array<{
  provider: string
  model: string
  last1h: HealthWindow
  last24h: HealthWindow
  routeState?: { state: string; until: string }
}> }): void {
  console.log(`Gateway health as of ${result.generatedAt}`)
  if (result.routes.length === 0) {
    console.log('No routes with recent traffic.')
    return
  }
  const byProvider = new Map<string, typeof result.routes>()
  for (const route of result.routes) {
    const group = byProvider.get(route.provider)
    if (group) group.push(route)
    else byProvider.set(route.provider, [route])
  }
  for (const [provider, routes] of [...byProvider.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    console.log(`\n${provider}`)
    for (const route of routes.sort((a, b) => a.model.localeCompare(b.model))) {
      const line = [
        `  ${route.model}:`,
        formatWindowSummary('1h', route.last1h),
        formatWindowSummary('24h', route.last24h),
      ]
      const lastEvents = formatLastEvents(route.last24h)
      if (lastEvents) line.push(lastEvents)
      if (route.routeState) {
        line.push(`route state ${route.routeState.state} until ${route.routeState.until}`)
      }
      console.log(line.join(' | '))
    }
  }
}

export async function handleGateway(args: string[]): Promise<number> {
  const subcommand = args[0]
  if (!subcommand || subcommand === '--help' || subcommand === '-h') {
    console.error(USAGE)
    return subcommand ? 0 : 1
  }
  if (subcommand === 'health') return handleGatewayHealth(args.slice(1))
  console.error(USAGE)
  return 1
}

async function handleGatewayHealth(args: string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(USAGE)
    return 0
  }
  const { values, positionals } = parseArgs({
    args,
    options: {
      config: { type: 'string' },
      json: { type: 'boolean' },
    },
    allowPositionals: true,
    strict: true,
  })
  if (positionals.length > 0) {
    console.error(USAGE)
    return 2
  }
  const client = await connectConfiguredForemanClient(values.config)
  try {
    const result = await client.gateway.health({})
    if (values.json) console.log(JSON.stringify(result, null, 2))
    else printHealthSummary(result)
    return 0
  } catch (error) {
    console.error(errorMessage(error))
    return 1
  } finally {
    client.close()
  }
}
