import { SCORE_WEIGHTS } from '@wrenyard/catalog';
import type {
  TaskSettingsRoutingWeights,
  TaskSettingsSaveRequest,
  TaskSettingsSnapshot,
} from '../shell-contract.js';

/**
 * Compact reusable global routing-weights control.
 *
 * This module owns ONLY the four percent inputs and their save/reset wiring. It
 * reads and writes the optional global `routing_weights` override through the
 * existing typed settings API (no new IPC). It never autosaves and never touches
 * any other settings field.
 */

/** The minimal settings-API surface this control needs (DesktopShellApi-compatible). */
export interface RoutingWeightsSettingsApi {
  getTaskSettings(project?: string, taskId?: string): Promise<TaskSettingsSnapshot>;
  saveTaskSettings(request: TaskSettingsSaveRequest): Promise<TaskSettingsSnapshot>;
}

/** The four editable weight fields, in the fixed display order. */
export const ROUTING_WEIGHT_KEYS = ['price', 'speed', 'quota', 'intelligence'] as const;
export type RoutingWeightKey = (typeof ROUTING_WEIGHT_KEYS)[number];

/** Percent labels: 价格 / 速度 / 额度 / 智能. */
export const ROUTING_WEIGHT_LABELS: Record<RoutingWeightKey, string> = {
  price: '价格',
  speed: '速度',
  quota: '额度',
  intelligence: '智能',
};

/** Percent value per field, keyed by the wire field name. */
export interface RoutingWeightsPercent {
  price: number;
  speed: number;
  quota: number;
  intelligence: number;
}

const PERCENT_SUM = 100;

/**
 * SSOT default percent weights (40/30/20/10) derived from the Catalog
 * `SCORE_WEIGHTS` fractions. `P`→价格, `S`→速度, `Q`→额度, `I`→智能.
 */
export function defaultRoutingWeightsPercent(): RoutingWeightsPercent {
  return {
    price: SCORE_WEIGHTS.P * PERCENT_SUM,
    speed: SCORE_WEIGHTS.S * PERCENT_SUM,
    quota: SCORE_WEIGHTS.Q * PERCENT_SUM,
    intelligence: SCORE_WEIGHTS.I * PERCENT_SUM,
  };
}

/**
 * Parses and validates one percent input. Rejects empty/non-numeric/non-finite
 * values and anything outside the integer range 0..100.
 */
export function parseRoutingWeightPercent(text: string): number {
  const trimmed = text.trim();
  if (trimmed.length === 0) throw new Error('请输入百分比数值');
  const value = Number(trimmed);
  if (!Number.isFinite(value)) throw new Error('请输入有效数值');
  if (value < 0 || value > 100) throw new Error('数值需在 0 到 100 之间');
  return value;
}

/**
 * Parses all four raw inputs into a validated percent set. Throws on any
 * malformed field or when the four values do not sum to exactly 100.
 */
export function parseRoutingWeightsInput(input: Record<RoutingWeightKey, string>): RoutingWeightsPercent {
  const parsed = {} as RoutingWeightsPercent;
  for (const key of ROUTING_WEIGHT_KEYS) {
    parsed[key] = parseRoutingWeightPercent(input[key]);
  }
  const total = parsed.price + parsed.speed + parsed.quota + parsed.intelligence;
  if (total !== PERCENT_SUM) throw new Error(`四项权重之和必须为 100（当前 ${total}）`);
  return parsed;
}

/** Converts a validated percent set into the fraction wire shape. */
export function routingWeightsFromPercent(percent: RoutingWeightsPercent): TaskSettingsRoutingWeights {
  return {
    price: percent.price / PERCENT_SUM,
    speed: percent.speed / PERCENT_SUM,
    quota: percent.quota / PERCENT_SUM,
    intelligence: percent.intelligence / PERCENT_SUM,
  };
}

/** Converts a stored override (or missing override) into percent form. */
export function routingWeightsToPercent(
  weights: TaskSettingsRoutingWeights | null | undefined,
): RoutingWeightsPercent {
  if (weights === null || weights === undefined) return defaultRoutingWeightsPercent();
  return {
    price: weights.price * PERCENT_SUM,
    speed: weights.speed * PERCENT_SUM,
    quota: weights.quota * PERCENT_SUM,
    intelligence: weights.intelligence * PERCENT_SUM,
  };
}

/** Error text stripped of the Electron IPC prefix, matching sibling renderers. */
export function routingWeightsErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message.replace(/^Error invoking remote method '[^']+': Error: /, '');
  }
  return String(error);
}

const CONFLICT_MESSAGE = '保存冲突：已刷新到最新配置，你填写的值仍保留，请核对后重新保存。';

/**
 * Owns the four-input form lifecycle: load the global override (or defaults),
 * save the full four values, and reset the override to `null`.
 */
export class RoutingWeightsSettings {
  private revision = '';
  private busy = false;
  private readonly inputs: Record<RoutingWeightKey, HTMLInputElement>;
  private readonly saveButton: HTMLButtonElement;
  private readonly resetButton: HTMLButtonElement;
  private readonly total: HTMLElement;
  private readonly status: HTMLElement;

