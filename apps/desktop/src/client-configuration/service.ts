import type {
  ClientConfigurationDto,
  ClientConfigurationId,
  ClientConfigurationPlanDto,
  ClientConfigurationSnapshotDto,
  ClientModelSelectionDto,
} from './contract.js';
import { WrenyardIpcClient } from '@wrenyard/control-client';

const CLIENT_IDS = new Set<ClientConfigurationId>(['claude-app', 'claude-code', 'codex-shared', 'grok-build']);
const MAX_MODELS = 128;

export interface ClientConfigurationControlClient {
  clientConfigurationSnapshot(): Promise<ClientConfigurationSnapshotDto>;
  clientConfigurationPlan(clientId: ClientConfigurationId, selection: ClientModelSelectionDto): Promise<ClientConfigurationPlanDto>;
  clientConfigurationApply(plan: ClientConfigurationPlanDto): Promise<ClientConfigurationDto>;
  clientConfigurationPlanRestore(clientId: ClientConfigurationId): Promise<ClientConfigurationPlanDto>;
  clientConfigurationRestore(plan: ClientConfigurationPlanDto): Promise<ClientConfigurationDto>;
  close(): void;
}

export interface ClientConfigurationDesktopServiceOptions {
  ipcPath: string;
  clientFactory?: (path: string) => ClientConfigurationControlClient;
}

function clientId(value: string): ClientConfigurationId {
  if (!CLIENT_IDS.has(value as ClientConfigurationId)) throw new Error('客户端类型无效');
  return value as ClientConfigurationId;
}

function selection(value: ClientModelSelectionDto): ClientModelSelectionDto {
  if (!Array.isArray(value.models) || value.models.length < 1 || value.models.length > MAX_MODELS) {
    throw new Error('模型选择无效');
  }
  if (new Set(value.models).size !== value.models.length || !value.models.includes(value.defaultModel)) {
    throw new Error('默认模型必须位于唯一模型列表中');
  }
  if (value.models.some((model) => typeof model !== 'string' || !model.trim() || model.length > 240)) {
    throw new Error('模型 ID 无效');
  }
  return {
    models: value.models.map((model) => model.trim()),
    defaultModel: value.defaultModel.trim(),
    ...(value.protocols ? { protocols: { ...value.protocols } } : {}),
  };
}

function copyPlan(plan: ClientConfigurationPlanDto): ClientConfigurationPlanDto {
  return {
    clientId: plan.clientId,
    operation: plan.operation,
    files: plan.files.map((file) => ({
      path: file.path,
      digest: file.digest,
      existed: file.existed,
      changes: [...file.changes],
    })),
    models: [...plan.models],
    ...(plan.defaultModel ? { defaultModel: plan.defaultModel } : {}),
    ...(plan.protocols ? { protocols: { ...plan.protocols } } : {}),
    connectionMode: plan.connectionMode,
    effects: [...plan.effects],
    requiresRestart: [...plan.requiresRestart],
  };
}

/** Main-process facade. It returns only the daemon's redacted client DTOs. */
export class ClientConfigurationDesktopService {
  private readonly clientFactory: (path: string) => ClientConfigurationControlClient;

  constructor(private readonly options: ClientConfigurationDesktopServiceOptions) {
    this.clientFactory = options.clientFactory ?? ((path) => new WrenyardIpcClient({ path }));
  }

  async snapshot(): Promise<ClientConfigurationSnapshotDto> {
    return this.withClient((client) => client.clientConfigurationSnapshot());
  }

  async plan(rawClientId: string, rawSelection: ClientModelSelectionDto): Promise<ClientConfigurationPlanDto> {
    const id = clientId(rawClientId);
    const selected = selection(rawSelection);
    return this.withClient(async (client) => copyPlan(await client.clientConfigurationPlan(id, selected)));
  }

  async apply(plan: ClientConfigurationPlanDto): Promise<ClientConfigurationDto> {
    clientId(plan.clientId);
    if (plan.operation !== 'apply') throw new Error('连接操作需要 apply 预览');
    return this.withClient((client) => client.clientConfigurationApply(copyPlan(plan)));
  }

  async planRestore(rawClientId: string): Promise<ClientConfigurationPlanDto> {
    const id = clientId(rawClientId);
    return this.withClient(async (client) => copyPlan(await client.clientConfigurationPlanRestore(id)));
  }

  async restore(plan: ClientConfigurationPlanDto): Promise<ClientConfigurationDto> {
    clientId(plan.clientId);
    if (plan.operation !== 'restore') throw new Error('恢复操作需要 restore 预览');
    return this.withClient((client) => client.clientConfigurationRestore(copyPlan(plan)));
  }

  private async withClient<T>(operation: (client: ClientConfigurationControlClient) => Promise<T>): Promise<T> {
    const client = this.clientFactory(this.options.ipcPath);
    try {
      return await operation(client);
    } finally {
      client.close();
    }
  }
}
