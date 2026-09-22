import { parseArgs } from 'node:util'
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
      const detail = row.windows?.map(window => `${window.name}: ${window.pct.toFixed(1)}% used`).join(', ')
        || row.balances?.map(balance => `${balance.amount} ${balance.currency}`).join(', ')
        || row.message || row.error || 'No observable quota'
      console.log(`${row.provider} [${row.status}] ${detail}`)
    }
    return requested && rows.some(row => row.status !== 'ok') ? 1 : 0
  } catch (error) {
    console.error(errorMessage(error))
    return 1
  } finally {
    client.close()
  }
}