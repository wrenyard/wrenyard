import type { SummarySettingsSnapshot, WrenyardShellApi } from '../shell-contract.js';
import { SearchableSingleSelect } from './single-select.js';

/**
 * Settings-page control for the conversation summary model.
 *
 * Owns only the reusable searchable single-select and its save wiring against
 * the existing typed summary-settings API. The catalog option list is the
 * backend projection SSOT (`getSummarySettings`), never a locally recomputed
 * catalog. A selected canonical model without a usable ordinary-LLM provider is
 * surfaced as an explicit warning rather than silently substituted.
 */
export interface SummarySettingsApi {
  getSummarySettings(): Promise<SummarySettingsSnapshot>;
  saveSummaryModel(canonicalModel: string): Promise<SummarySettingsSnapshot>;
}

/** Error text stripped of the Electron IPC prefix, matching sibling renderers. */
export function summarySettingsErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message.replace(/^Error invoking remote method '[^']+': Error: /, '');
  }
  return String(error);
}

export class SummaryModelSettings {
  private readonly select: SearchableSingleSelect;
  private readonly status: HTMLElement;
  private readonly warning: HTMLElement;
  private snapshot: SummarySettingsSnapshot | null = null;
  private busy = false;

  constructor(
    private readonly host: HTMLElement,
    private readonly api: SummarySettingsApi,
  ) {
    const row = document.createElement('div');
    row.className = 'setting-row setting-row-stacked';
    const copy = document.createElement('div');
    const heading = document.createElement('h3');
    heading.textContent = '摘要模型';
    const hint = document.createElement('p');
    hint.textContent = '用于生成工作完成后的最终回复。';
    copy.append(heading, hint);

    const selectHost = document.createElement('div');
    selectHost.id = 'summary-model-select';
    selectHost.className = 'summary-model-select-host';

    this.select = new SearchableSingleSelect(selectHost, {
      placeholder: '选择摘要模型',
      label: '摘要模型',
      onChange: (value) => void this.save(value),
    });

    this.warning = document.createElement('p');
    this.warning.className = 'routing-weights-status is-error';
    this.warning.setAttribute('role', 'alert');
    this.warning.hidden = true;

    this.status = document.createElement('p');
    this.status.className = 'routing-weights-status';
    this.status.setAttribute('role', 'status');

    row.append(copy, selectHost, this.warning, this.status);
    this.host.replaceChildren(row);
  }

  /** Reads the authoritative option list and selected canonical model. */
  async load(): Promise<void> {
    this.select.setLoading(true);
    try {
      const snapshot = await this.api.getSummarySettings();
      this.apply(snapshot);
    } catch (error) {
      this.status.classList.add('is-error');
      this.status.textContent = `读取失败：${summarySettingsErrorMessage(error)}`;
    } finally {
      this.select.setLoading(false);
    }
  }

  private apply(snapshot: SummarySettingsSnapshot): void {
    this.snapshot = snapshot;
    this.select.setOptions(snapshot.options.map((option) => ({
      value: option.canonicalModel,
      label: option.displayName,
      ...(option.providerLabel !== undefined ? { secondary: option.providerLabel } : {}),
      ...(option.available ? {} : { disabled: true }),
    })));
    // Preserve an unresolved-but-selected canonical id so the warning is honest.
    this.select.value = snapshot.selectedCanonicalModel;
    if (snapshot.unresolved) {
      this.warning.hidden = false;
      this.warning.textContent = '所选模型当前没有可用供应商。';
    } else {
      this.warning.hidden = true;
      this.warning.textContent = '';
    }
    if (snapshot.message) {
      this.status.classList.add('is-error');
      this.status.textContent = snapshot.message;
    } else if (this.busy) {
      this.status.classList.remove('is-error');
      this.status.textContent = '已保存';
    }
  }

  private async save(canonicalModel: string): Promise<void> {
    if (this.busy || this.snapshot?.selectedCanonicalModel === canonicalModel) return;
    this.busy = true;
    this.status.classList.remove('is-error');
    this.status.textContent = '正在保存…';
    try {
      const snapshot = await this.api.saveSummaryModel(canonicalModel);
      this.apply(snapshot);
      this.snapshot = { ...snapshot };
      this.status.classList.toggle('is-error', snapshot.unresolved);
      if (!snapshot.unresolved) this.status.textContent = '已保存';
    } catch (error) {
      this.status.classList.add('is-error');
      this.status.textContent = `保存失败：${summarySettingsErrorMessage(error)}`;
      await this.load().catch(() => undefined);
    } finally {
      this.busy = false;
    }
  }
}

/** Convenience factory used by the renderer entry. */
export function createSummaryModelSettings(host: HTMLElement, api: WrenyardShellApi): SummaryModelSettings {
  const settings = new SummaryModelSettings(host, api);
  return settings;
}
