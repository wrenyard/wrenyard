import { parseArgs } from 'node:util'
import { requireNoPositionals } from '../helpers.mts'
import {
  connectConfiguredForemanClient,
  isHelpRequest,
  servicePayload,
  writeServicePayload,
} from '../shared.mts'
import type { PetControlResult, PetStatusResult } from '../../../protocol/registry.mts'

type PetCommand = 'enable' | 'disable' | 'restart'

const PET_USAGE = 'Usage: wrenyard pet <enable|disable|restart> [--config path] [--json]'

export async function handlePet(args: string[]): Promise<number> {
  const subcommand = args[0]
  if (!subcommand || subcommand === '--help' || subcommand === '-h') {
    console.log(PET_USAGE)
    return subcommand ? 0 : 1
  }

  if (subcommand === 'enable' || subcommand === 'disable' || subcommand === 'restart') {
    return handlePetCommand(subcommand, args.slice(1))
  }

  console.error(PET_USAGE)
  return 1
}

async function handlePetCommand(command: PetCommand, args: string[]): Promise<number> {
  if (isHelpRequest(args)) {
    console.log(PET_USAGE)
    return 0
  }

  const { values, positionals } = parseArgs({
    args,
    options: {
      config: { type: 'string' },
      json: { type: 'boolean' },
    },
    allowPositionals: false,
    strict: true,
  })
  requireNoPositionals(positionals, PET_USAGE)

  const client = await connectConfiguredForemanClient(values.config)
  try {
    const result = await controlPet(command, client)
    if (values.json) {
      writeServicePayload(servicePayload(result))
    } else {
      console.log(`Wrenyard pet ${pastTense(command)}`)
      printPetStatusText(result.status)
    }
    return result.ok && result.status.state !== 'failed' ? 0 : 1
  } finally {
    client.close()
  }
}

async function controlPet(
  command: PetCommand,
  client: Awaited<ReturnType<typeof connectConfiguredForemanClient>>,
): Promise<PetControlResult> {
  if (command === 'enable') return client.pet.start()
  if (command === 'disable') return client.pet.stop()
  return client.pet.restart()
}

function pastTense(command: PetCommand): string {
  if (command === 'disable') return 'disabled'
  if (command === 'enable') return 'enabled'
  return 'restarted'
}

function printPetStatusText(status: PetStatusResult): void {
  console.log(`  state:       ${status.state}`)
  console.log(`  enabled:     ${status.enabled ? 'yes' : 'no'}`)
  console.log(`  transport:   ${status.transport}`)
  console.log(`  command:     ${status.command} ${status.args.join(' ')}`.trimEnd())
  console.log(`  cwd:         ${status.cwd}`)
  if (status.pid) console.log(`  pid:         ${status.pid}`)
  if (status.ipc_path) console.log(`  ipc:         ${status.ipc_path}`)
  if (status.started_at) console.log(`  started:     ${status.started_at}`)
  if (status.stopped_at) console.log(`  stopped:     ${status.stopped_at}`)
  if (status.last_exit_code !== undefined) console.log(`  exit code:   ${status.last_exit_code}`)
  if (status.last_exit_signal) console.log(`  exit signal: ${status.last_exit_signal}`)
  if (status.last_error) console.log(`  last error:  ${status.last_error}`)
}
