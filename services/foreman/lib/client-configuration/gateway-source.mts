import { randomBytes, randomUUID } from 'node:crypto'
import { chmod, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Catalog, GatewayProtocol } from '@wrenyard/catalog'
import type { ProviderRuntime } from '@wrenyard/providers'
import type { ClientGatewayModel, GatewayClientConnection } from './types.mts'

export interface GatewayClientSourceOptions {
  catalog: Catalog
  providers: ProviderRuntime
  connection: () => Promise<{
    openaiChatBaseUrl: string
    openaiResponsesBaseUrl: string
    anthropicBaseUrl: string
  }>
  credential: () => string
  credentialHelperPath: string
}

export class DaemonGatewayClientSource {
  constructor(private readonly options: GatewayClientSourceOptions) {}

  async read(): Promise<GatewayClientConnection> {
    const base = await this.options.connection()
    return {
      ...base,
      credential: this.options.credential(),
      credentialHelperPath: this.options.credentialHelperPath,
      credentialHelperCommand: [this.options.credentialHelperPath],
      models: await availableClientModels(this.options.catalog, this.options.providers),
    }
  }
}

async function availableClientModels(catalog: Catalog, providers: ProviderRuntime): Promise<ClientGatewayModel[]> {
  const configured = new Set<string>()
  await Promise.all(catalog.providers().map(async (provider) => {
    if (await providers.credential(provider)) configured.add(provider.id)
  }))
  return catalog.providers()
    .filter((provider) => configured.has(provider.id))
    .flatMap((provider) => {
      const protocols = (provider.protocols ?? []).map((entry) => entry.protocol)
      if (protocols.length === 0) return []
      return provider.models.filter((model) => !model.taskOnly).map((model) => ({
        id: model.id,
        publicId: `${provider.id}/${model.id}`,
        provider: provider.id,
        displayName: model.displayName,
        protocols: protocols as GatewayProtocol[],
        ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
        ...(model.maxTokens ? { maxTokens: model.maxTokens } : {}),
        ...(model.family === 'claude' ? { claudeFamily: true as const } : {}),
        ...(model.claudeTier ? { claudeTier: model.claudeTier } : {}),
        ...(model.supports1MContext ? { supports1MContext: true as const } : {}),
      }))
    })
    .sort((left, right) => left.publicId.localeCompare(right.publicId))
}

export async function loadOrCreateGatewayCredential(path: string): Promise<string> {
  try {
    const existing = (await readFile(path, 'utf8')).trim()
    if (existing.length < 32) throw new Error(`invalid Wrenyard Gateway credential: ${path}`)
    await chmod(path, 0o600)
    return existing
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const credential = randomBytes(32).toString('base64url')
  try {
    const file = await open(path, 'wx', 0o600)
    try { await file.writeFile(`${credential}\n`, 'utf8') } finally { await file.close() }
    return credential
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const existing = (await readFile(path, 'utf8')).trim()
    if (existing.length < 32) throw new Error(`invalid Wrenyard Gateway credential: ${path}`)
    await chmod(path, 0o600)
    return existing
  }
}

export async function ensureGatewayCredentialHelper(path: string, ipcPath: string, nodePath = process.execPath): Promise<void> {
  if (process.platform === 'win32') throw new Error('Gateway credential helper is not implemented on Windows yet')
  const script = gatewayCredentialHelperScript(nodePath, ipcPath)
  try {
    if (await readFile(path, 'utf8') === script) {
      await chmod(path, 0o700)
      return
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.wrenyard-${process.pid}-${randomUUID()}.tmp`
  try {
    await writeFile(temporary, script, { encoding: 'utf8', mode: 0o700 })
    await chmod(temporary, 0o700)
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

function gatewayCredentialHelperScript(nodePath: string, ipcPath: string): string {
  return `#!${nodePath}\nimport net from 'node:net';\nconst socket = net.createConnection(${JSON.stringify(ipcPath)});\nlet data = '';\nconst timer = setTimeout(() => { console.error('Wrenyard Gateway credential helper timed out'); socket.destroy(); process.exit(1); }, 5000);\nsocket.setEncoding('utf8');\nsocket.on('connect', () => socket.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'gateway.connection', params: {} }) + '\\n'));\nsocket.on('data', (chunk) => {\n  data += chunk;\n  const newline = data.indexOf('\\n');\n  if (newline < 0) return;\n  clearTimeout(timer);\n  const reply = JSON.parse(data.slice(0, newline));\n  if (reply.error || typeof reply.result?.token !== 'string') throw new Error(reply.error?.message ?? 'Gateway credential unavailable');\n  process.stdout.write(reply.result.token + '\\n');\n  socket.end();\n});\nsocket.on('error', (error) => { clearTimeout(timer); console.error(error.message); process.exit(1); });\n`
}
