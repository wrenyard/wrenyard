import { mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { applyFileTransaction } from './files.mts'
import type {
  ClientConfigurationId,
  ClientOwnershipRecord,
  ClientOwnershipStore,
} from './types.mts'

interface OwnershipDocument {
  version: 1
  clients: Partial<Record<ClientConfigurationId, ClientOwnershipRecord>>
}

function emptyDocument(): OwnershipDocument {
  return { version: 1, clients: {} }
}

function isOwnershipDocument(value: unknown): value is OwnershipDocument {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return record.version === 1 && !!record.clients && typeof record.clients === 'object' && !Array.isArray(record.clients)
}

export class JsonClientOwnershipStore implements ClientOwnershipStore {
  constructor(private readonly path: string) {}

  async get(clientId: ClientConfigurationId): Promise<ClientOwnershipRecord | undefined> {
    return (await this.read()).clients[clientId]
  }

  async put(record: ClientOwnershipRecord): Promise<void> {
    const document = await this.read()
    document.clients[record.clientId] = structuredClone(record)
    await this.write(document)
  }

  async remove(clientId: ClientConfigurationId): Promise<void> {
    const document = await this.read()
    delete document.clients[clientId]
    if (Object.keys(document.clients).length === 0) {
      await applyFileTransaction([{ path: this.path, content: null }], async () => undefined)
      return
    }
    await this.write(document)
  }

  private async read(): Promise<OwnershipDocument> {
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8')) as unknown
      if (!isOwnershipDocument(parsed)) throw new Error(`invalid client ownership store: ${this.path}`)
      return parsed
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyDocument()
      throw error
    }
  }

  private async write(document: OwnershipDocument): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    const content = `${JSON.stringify(document, null, 2)}\n`
    await applyFileTransaction([{ path: this.path, content, mode: 0o600 }], async () => undefined)
  }
}

export class MemoryClientOwnershipStore implements ClientOwnershipStore {
  private readonly records = new Map<ClientConfigurationId, ClientOwnershipRecord>()

  async get(clientId: ClientConfigurationId): Promise<ClientOwnershipRecord | undefined> {
    const record = this.records.get(clientId)
    return record ? structuredClone(record) : undefined
  }

  async put(record: ClientOwnershipRecord): Promise<void> {
    this.records.set(record.clientId, structuredClone(record))
  }

  async remove(clientId: ClientConfigurationId): Promise<void> {
    this.records.delete(clientId)
  }
}
