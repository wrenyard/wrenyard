export interface SingleSelectOption {
  value: string;
  label: string;
  /** Secondary copy shown under the label and matched by the search box. */
  secondary?: string;
  /** Tooltip for the option row; falls back to the label. */
  title?: string;
  /** Disabled options stay visible but are skipped by keyboard navigation. */
  disabled?: boolean;
  /** Optional override for the trigger summary while this option is selected. */
  triggerLabel?: string;
}

export interface SearchableSingleSelectConfig {
  options?: readonly SingleSelectOption[];
  selected?: string;
  placeholder?: string;
  label?: string;
  /** Called when the popup opens, e.g. to lazily load options. */
  onOpen?(): void;
  onChange(value: string): void;
}

let popupIdSeq = 0;

function uniqueOptions(options: readonly SingleSelectOption[]): SingleSelectOption[] {
  const seen = new Set<string>();
  const out: SingleSelectOption[] = [];
  for (const option of options) {
    if (seen.has(option.value)) continue;
    seen.add(option.value);
    out.push({
      value: option.value,
      label: option.label,
      ...(option.secondary !== undefined ? { secondary: option.secondary } : {}),
      ...(option.title !== undefined ? { title: option.title } : {}),
      ...(option.disabled ? { disabled: true } : {}),
      ...(option.triggerLabel !== undefined ? { triggerLabel: option.triggerLabel } : {}),
    });
  }
  return out;
}

function matchesQuery(option: SingleSelectOption, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  if (option.label.toLowerCase().includes(needle)) return true;
  if (option.secondary !== undefined && option.secondary.toLowerCase().includes(needle)) return true;
  return option.value.toLowerCase().includes(needle);
}

/**
 * Reusable searchable single-select popup. Reuses the multi-select CSS
 * foundation with single-select-specific selectors. Selecting an option closes
 * the popup and restores focus to the trigger; `setOptions` preserves any
 * search text the user has typed.
 */
export class SearchableSingleSelect {
  private readonly host: HTMLElement;
  private readonly onChange: (value: string) => void;
  private readonly onOpen: (() => void) | undefined;
  private placeholderText: string;
  private readonly trigger: HTMLButtonElement;
  private readonly summary: HTMLSpanElement;
  private readonly popup: HTMLDivElement;
  private readonly searchInput: HTMLInputElement;
  private readonly optionsList: HTMLDivElement;
  private readonly emptyMessage: HTMLDivElement;
  private readonly popupId: string;
  private options: SingleSelectOption[] = [];
  private selected = '';
  private searchQuery = '';
  private searchLabel = '';
  private open = false;
  private loading = false;

