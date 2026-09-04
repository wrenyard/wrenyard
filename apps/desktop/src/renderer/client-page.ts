import type {
  ClientCompatibility,
  ClientConfigurationId,
  ClientConfigurationPlanDto,
  ClientConfigurationSnapshotDto,
  ClientConfigurationState,
  ClientGatewayModelDto,
  ClientSurfaceDto,
  ClientSurfaceId,
  GatewayProtocol,
} from '../client-configuration/contract.js';

export interface ClientSurfaceRowModel {
  id: ClientSurfaceId;
  label: string;
  status: string;
  detail: string;
}

export interface ClientCardModel {
  id: ClientConfigurationId;
  title: string;
  connectionMode: '加法式' | '切换式';
  status: string;
  detail: string;
  surfaces: ClientSurfaceRowModel[];
  models: string[];
  availableModels: ClientGatewayModelDto[];
  primaryAction: '连接到 Wrenyard' | '调整模型' | '重新应用' | '查看冲突';
  canRestore: boolean;
}

export interface ClientPageModel {
  cards: ClientCardModel[];
}

const CARD_DEFINITIONS: ReadonlyArray<{
  id: ClientConfigurationId;
  title: string;
  mode: ClientCardModel['connectionMode'];
  surfaces: readonly ClientSurfaceId[];
  protocols: readonly GatewayProtocol[];
  excludedProviders?: readonly string[];
  emptyMessage: string;
}> = [
  {
    id: 'claude-app', title: 'Claude App', mode: '切换式', surfaces: ['claude-app'],
    protocols: ['anthropic_messages'], emptyMessage: '当前没有已配置的 Anthropic Messages 模型。',
  },
  {
    id: 'claude-code', title: 'Claude Code', mode: '切换式', surfaces: ['claude-code'],
    protocols: ['anthropic_messages'], emptyMessage: '当前没有已配置的 Anthropic Messages 模型。',
  },
  {
    id: 'codex-shared', title: 'Codex', mode: '切换式', surfaces: ['codex-app', 'codex-cli'],
    protocols: ['openai_responses'], emptyMessage: '当前没有已配置的 Responses 模型。',
  },
  {
    id: 'grok-build', title: 'Grok Build', mode: '加法式', surfaces: ['grok-build'],
    protocols: ['openai_chat', 'openai_responses', 'anthropic_messages'],
    excludedProviders: ['codebuddy'],
    emptyMessage: '当前没有可用于此客户端的已配置 Gateway 模型。',
  },
];

function modelsForProtocols(
  protocols: readonly GatewayProtocol[],
  models: readonly ClientGatewayModelDto[],
  excludedProviders: readonly string[] = [],
): ClientGatewayModelDto[] {
  const supported = new Set(protocols);
  const excluded = new Set(excludedProviders);
  return models.filter((model) => !excluded.has(model.provider) && model.protocols.some((protocol) => supported.has(protocol)));
}

const COMPATIBILITY_LABELS: Record<ClientCompatibility, string> = {
  'not-installed': '未安装',
  supported: '支持',
  'needs-verification': '待独立验收',
  'needs-upgrade': '需升级',
  'externally-managed': '外部管理',
};

const CONFIGURATION_LABELS: Record<ClientConfigurationState, string> = {
  'not-configured': '未配置',
  connected: '已连接',
  drifted: '有可用更新',
  conflict: '冲突',
  'needs-restart': '需重启',
};

function action(state: ClientConfigurationState): ClientCardModel['primaryAction'] {
  if (state === 'conflict') return '查看冲突';
  if (state === 'drifted') return '重新应用';
  if (state === 'connected' || state === 'needs-restart') return '调整模型';
  return '连接到 Wrenyard';
}

function surfaceRow(surface: ClientSurfaceDto | undefined, id: ClientSurfaceId): ClientSurfaceRowModel {
  if (!surface) return { id, label: id, status: '未探测', detail: '' };
  const facts = [surface.version, surface.source].filter(Boolean).join(' · ');
  return {
    id,
    label: surface.label,
    status: COMPATIBILITY_LABELS[surface.compatibility],
    detail: [facts, surface.detail].filter(Boolean).join(' · '),
  };
}

