import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { SearchableMultiSelect, type MultiSelectOption } from '../src/renderer/multi-select.js';

type Listener = (event: FakeEvent) => void;

interface FakeEvent {
  type: string;
  target: FakeElement | null;
  key?: string;
  stopPropagation(): void;
}

interface FakeElement {
  tagName: string;
  children: FakeElement[];
  className: string;
  classList: { add(...names: string[]): void; contains(name: string): boolean };
  id: string;
  type: string;
  value: string;
  checked: boolean;
  hidden: boolean;
  textContent: string;
  parentNode: FakeElement | null;
  append(...nodes: FakeElement[]): void;
  appendChild(node: FakeElement): FakeElement;
  replaceChildren(...nodes: FakeElement[]): void;
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  removeAttribute(name: string): void;
  contains(node: unknown): boolean;
  focus(): void;
  addEventListener(type: string, listener: Listener): void;
  dispatchEvent(event: FakeEvent): boolean;
  querySelector(selector: string): FakeElement | null;
  querySelectorAll(selector: string): FakeElement[];
}

function fakeElement(tagName: string): FakeElement {
  const attrs = new Map<string, string>();
  const listeners = new Map<string, Listener[]>();
  const element: FakeElement = {
    tagName,
    children: [],
    className: '',
    classList: {
      add(...names: string[]) {
        const classes = new Set(element.className.split(/\s+/).filter(Boolean));
        for (const name of names) classes.add(name);
        element.className = [...classes].join(' ');
      },
      contains(name: string) {
        return element.className.split(/\s+/).includes(name);
      },
    },
    id: '',
    type: '',
    value: '',
    checked: false,
    hidden: false,
    textContent: '',
    parentNode: null,
    append(...nodes: FakeElement[]) {
      for (const node of nodes) element.appendChild(node);
    },
    appendChild(node: FakeElement) {
      node.parentNode = element;
      element.children.push(node);
      return node;
    },
    replaceChildren(...nodes: FakeElement[]) {
      for (const child of element.children) child.parentNode = null;
      element.children = [];
      element.append(...nodes);
    },
    setAttribute(name, value) {
      if (name === 'id') element.id = value;
      if (name === 'hidden') element.hidden = true;
      attrs.set(name, value);
    },
    getAttribute(name) {
      if (name === 'id' && element.id) return element.id;
      return attrs.get(name) ?? null;
    },
    hasAttribute(name) {
      if (name === 'hidden') return element.hidden;
      return attrs.has(name);
    },
    removeAttribute(name) {
      if (name === 'hidden') element.hidden = false;
      attrs.delete(name);
    },
    contains(node) {
      if (node === element) return true;
      return element.children.some((child) => child.contains(node));
    },
    focus() {
      activeElement = element;
    },
    addEventListener(type, listener) {
      const list = listeners.get(type) ?? [];
      list.push(listener);
      listeners.set(type, list);
    },
    dispatchEvent(event) {
      event.target = element;
      for (const listener of listeners.get(event.type) ?? []) listener(event);
      return true;
    },
    querySelector(selector) {
      return element.querySelectorAll(selector)[0] ?? null;
    },
    querySelectorAll(selector) {
      const matches: FakeElement[] = [];
      const visit = (node: FakeElement): void => {
        if (matchesSelector(node, selector)) matches.push(node);
        for (const child of node.children) visit(child);
      };
      for (const child of element.children) visit(child);
      return matches;
    },
  };
  return element;
}

function matchesSelector(node: FakeElement, selector: string): boolean {
  if (selector.startsWith('.')) {
    return node.className.split(/\s+/).includes(selector.slice(1));
  }
  if (selector === 'input' || selector === 'button' || selector === 'span') {
    return node.tagName === selector;
  }
  return false;
}

const documentListeners = new Map<string, { listener: Listener; capture: boolean }[]>();
let activeElement: FakeElement | null = null;

function installDom(): void {
  documentListeners.clear();
  activeElement = null;
  (globalThis as { document?: unknown }).document = {
    createElement: (tag: string) => fakeElement(tag),
    addEventListener(type: string, listener: Listener, capture?: boolean | { capture?: boolean }) {
      const useCapture = typeof capture === 'object' ? Boolean(capture.capture) : Boolean(capture);
      const list = documentListeners.get(type) ?? [];
      list.push({ listener, capture: useCapture });
      documentListeners.set(type, list);
    },
    removeEventListener(type: string, listener: Listener, capture?: boolean | { capture?: boolean }) {
      const useCapture = typeof capture === 'object' ? Boolean(capture.capture) : Boolean(capture);
      documentListeners.set(
        type,
        (documentListeners.get(type) ?? []).filter(
          (entry) => entry.listener !== listener || entry.capture !== useCapture,
        ),
      );
    },
    get activeElement() {
      return activeElement;
    },
  };
}

function event(type: string): FakeEvent {
  return { type, target: null, stopPropagation() {} };
}

function createWidget(
  options: readonly MultiSelectOption[],
  selected: readonly string[] = [],
  onChange: (values: string[]) => void = () => {},
): { host: FakeElement; widget: SearchableMultiSelect } {
  const host = fakeElement('div');
  const widget = new SearchableMultiSelect(host as unknown as HTMLElement, {
    label: '选择项',
    options,
    selected,
    onChange,
  });
  return { host, widget };
}

function optionRows(host: FakeElement): FakeElement[] {
  return host.querySelectorAll('.multi-select-option');
}

