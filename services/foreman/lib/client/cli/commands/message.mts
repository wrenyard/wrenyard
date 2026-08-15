
import { parseArgs } from 'node:util'
import { requireNoPositionals } from '../helpers.mts'
import {
  connectConfiguredForemanClient,
  servicePayload,
  writeServicePayload,
} from '../shared.mts'

export async function handleMessageSend(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      config: { type: 'string', short: 'c' },
      message: { type: 'string', short: 'm' },
      to: { type: 'string' },
      sender: { type: 'string' },
    },
    allowPositionals: false,
    strict: true,
  })
  requireNoPositionals(positionals, 'wrenyard message send -m "<message>" --sender <principal> --to <address> [--config path]')

  const message = values.message
  const sender = values.sender
  const to = values.to
  if (!message || !sender || !to) {
    console.error('Usage: wrenyard message send -m "<message>" --sender <principal> --to <address> [--config path]')
    return 1
  }

  const client = await connectConfiguredForemanClient(values.config)
  try {
    const result = await client.message.send({
      text: message,
      to,
      sender: {
        role: sender,
      },
    })
    writeServicePayload(servicePayload(result))
    return result.accepted ? 0 : 1
  } finally {
    client.close()
  }
}

export async function handleMessage(args: string[]): Promise<number> {
  const subcommand = args[0]
  if (subcommand === 'send') return handleMessageSend(args.slice(1))
  console.error('Usage: wrenyard message send -m "<message>" --sender <principal> --to <address> [--config path]')
  return 1
}
