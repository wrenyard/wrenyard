import { parseArgs } from 'node:util'
import { findProviderQuotaPool, providerQuotaPoolLabel } from '@wrenyard/providers'
import { connectConfiguredForemanClient, errorMessage } from '../shared.mts'

/** Whole-unit display of a signed decimal string: a true mathematical floor,
 * not truncation — "60691.4641665000" -> "60691", "0.999" -> "0",
 * "-3.2" -> "-4", "-0.2" -> "-1". String/BigInt only, matching the shared
 * desktop helper's signed-floor semantics. */
function floorAmount(amount: string): string {
  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(amount.trim())
  if (match === null) return amount.trim().length > 0 ? amount.trim() : '0'
  const negative = match[1] === '-'
  const intPart = match[2].replace(/^0+(?=\d)/, '')
  const fracPart = match[3] ?? ''
  if (negative && /[1-9]/.test(fracPart)) return `-${(BigInt(intPart) + 1n).toString()}`
  if (intPart === '0') return '0'
  return negative ? `-${intPart}` : intPart
}

/** Two-decimal display of a decimal-string amount: zero-padding ("12" -> "12.00",
 * "12.3" -> "12.30") and ordinary rounding ("12.346" -> "12.35"). Non-numeric
 * input falls back to the raw string rather than NaN. */
function twoDecimalAmount(amount: string): string {
  const value = Number(amount)
  if (!Number.isFinite(value)) return amount
  return value.toFixed(2)
}

const USAGE = 'Usage: wrenyard quota [provider] [--json] [--refresh] [--config path]'

/** CLI and Desktop consume the same daemon-owned provider observations. */
export async function handleQuota(args: string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(USAGE)
    return 0
  }
  const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true,
    options: { json: { type: 'boolean' }, refresh: { type: 'boolean' }, config: { type: 'string' } },
  })
  if (positionals.length > 1) {
    console.error(USAGE)
    return 2
  }
  const client = await connectConfiguredForemanClient(values.config)
  try {
    const snapshot = await client.provider.quota({ forceRefresh: values.refresh === true })
    const requested = positionals[0]
    const rows = requested
      ? snapshot.providers.filter(row => row.provider === requested)
      : snapshot.providers
    if (requested && rows.length === 0) {
      console.error(`No quota observation available for provider: ${requested}`)
      return 1
    }
    if (values.json) console.log(JSON.stringify(rows, null, 2))
    else for (const row of rows) {
      const detail = row.windows?.map(window => {
        const pool = findProviderQuotaPool(row.provider, window.name)
        const label = pool ? providerQuotaPoolLabel(pool) : window.name
        return `${label}: ${window.pct.toFixed(1)}% used`
      }).join(', ')
        || row.balances?.map(balance => balance.unlimited === true
          ? `unlimited ${balance.unit ?? balance.currency ?? ''}`.trim()
          : balance.unit !== undefined
            ? `${balance.amount !== null && balance.amount !== undefined ? floorAmount(balance.amount) : 'unknown'} ${balance.unit}`.trim()
            : `${balance.amount !== null && balance.amount !== undefined && (balance.currency === 'USD' || balance.currency === 'CNY') ? twoDecimalAmount(balance.amount) : balance.amount ?? 'unknown'} ${balance.currency ?? ''}`.trim()).join(', ')
        || row.message || row.error || 'No observable quota'
      console.log(`${row.provider} [${row.status}] plan: ${row.plan || 'unknown'} ${detail}`)
    }
    return requested && rows.some(row => row.status !== 'ok') ? 1 : 0
  } catch (error) {
    console.error(errorMessage(error))
    return 1
  } finally {
    client.close()
  }
}