function rowLabel(row: FakeElement): string {
  return row.querySelector('span')?.textContent ?? '';
}

function rowCheckbox(row: FakeElement): FakeElement {
  const checkbox = row.querySelector('input');
  assert.ok(checkbox);
  return checkbox;
}

function visibleLabels(host: FakeElement): string[] {
  return optionRows(host).map(rowLabel);
}

function toggleRow(host: FakeElement, value: string, checked: boolean): void {
  const row = optionRows(host).find((item) => rowCheckbox(item).value === value);
  assert.ok(row, `missing option ${value}`);
  const checkbox = rowCheckbox(row);
  checkbox.checked = checked;
  checkbox.dispatchEvent(event('change'));
}

installDom();

afterEach(() => {
  installDom();
});

test('search matches option labels and partial IDs case-insensitively', () => {
  const { host } = createWidget([
    { value: 'id-1', label: 'Alpha' },
    { value: 'xyz', label: 'Beta' },
  ]);
  const search = host.querySelector('.multi-select-search');
  assert.ok(search);

  search.value = 'alp';
  search.dispatchEvent(event('input'));
  assert.deepEqual(visibleLabels(host), ['Alpha']);

  search.value = 'ID-1';
  search.dispatchEvent(event('input'));
  assert.deepEqual(visibleLabels(host), ['Alpha']);

  search.value = 'id';
  search.dispatchEvent(event('input'));
  assert.deepEqual(visibleLabels(host), ['Alpha']);

  search.value = 'BETA';
  search.dispatchEvent(event('input'));
  assert.deepEqual(visibleLabels(host), ['Beta']);
});

test('selection persists across filtering', () => {
  const { host, widget } = createWidget([
    { value: 'a', label: 'Alpha' },
    { value: 'b', label: 'Beta' },
    { value: 'c', label: 'Gamma' },
  ]);
  toggleRow(host, 'a', true);

  const search = host.querySelector('.multi-select-search');
  assert.ok(search);
  search.value = 'beta';
  search.dispatchEvent(event('input'));
  assert.deepEqual(visibleLabels(host), ['Beta']);
  toggleRow(host, 'b', true);

  search.value = '';
  search.dispatchEvent(event('input'));
  assert.deepEqual(visibleLabels(host), ['Alpha', 'Beta', 'Gamma']);
  assert.deepEqual(widget.getSelected(), ['a', 'b']);
  assert.equal(rowCheckbox(optionRows(host)[0]!).checked, true);
  assert.equal(rowCheckbox(optionRows(host)[1]!).checked, true);
});

test('unknown selected IDs survive setOptions and remain removable', () => {
  const changes: string[][] = [];
  const { host, widget } = createWidget([{ value: 'a', label: 'Alpha' }], ['ghost', 'a'], (values) => {
    changes.push(values);
  });

  widget.setOptions([{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'Beta' }]);
  assert.deepEqual(widget.getSelected(), ['ghost', 'a']);
  assert.deepEqual(visibleLabels(host), ['Alpha', 'Beta', 'ghost']);
  assert.equal(changes.length, 0);

  const search = host.querySelector('.multi-select-search');
  assert.ok(search);
  search.value = 'ghost';
  search.dispatchEvent(event('input'));
  assert.deepEqual(visibleLabels(host), ['ghost']);

  toggleRow(host, 'ghost', false);
  assert.deepEqual(widget.getSelected(), ['a']);
  assert.deepEqual(changes.at(-1), ['a']);
});

test('setters do not call onChange', () => {
  const { widget } = createWidget([{ value: 'a', label: 'Alpha' }], [], () => {
    assert.fail('onChange should not run for setters');
  });
  widget.setOptions([{ value: 'b', label: 'Beta' }]);
  widget.setSelected(['b', 'orphan']);
  assert.deepEqual(widget.getSelected(), ['b', 'orphan']);
});

test('user toggles emit exact selected IDs', () => {
  const changes: string[][] = [];
  const { host, widget } = createWidget(
    [
      { value: 'a', label: 'Alpha' },
      { value: 'b', label: 'Beta' },
    ],
    ['a'],
    (values) => {
      changes.push(values);
    },
  );

  toggleRow(host, 'b', true);
  toggleRow(host, 'a', false);
  assert.deepEqual(changes, [
    ['a', 'b'],
    ['b'],
  ]);
  assert.deepEqual(widget.getSelected(), ['b']);
});


test('opening focuses search and toggling preserves the focused checkbox and open menu', () => {
  const { host, widget } = createWidget([{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'Beta' }]);
  const trigger = host.querySelector('.multi-select-trigger')!;
  const search = host.querySelector('.multi-select-search')!;
  trigger.dispatchEvent(event('click'));
  assert.equal(activeElement, search);
  const checkbox = rowCheckbox(optionRows(host)[0]!);
  checkbox.focus();
  toggleRow(host, 'a', true);
  assert.equal(rowCheckbox(optionRows(host)[0]!), checkbox);
  assert.equal(activeElement, checkbox);
  assert.equal(trigger.getAttribute('aria-expanded'), 'true');
  assert.deepEqual(widget.getSelected(), ['a']);
  let stopped = false;
  for (const { listener } of documentListeners.get('keydown') ?? []) {
    listener({ type: 'keydown', target: checkbox, key: 'Escape', stopPropagation() { stopped = true; } });
  }
  assert.equal(stopped, true);
  assert.equal(trigger.getAttribute('aria-expanded'), 'false');
  assert.equal(activeElement, trigger);
});