  constructor(
    private readonly host: HTMLElement,
    private readonly api: RoutingWeightsSettingsApi,
  ) {
    const form = document.createElement('form');
    form.className = 'routing-weights-form';
    form.setAttribute('aria-label', '路由权重');

    this.inputs = {} as Record<RoutingWeightKey, HTMLInputElement>;
    for (const key of ROUTING_WEIGHT_KEYS) {
      const field = document.createElement('label');
      field.className = 'routing-weights-field';
      const caption = document.createElement('span');
      caption.textContent = ROUTING_WEIGHT_LABELS[key];
      const unit = document.createElement('span');
      unit.className = 'routing-weights-unit';
      const input = document.createElement('input');
      input.type = 'number';
      input.min = '0';
      input.max = '100';
      input.step = '1';
      input.className = 'routing-weights-input';
      input.dataset.weight = key;
      input.setAttribute('aria-describedby', 'routing-weights-total');
      const suffix = document.createElement('span');
      suffix.textContent = '%';
      suffix.setAttribute('aria-hidden', 'true');
      this.inputs[key] = input;
      unit.append(input, suffix);
      field.append(caption, unit);
      form.append(field);
    }

    const actions = document.createElement('div');
    actions.className = 'routing-weights-actions';
    this.saveButton = document.createElement('button');
    this.saveButton.type = 'button';
    this.saveButton.textContent = '保存';
    this.resetButton = document.createElement('button');
    this.resetButton.type = 'button';
    this.resetButton.textContent = '恢复默认';
    actions.append(this.saveButton, this.resetButton);

    this.total = document.createElement('p');
    this.total.className = 'routing-weights-total';
    this.total.id = 'routing-weights-total';
    this.total.setAttribute('role', 'status');

    this.status = document.createElement('p');
    this.status.className = 'routing-weights-status';
    this.status.setAttribute('role', 'status');

    form.append(actions, this.total, this.status);
    this.host.replaceChildren(form);

    for (const key of ROUTING_WEIGHT_KEYS) {
      this.inputs[key].addEventListener('input', () => this.updateTotal());
    }
    this.updateTotal();

    form.addEventListener('submit', (event) => event.preventDefault());
    this.saveButton.addEventListener('click', () => void this.save());
    this.resetButton.addEventListener('click', () => void this.reset());
  }

  /** Applies percent values to the four inputs (also restores the user draft). */
  private applyPercent(percent: RoutingWeightsPercent): void {
    for (const key of ROUTING_WEIGHT_KEYS) {
      this.inputs[key].value = String(percent[key]);
    }
    this.updateTotal();
  }

  /** Live sum feedback only; validation on save is unchanged (sum must be 100). */
  private updateTotal(): void {
    const sum = ROUTING_WEIGHT_KEYS.reduce((acc, key) => {
      const value = Number(this.inputs[key].value);
      return acc + (Number.isFinite(value) ? value : 0);
    }, 0);
    const rounded = Math.round(sum);
    this.total.textContent = `当前合计 ${rounded}%`;
    this.total.classList.toggle('is-error', rounded !== PERCENT_SUM);
  }

  /** Reads the current raw input values. */
  private readInput(): Record<RoutingWeightKey, string> {
    const raw = {} as Record<RoutingWeightKey, string>;
    for (const key of ROUTING_WEIGHT_KEYS) raw[key] = this.inputs[key].value;
    return raw;
  }

  private setBusy(busy: boolean): void {
    this.busy = busy;
    this.saveButton.disabled = busy;
    this.resetButton.disabled = busy;
    this.saveButton.textContent = busy ? '保存中…' : '保存';
  }

  private setStatus(text: string, isError = false): void {
    this.status.textContent = text;
    this.status.classList.toggle('is-error', isError);
  }

  /**
   * Reads the global settings layer and fills the form. A failed load is
   * surfaced and the current draft is left untouched (defaults when empty).
   */
  async load(): Promise<void> {
    try {
      const snapshot = await this.api.getTaskSettings();
      this.revision = snapshot.revision;
      this.applyPercent(routingWeightsToPercent(snapshot.user_global.routing_weights));
      this.setStatus('');
    } catch (error) {
      this.setStatus(`读取失败：${routingWeightsErrorMessage(error)}`, true);
    }
  }

  /**
   * Validates the four inputs and saves the full override at global scope.
   * Disabled while in flight; a CAS conflict refreshes the revision but keeps
   * the user's draft for an explicit re-save.
   */
  async save(): Promise<void> {
    if (this.busy) return;
    let patch: TaskSettingsRoutingWeights;
    try {
      patch = routingWeightsFromPercent(parseRoutingWeightsInput(this.readInput()));
    } catch (error) {
      this.setStatus(routingWeightsErrorMessage(error), true);
      return;
    }
    this.setBusy(true);
    this.setStatus('');
    try {
      const snapshot = await this.api.saveTaskSettings({
        scope: 'global',
        expected_revision: this.revision,
        patch: { routing_weights: patch },
      });
      this.revision = snapshot.revision;
      this.setStatus('已保存');
    } catch (error) {
      // Refresh the authoritative revision but never wipe the typed draft.
      const refreshed = await this.api.getTaskSettings().catch(() => null);
      if (refreshed !== null) this.revision = refreshed.revision;
      this.setStatus(`${CONFLICT_MESSAGE}\n${routingWeightsErrorMessage(error)}`, true);
    } finally {
      this.setBusy(false);
    }
  }

  /**
   * Clears the optional global override (patch `routing_weights: null`), so
   * routing falls back to the SSOT defaults, and restores the default percents.
   */
  async reset(): Promise<void> {
    if (this.busy) return;
    this.setBusy(true);
    this.setStatus('');
    try {
      const snapshot = await this.api.saveTaskSettings({
        scope: 'global',
        expected_revision: this.revision,
        patch: { routing_weights: null },
      });
      this.revision = snapshot.revision;
      this.applyPercent(defaultRoutingWeightsPercent());
      this.setStatus('已恢复默认');
    } catch (error) {
      const refreshed = await this.api.getTaskSettings().catch(() => null);
      if (refreshed !== null) this.revision = refreshed.revision;
      this.setStatus(`恢复失败：${routingWeightsErrorMessage(error)}`, true);
    } finally {
      this.setBusy(false);
    }
  }
}
