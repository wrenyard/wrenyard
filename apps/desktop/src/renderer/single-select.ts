export interface SingleSelectOption {
  value: string;
  label: string;
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
    out.push({ value: option.value, label: option.label });
  }
  return out;
}

function matchesQuery(option: SingleSelectOption, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  if (option.label.toLowerCase().includes(needle)) return true;
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
  private readonly placeholder: string;
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
  private open = false;

  constructor(host: HTMLElement, config: SearchableSingleSelectConfig) {
    this.host = host;
    this.onChange = config.onChange;
    this.onOpen = config.onOpen;
    this.placeholder = config.placeholder ?? '请选择';
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
    this.searchInput.setAttribute('aria-label', `搜索${config.label ?? this.placeholder}`);
    this.searchInput.addEventListener('input', () => {
      this.searchQuery = this.searchInput.value;
      this.refreshOptions();
    });

    this.optionsList = document.createElement('div');
    this.optionsList.className = 'multi-select-options';
    this.optionsList.setAttribute('role', 'listbox');
    this.optionsList.setAttribute('aria-label', config.label ?? this.placeholder);
    this.searchInput.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowDown') return;
      event.preventDefault();
      this.optionsList.querySelector<HTMLButtonElement>('button')?.focus();
    });
    this.optionsList.addEventListener('keydown', (event) => {
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      const rows = Array.from(this.optionsList.querySelectorAll<HTMLButtonElement>('button'));
      if (rows.length === 0) return;
      event.preventDefault();
      const current = rows.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1
        : Math.max(0, Math.min(rows.length - 1, current + (event.key === 'ArrowDown' ? 1 : -1)));
      rows[next]?.focus();
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

  destroy(): void {
    document.removeEventListener('click', this.onDocumentClick);
    document.removeEventListener('keydown', this.onDocumentKeyDown, true);
  }

  private labelFor(value: string): string {
    return this.options.find((option) => option.value === value)?.label ?? value;
  }

  private updateTrigger(): void {
    this.summary.textContent =
      this.selected.length === 0 ? this.placeholder : this.labelFor(this.selected);
  }

  private refreshOptions(): void {
    const searchFocused = document.activeElement === this.searchInput;
    const filtered = this.options.filter((option) => matchesQuery(option, this.searchQuery));
    this.optionsList.replaceChildren();
    for (const option of filtered) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'multi-select-option single-select-option';
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', option.value === this.selected ? 'true' : 'false');
      row.textContent = option.label;
      row.addEventListener('click', () => this.select(option.value));
      this.optionsList.append(row);
    }
    this.emptyMessage.hidden = filtered.length > 0;
    if (searchFocused) this.searchInput.focus();
  }

  private select(value: string): void {
    this.selected = value;
    this.updateTrigger();
    this.close(true);
    this.onChange(value);
  }

  private show(): void {
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
