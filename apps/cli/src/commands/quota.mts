import { parseArgs } from 'node:util'
import { findProviderQuotaPool, providerQuotaPoolLabel } from '@wrenyard/providers'
import { formatBalanceAmount } from '@wrenyard/auto-routing'
import { connectConfiguredForemanClient, errorMessage } from '../shared.mts'

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
          : `${balance.amount !== null && balance.amount !== undefined ? formatBalanceAmount(balance.amount, balance.unit ?? balance.currency ?? '') : 'unknown'} ${balance.unit ?? balance.currency ?? ''}`.trim()).join(', ')
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