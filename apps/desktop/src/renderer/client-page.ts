import type {
  ClientCompatibility,
  ClientConfigurationId,
  ClientConfigurationPlanDto,
  ClientConfigurationSnapshotDto,
  ClientConfigurationState,
  ClientSurfaceDto,
  ClientSurfaceId,
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
}> = [
  { id: 'claude-app', title: 'Claude App', mode: '切换式', surfaces: ['claude-app'] },
  { id: 'claude-code', title: 'Claude Code', mode: '切换式', surfaces: ['claude-code'] },
  { id: 'codex-shared', title: 'Codex', mode: '切换式', surfaces: ['codex-app', 'codex-cli'] },
  { id: 'grok-build', title: 'Grok Build', mode: '加法式', surfaces: ['grok-build'] },
];

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
  return `<section class="client-page" aria-labelledby="client-page-title">
  <header class="client-page__header">
    <p class="eyebrow">Agent Clients</p>
    <h1 id="client-page-title">客户端</h1>
    <p>把真实客户端连接到本机 Wrenyard Model Gateway。</p>
  </header>
  <div class="client-page__grid">
${model.cards.map((card) => `    <article class="client-card" data-client-id="${card.id}">
      <header><h2>${escapeHtml(card.title)}</h2><span>${card.connectionMode}</span></header>
      <p class="client-card__status">${escapeHtml(card.status)}</p>
      ${card.surfaces.map((surface) => `<div class="client-surface" data-surface-id="${surface.id}"><strong>${escapeHtml(surface.label)}</strong><span>${escapeHtml(surface.status)}</span><small>${escapeHtml(surface.detail)}</small></div>`).join('')}
      <p class="client-card__models">${card.models.length > 0 ? card.models.map(escapeHtml).join(' · ') : '尚未选择模型'}</p>
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
