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
  /** Optional trusted DOM factory for a provider/model brand icon. */
  icon?: () => HTMLElement;
  badges?: Array<{ kind: 'fast' | 'very-fast' | 'quota' | 'free'; label: string }>;
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
      ...(option.icon !== undefined ? { icon: option.icon } : {}),
      ...(option.badges !== undefined ? { badges: option.badges.map((badge) => ({ ...badge })) } : {}),
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

export interface ThemedTooltipHandle {
  /** Hides the overlay while this binding owns it. */
  hide(): void;
  /** Removes the binding's listeners and hides the overlay if it owns it. */
  detach(): void;
}

/**
 * Shared themed tooltip overlay. One singleton element lives directly under
 * <body> — outside every popup scroller — and is placed with fixed
 * coordinates clamped to the viewport next to its anchor. It renders short
 * multiline plain text, stays hoverable and scrollable while shown, and
 * closes on pointer leave, blur, Escape, outside scrolling and window resize.
 */
class ThemedTooltip {
  private static element: HTMLDivElement | undefined;
  private static owner: ThemedTooltip | undefined;

  /** Hides whichever binding currently owns the overlay. */
  static hide(): void {
    ThemedTooltip.owner?.hideNow();
  }

  private static ensureElement(): HTMLDivElement {
    if (!ThemedTooltip.element) {
      const element = document.createElement('div');
      element.id = 'themed-tooltip';
      element.className = 'themed-tooltip';
      element.setAttribute('role', 'tooltip');
      element.hidden = true;
      element.addEventListener('pointerenter', () => ThemedTooltip.owner?.cancelHide());
      element.addEventListener('pointerleave', () => ThemedTooltip.owner?.hideSoon());
      document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') ThemedTooltip.hide();
      }, true);
      // Any scroll outside the overlay itself (option list, session list,
      // window) detaches a stale anchor; scrolling the overlay keeps it open.
      document.addEventListener('scroll', (event) => {
        const target = event.target;
        if (target instanceof Node && ThemedTooltip.element?.contains(target)) return;
        ThemedTooltip.hide();
      }, true);
      window.addEventListener('resize', () => ThemedTooltip.hide());
      ThemedTooltip.element = element;
    }
    if (!ThemedTooltip.element.isConnected) document.body.append(ThemedTooltip.element);
    return ThemedTooltip.element;
  }

  private hideTimer = 0;

  constructor(
    private readonly target: HTMLElement,
    private readonly text: () => string,
  ) {
    target.addEventListener('pointerenter', this.onEnter);
    target.addEventListener('pointerleave', this.onLeave);
    target.addEventListener('focus', this.onFocus);
    target.addEventListener('blur', this.onBlur);
  }

  private readonly onEnter = (): void => this.show();
  private readonly onLeave = (): void => this.hideSoon();
  private readonly onFocus = (): void => {
    if (this.target.matches(':focus-visible')) this.show();
  };
  private readonly onBlur = (): void => this.hideNow();

  show(): void {
    const text = this.text().trim();
    if (!text) return;
    this.cancelHide();
    if (ThemedTooltip.owner && ThemedTooltip.owner !== this) ThemedTooltip.owner.hideNow();
    ThemedTooltip.owner = this;
    const element = ThemedTooltip.ensureElement();
    element.textContent = text;
    element.hidden = false;
    this.target.setAttribute('aria-describedby', element.id);
    this.position(element);
  }

  hideNow(): void {
    this.cancelHide();
    if (ThemedTooltip.owner !== this) return;
    ThemedTooltip.owner = undefined;
    const element = ThemedTooltip.element;
    if (!element) return;
    element.hidden = true;
    element.textContent = '';
    this.target.removeAttribute('aria-describedby');
  }

  /** Small grace so the pointer can cross the gap into the overlay itself. */
  hideSoon(): void {
    if (this.hideTimer) return;
    this.hideTimer = window.setTimeout(() => {
      this.hideTimer = 0;
      this.hideNow();
    }, 120);
  }

  cancelHide(): void {
    if (!this.hideTimer) return;
    window.clearTimeout(this.hideTimer);
    this.hideTimer = 0;
  }

  /** Unbinds the anchor; the singleton overlay itself stays reusable. */
  detach(): void {
    this.hideNow();
    this.target.removeEventListener('pointerenter', this.onEnter);
    this.target.removeEventListener('pointerleave', this.onLeave);
    this.target.removeEventListener('focus', this.onFocus);
    this.target.removeEventListener('blur', this.onBlur);
  }

  /** Fixed coordinates next to the anchor, clamped inside the viewport. */
  private position(element: HTMLDivElement): void {
    element.style.left = '0px';
    element.style.top = '0px';
    const anchor = this.target.getBoundingClientRect();
    const box = element.getBoundingClientRect();
    const margin = 6;
    const gap = 5;
    const left = Math.max(margin, Math.min(anchor.left, window.innerWidth - box.width - margin));
    const below = anchor.bottom + gap;
    const top = below + box.height <= window.innerHeight - margin
      ? below
      : Math.max(margin, anchor.top - box.height - gap);
    element.style.left = `${Math.round(left)}px`;
    element.style.top = `${Math.round(top)}px`;
  }
}

