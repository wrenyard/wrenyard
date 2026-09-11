export interface MultiSelectOption {
  value: string;
  label: string;
}

export interface SearchableMultiSelectConfig {
  label: string;
  options?: readonly MultiSelectOption[];
  selected?: readonly string[];
  onChange(values: string[]): void;
}

let popupIdSeq = 0;

function uniqueIds(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function uniqueOptions(options: readonly MultiSelectOption[]): MultiSelectOption[] {
  const seen = new Set<string>();
  const out: MultiSelectOption[] = [];
  for (const option of options) {
    if (seen.has(option.value)) continue;
    seen.add(option.value);
    out.push({ value: option.value, label: option.label });
  }
  return out;
}

function matchesQuery(option: MultiSelectOption, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  if (option.label.toLowerCase().includes(needle)) return true;
  return option.value.toLowerCase().includes(needle);
}

export class SearchableMultiSelect {
  private readonly host: HTMLElement;
  private readonly onChange: (values: string[]) => void;
  private readonly trigger: HTMLButtonElement;
  private readonly summary: HTMLSpanElement;
  private readonly popup: HTMLDivElement;
  private readonly searchInput: HTMLInputElement;
  private readonly optionsList: HTMLDivElement;
  private readonly emptyMessage: HTMLDivElement;
  private readonly popupId: string;
  private options: MultiSelectOption[] = [];
  private selected: string[] = [];
  private searchQuery = '';
  private open = false;

  constructor(host: HTMLElement, config: SearchableMultiSelectConfig) {
    this.host = host;
    this.onChange = config.onChange;
    this.options = uniqueOptions(config.options ?? []);
    this.selected = uniqueIds(config.selected ?? []);

    this.popupId = `multi-select-popup-${++popupIdSeq}`;

    host.classList.add('multi-select');

    this.trigger = document.createElement('button');
    this.trigger.type = 'button';
    this.summary = document.createElement('span');
    this.trigger.append(this.summary);
    this.trigger.className = 'multi-select-trigger';
    this.trigger.setAttribute('aria-label', config.label);
    this.trigger.setAttribute('aria-expanded', 'false');
    this.trigger.setAttribute('aria-controls', this.popupId);
    this.trigger.addEventListener('click', () => {
      if (this.open) this.close();
      else this.show();
    });

    this.popup = document.createElement('div');
    this.popup.id = this.popupId;
    this.popup.className = 'multi-select-popup';
    this.popup.hidden = true;

    this.searchInput = document.createElement('input');
    this.searchInput.type = 'search';
    this.searchInput.className = 'multi-select-search';
    this.searchInput.placeholder = '搜索';
    this.searchInput.setAttribute('aria-label', `搜索${config.label}`);
    this.searchInput.addEventListener('input', () => {
      this.searchQuery = this.searchInput.value;
      this.refreshOptions();
    });

    this.optionsList = document.createElement('div');
    this.optionsList.className = 'multi-select-options';

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

  setOptions(options: readonly MultiSelectOption[]): void {
    this.options = uniqueOptions(options);
    this.refreshOptions();
    this.updateTrigger();
  }

  setSelected(values: readonly string[]): void {
    this.selected = uniqueIds(values);
    this.refreshOptions();
    this.updateTrigger();
  }

  getSelected(): string[] {
    return [...this.selected];
  }

  destroy(): void {
    document.removeEventListener('click', this.onDocumentClick);
    document.removeEventListener('keydown', this.onDocumentKeyDown, true);
  }

  private labelFor(value: string): string {
    return this.options.find((option) => option.value === value)?.label ?? value;
  }

  private visibleOptions(): MultiSelectOption[] {
    const known = new Set(this.options.map((option) => option.value));
    const extras = this.selected
      .filter((value) => !known.has(value))
      .map((value) => ({ value, label: value }));
    return [...this.options, ...extras];
  }

  private updateTrigger(): void {
    if (this.selected.length === 0) {
      this.summary.textContent = '请选择';
      return;
    }
    const firstLabel = this.labelFor(this.selected[0]!);
    if (this.selected.length === 1) {
      this.summary.textContent = firstLabel;
      return;
    }
    this.summary.textContent = `${firstLabel} +${this.selected.length - 1}`;
  }

  private refreshOptions(): void {
    const searchFocused = document.activeElement === this.searchInput;
    const filtered = this.visibleOptions().filter((option) =>
      matchesQuery(option, this.searchQuery),
    );
    this.optionsList.replaceChildren();
    for (const option of filtered) {
      const row = document.createElement('label');
      row.className = 'multi-select-option';

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.value = option.value;
      checkbox.checked = this.selected.includes(option.value);
      checkbox.addEventListener('change', () => {
        this.toggle(option.value, checkbox.checked);
      });

      const text = document.createElement('span');
      text.textContent = option.label;

      row.append(checkbox, text);
      this.optionsList.append(row);
    }
    this.emptyMessage.hidden = filtered.length > 0;
    if (searchFocused) this.searchInput.focus();
  }

  private toggle(value: string, checked: boolean): void {
    if (checked) {
      if (!this.selected.includes(value)) this.selected.push(value);
    } else {
      this.selected = this.selected.filter((id) => id !== value);
    }
    this.onChange([...this.selected]);
    this.updateTrigger();
    // Keep the active checkbox mounted for consecutive clicks and keyboard toggles.
  }

  private show(): void {
    this.open = true;
    this.popup.hidden = false;
    this.trigger.setAttribute('aria-expanded', 'true');
    this.refreshOptions();
    this.searchInput.focus();
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