export function buildClientPageModel(snapshot: ClientConfigurationSnapshotDto): ClientPageModel {
  const surfaces = new Map(snapshot.surfaces.map((surface) => [surface.id, surface]));
  const configurations = new Map(snapshot.configurations.map((configuration) => [configuration.clientId, configuration]));
  return {
    cards: CARD_DEFINITIONS.map((definition) => {
      const configuration = configurations.get(definition.id) ?? {
        clientId: definition.id,
        state: 'not-configured' as const,
        configuredModels: [],
      };
      return {
        id: definition.id,
        title: definition.title,
        connectionMode: definition.mode,
        status: CONFIGURATION_LABELS[configuration.state],
        detail: configuration.detail ?? '',
        surfaces: definition.surfaces.map((id) => surfaceRow(surfaces.get(id), id)),
        models: [...configuration.configuredModels],
        availableModels: modelsForProtocols(definition.protocols, snapshot.models, definition.excludedProviders),
        primaryAction: action(configuration.state),
        canRestore: configuration.state !== 'not-configured',
      };
    }),
  };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character] ?? character);
}

export function renderClientPageMarkup(model: ClientPageModel): string {
  return `<section class="client-page" aria-label="客户端配置">
  <div class="client-page__grid">
${model.cards.map((card) => `    <article class="client-card" data-client-id="${card.id}">
      <header><h2>${escapeHtml(card.title)}</h2><span>${card.connectionMode}</span></header>
      <p class="client-card__status">${escapeHtml(card.status)}</p>
      ${card.surfaces.map((surface) => `<div class="client-surface" data-surface-id="${surface.id}"><strong>${escapeHtml(surface.label)}</strong><span>${escapeHtml(surface.status)}</span><small>${escapeHtml(surface.detail)}</small></div>`).join('')}
      <div class="client-card__model-list" aria-label="${escapeHtml(card.title)} 模型">
        ${card.availableModels.length > 0 ? card.availableModels.map((model, index) => {
          const selected = card.models.includes(model.publicId) || (card.models.length === 0 && index === 0);
          const defaultModel = card.models[0] === model.publicId || (card.models.length === 0 && index === 0);
          const protocolOptions = card.id === 'grok-build' && model.protocols.length > 1
            ? `<select data-client-protocol="${escapeHtml(model.publicId)}" aria-label="${escapeHtml(model.displayName)} 协议">${model.protocols.map((protocol) => `<option value="${protocol}">${escapeHtml(protocol)}</option>`).join('')}</select>`
            : '';
          return `<label class="client-model-option"><input type="checkbox" data-client-model="${escapeHtml(model.publicId)}"${selected ? ' checked' : ''} /><span><strong>${escapeHtml(model.displayName)}</strong><small>${escapeHtml(model.publicId)}</small></span><input type="radio" name="${card.id}-default-model" data-client-default="${escapeHtml(model.publicId)}" aria-label="设为默认模型"${defaultModel ? ' checked' : ''} />${protocolOptions}</label>`;
        }).join('') : `<p class="client-card__empty">${escapeHtml(CARD_DEFINITIONS.find((definition) => definition.id === card.id)?.emptyMessage ?? '')}</p>`}
      </div>
      <div class="client-card__actions"><button type="button" data-client-action="primary">${card.primaryAction}</button>${card.canRestore ? '<button type="button" data-client-action="restore">恢复原配置</button>' : ''}</div>
    </article>`).join('\n')}
  </div>
</section>`;
}

export function renderClientPlanPreview(plan: ClientConfigurationPlanDto): string {
  const mode = plan.connectionMode === 'additive' ? '加法式接入' : '切换式接入';
  const restart = plan.requiresRestart.length > 0 ? plan.requiresRestart.join('、') : '无需重启';
  return `<section class="client-plan-preview" data-client-id="${plan.clientId}">
  <h2>${plan.operation === 'restore' ? '恢复预览' : '连接预览'}</h2>
  <p>${mode} · ${escapeHtml(restart)}</p>
  <dl><dt>默认模型</dt><dd>${escapeHtml(plan.defaultModel ?? '—')}</dd></dl>
  <ul class="client-plan-preview__models">${plan.models.map((model) => `<li>${escapeHtml(model)}</li>`).join('')}</ul>
  <ul class="client-plan-preview__files">${plan.files.map((file) => `<li><code>${escapeHtml(file.path)}</code><span>${file.changes.map(escapeHtml).join('、')}</span></li>`).join('')}</ul>
  <ul class="client-plan-preview__effects">${plan.effects.map((effect) => `<li>${escapeHtml(effect)}</li>`).join('')}</ul>
</section>`;
}