/** Attaches the shared themed tooltip to one anchor element. */
export function bindThemedTooltip(target: HTMLElement, text: () => string): ThemedTooltipHandle {
  const tooltip = new ThemedTooltip(target, text);
  return {
    hide: (): void => tooltip.hideNow(),
    detach: (): void => tooltip.detach(),
  };
}

/** Hides the shared themed tooltip overlay, whichever anchor owns it. */
export function hideThemedTooltip(): void {
  ThemedTooltip.hide();
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
  private readonly triggerTooltip: ThemedTooltipHandle;
  private triggerTitle = '';
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
    this.trigger.className = 'multi-select-trigger single-select-trigger';
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

    // Themed trigger tooltip: the shared body-level overlay, suppressed while
    // the popup is open because the popup covers the same area. The native
    // `title` bubble is deliberately not used: it renders inert OS chrome
    // outside the theme and flashes abruptly.
    this.triggerTooltip = bindThemedTooltip(this.trigger, () => (this.open ? '' : this.triggerTitle));

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

  /** Themed trigger tooltip text; an empty string hides it and clears the text. */
  setTitle(title: string): void {
    this.triggerTitle = title.trim();
    this.trigger.removeAttribute('title');
    if (!this.triggerTitle) this.triggerTooltip.hide();
  }

  /** aria-label for the popup search box. */
  setSearchLabel(label: string): void {
    this.searchLabel = label;
    this.refreshSearchLabel();
  }

  destroy(): void {
    document.removeEventListener('click', this.onDocumentClick);
    document.removeEventListener('keydown', this.onDocumentKeyDown, true);
    this.triggerTooltip.detach();
    ThemedTooltip.hide();
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
    this.summary.replaceChildren();
    const option = this.options.find((candidate) => candidate.value === this.selected);
    if (option?.icon) this.summary.append(option.icon());
    const label = document.createElement('span');
    label.className = 'single-select-name';
    label.textContent = this.selected.length === 0 ? this.placeholder : this.labelFor(this.selected);
    this.summary.append(label);
    if (option?.badges) this.appendBadges(this.summary, option.badges);
    this.trigger.setAttribute('aria-expanded', this.open ? 'true' : 'false');
  }

  private refreshOptions(): void {
    // Rows are rebuilt: a tooltip still showing for a removed row must not
    // linger. Rows can only be hovered while the popup is open, so the closed
    // popup keeps an open trigger tooltip across background re-renders.
    if (this.open) ThemedTooltip.hide();
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
      if (option.icon) row.append(option.icon());
      const name = document.createElement('span');
      name.className = 'single-select-name';
      name.textContent = option.label;
      label.append(name);
      if (option.badges) this.appendBadges(label, option.badges);
      row.append(label);
      if (option.secondary !== undefined) {
        const secondary = document.createElement('small');
        secondary.className = 'single-select-option-secondary';
        secondary.textContent = option.secondary;
        row.append(secondary);
      }
      // Themed row tooltip (quota details) for pointer hover and keyboard focus
      // instead of the native `title` OS bubble.
      bindThemedTooltip(row, () => option.title ?? option.label);
      if (!option.disabled) row.addEventListener('click', () => this.select(option.value));
      this.optionsList.append(row);
    }
    this.emptyMessage.hidden = filtered.length > 0;
    if (searchFocused) this.searchInput.focus();
  }

  private appendBadges(target: HTMLElement, badges: readonly { kind: 'fast' | 'very-fast' | 'quota' | 'free'; label: string }[]): void {
    for (const badge of badges) {
      const item = document.createElement('span');
      item.className = `single-select-badge ${badge.kind}`;
      item.title = badge.label;
      item.setAttribute('aria-label', badge.label);
      const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      icon.setAttribute('viewBox', '0 0 24 24');
      icon.setAttribute('aria-hidden', 'true');
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      // Monochrome stroke glyphs only; `free` uses the gift/zero-cost outline so
      // it never carries an invented accent color.
      path.setAttribute('d', badge.kind === 'quota'
        ? 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18M8 12l3 3 5-6'
        : badge.kind === 'free'
          ? 'M4 10h16v10H4zM4 10l1.6-3.2h12.8L20 10M12 6.8V20M12 6.8C10 3.2 6.4 3.6 6.4 6.2c0 2 2.4 2.6 5.6.6M12 6.8c2-3.6 5.6-3.2 5.6-.6 0 2-2.4 2.6-5.6.6'
          : 'M13 2 4 14h7l-1 8 10-13h-7z');
      icon.append(path);
      item.append(icon);
      target.append(item);
    }
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
    // The popup covers the trigger tooltip area; only row tooltips remain.
    ThemedTooltip.hide();
    this.refreshOptions();
    this.searchInput.focus();
    this.onOpen?.();
  }

  private close(restoreFocus = false): void {
    if (!this.open) return;
    this.open = false;
    this.popup.hidden = true;
    this.trigger.setAttribute('aria-expanded', 'false');
    ThemedTooltip.hide();
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