  constructor(host: HTMLElement, config: SearchableSingleSelectConfig) {
    this.host = host;
    this.onChange = config.onChange;
    this.onOpen = config.onOpen;
    this.placeholderText = config.placeholder ?? '请选择';
    this.options = uniqueOptions(config.options ?? []);
    this.selected = config.selected ?? '';

    this.popupId = `single-select-popup-${++popupIdSeq}`;

    host.classList.add('multi-select', 'single-select');

    this.trigger = document.createElement('button');
    this.trigger.type = 'button';
    this.summary = document.createElement('span');
    this.trigger.append(this.summary);
    this.trigger.className = 'multi-select-trigger';
    if (config.label !== undefined) this.trigger.setAttribute('aria-label', config.label);
    this.trigger.setAttribute('aria-expanded', 'false');
    this.trigger.setAttribute('aria-controls', this.popupId);
    this.trigger.addEventListener('click', () => {
      if (this.open) this.close();
      else this.show();
    });

    this.popup = document.createElement('div');
    this.popup.id = this.popupId;
    this.popup.className = 'multi-select-popup single-select-popup';
    this.popup.hidden = true;

    this.searchInput = document.createElement('input');
    this.searchInput.type = 'search';
    this.searchInput.className = 'multi-select-search';
    this.searchInput.placeholder = '搜索';
    this.refreshSearchLabel();
    this.searchInput.addEventListener('input', () => {
      this.searchQuery = this.searchInput.value;
      this.refreshOptions();
    });

    this.optionsList = document.createElement('div');
    this.optionsList.className = 'multi-select-options';
    this.optionsList.setAttribute('role', 'listbox');
    this.optionsList.setAttribute('aria-label', config.label ?? this.placeholder);
    this.searchInput.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        this.close(true);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        this.focusRow('last');
        return;
      }
      if (event.key !== 'ArrowDown' && event.key !== 'Home' && event.key !== 'End') return;
      event.preventDefault();
      this.focusRow(event.key === 'ArrowDown' ? 'first' : event.key === 'Home' ? 'first' : 'last');
    });
    this.optionsList.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        this.close(true);
        return;
      }
      if (event.key === 'Tab') {
        this.close(false);
        return;
      }
      if (event.key === 'Enter' || event.key === ' ') {
        const row = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>('button[data-option-value]');
        if (row && !row.disabled) {
          event.preventDefault();
          this.select(row.dataset.optionValue ?? '');
        } else if (this.selectActiveEnabled()) {
          event.preventDefault();
        }
        return;
      }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      this.focusRow(event.key === 'Home' ? 'first'
        : event.key === 'End' ? 'last'
          : event.key === 'ArrowDown' ? 'next' : 'previous');
    });

    this.emptyMessage = document.createElement('div');
    this.emptyMessage.className = 'multi-select-empty';
    this.emptyMessage.textContent = '无匹配项';

    this.popup.append(this.searchInput, this.optionsList, this.emptyMessage);
    host.append(this.trigger, this.popup);

    document.addEventListener('click', this.onDocumentClick);
    document.addEventListener('keydown', this.onDocumentKeyDown, true);

    this.updateTrigger();
    this.refreshOptions();
  }

  setOptions(options: readonly SingleSelectOption[]): void {
    this.options = uniqueOptions(options);
    this.refreshOptions();
    this.updateTrigger();
  }

  set value(value: string) {
    this.selected = value;
    this.refreshOptions();
    this.updateTrigger();
  }

  get value(): string {
    return this.selected;
  }

  /** Placeholder shown on the trigger while nothing is selected. */
  set placeholder(value: string) {
    this.placeholderText = value;
    this.updateTrigger();
  }

  get placeholder(): string {
    return this.placeholderText;
  }

  /** Disables the trigger without changing the rendered selection. */
  setDisabled(disabled: boolean): void {
    this.trigger.disabled = disabled;
  }

  /** Marks the trigger busy; an open popup is closed so stale rows cannot be picked. */
  setLoading(loading: boolean): void {
    this.loading = loading;
    this.trigger.setAttribute('aria-busy', String(loading));
    if (loading) this.close(false);
  }

  /** Trigger tooltip; an empty string removes the attribute. */
  setTitle(title: string): void {
    if (title) this.trigger.title = title;
    else this.trigger.removeAttribute('title');
  }

  /** aria-label for the popup search box. */
  setSearchLabel(label: string): void {
    this.searchLabel = label;
    this.refreshSearchLabel();
  }

  destroy(): void {
    document.removeEventListener('click', this.onDocumentClick);
    document.removeEventListener('keydown', this.onDocumentKeyDown, true);
  }

  private labelFor(value: string): string {
    const option = this.options.find((candidate) => candidate.value === value);
    if (!option) return value;
    return option.triggerLabel ?? option.label;
  }

  private refreshSearchLabel(): void {
    this.searchInput.setAttribute('aria-label', this.searchLabel || `搜索${this.placeholder}`);
  }

  private updateTrigger(): void {
    this.summary.textContent =
      this.selected.length === 0 ? this.placeholder : this.labelFor(this.selected);
    this.trigger.setAttribute('aria-expanded', this.open ? 'true' : 'false');
  }

  private refreshOptions(): void {
    const searchFocused = document.activeElement === this.searchInput;
    const filtered = this.options.filter((option) => matchesQuery(option, this.searchQuery));
    this.optionsList.replaceChildren();
    for (const option of filtered) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'multi-select-option single-select-option';
      row.dataset.optionValue = option.value;
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', option.value === this.selected ? 'true' : 'false');
      if (option.disabled) {
        row.disabled = true;
        row.setAttribute('aria-disabled', 'true');
      }
      const label = document.createElement('span');
      label.className = 'single-select-option-label';
      label.textContent = option.label;
      row.append(label);
      if (option.secondary !== undefined) {
        const secondary = document.createElement('small');
        secondary.className = 'single-select-option-secondary';
        secondary.textContent = option.secondary;
        row.append(secondary);
      }
      row.title = option.title ?? option.label;
      if (!option.disabled) row.addEventListener('click', () => this.select(option.value));
      this.optionsList.append(row);
    }
    this.emptyMessage.hidden = filtered.length > 0;
    if (searchFocused) this.searchInput.focus();
  }

  /** Enabled rows currently rendered, in DOM order. */
  private enabledRows(): HTMLButtonElement[] {
    return Array.from(this.optionsList.querySelectorAll<HTMLButtonElement>('button[data-option-value]'))
      .filter((row) => !row.disabled);
  }

  /** Moves focus across enabled rows only; disabled rows are skipped. */
  private focusRow(direction: 'first' | 'last' | 'next' | 'previous'): void {
    const rows = this.enabledRows();
    if (rows.length === 0) return;
    const current = rows.indexOf(document.activeElement as HTMLButtonElement);
    const index = direction === 'first' ? 0
      : direction === 'last' ? rows.length - 1
        : current < 0 ? (direction === 'next' ? 0 : rows.length - 1)
          : direction === 'next' ? (current + 1) % rows.length : (current - 1 + rows.length) % rows.length;
    rows[index]?.focus();
  }

  /** Selects the active enabled row, or the first one when focus is elsewhere. */
  private selectActiveEnabled(): boolean {
    const rows = this.enabledRows();
    const active = document.activeElement as HTMLButtonElement | null;
    const target = active && rows.includes(active) ? active : rows[0];
    if (!target) return false;
    this.select(target.dataset.optionValue ?? '');
    return true;
  }

  private select(value: string): void {
    const option = this.options.find((candidate) => candidate.value === value);
    if (!option || option.disabled) return;
    this.selected = value;
    this.updateTrigger();
    this.close(true);
    this.onChange(value);
  }

  private show(): void {
    if (this.loading) return;
    this.open = true;
    this.popup.hidden = false;
    this.trigger.setAttribute('aria-expanded', 'true');
    this.refreshOptions();
    this.searchInput.focus();
    this.onOpen?.();
  }

  private close(restoreFocus = false): void {
    if (!this.open) return;
    this.open = false;
    this.popup.hidden = true;
    this.trigger.setAttribute('aria-expanded', 'false');
    if (restoreFocus) this.trigger.focus();
  }

  private readonly onDocumentClick = (event: Event): void => {
    if (!this.open) return;
    if (event.composedPath().includes(this.host)) return;
    const target = event.target;
    if (target instanceof Node && this.host.contains(target)) return;
    this.close();
  };

  private readonly onDocumentKeyDown = (event: KeyboardEvent): void => {
    if (!this.open) return;
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    this.close(true);
  };
}
