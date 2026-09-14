import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TaskSettingsInstructionTemplate } from '../src/shell-contract.js';

/**
 * Minimal DOM harness. The desktop test suite runs under plain `tsx --test`
 * with no jsdom, so the preview helper is exercised against a tiny document
 * implementation that supports exactly the node/text APIs the renderer uses.
 */
class FakeText {
  nodeType = 3 as const;
  parentNode: FakeElement | null = null;
  constructor(public textContent: string) {}
}

class FakeElement {
  nodeType = 1 as const;
  childNodes: (FakeElement | FakeText)[] = [];
  attributes: Record<string, string> = {};
  parentNode: FakeElement | null = null;
  constructor(public tagName: string) {}

  get className(): string {
    return this.attributes.class ?? '';
  }

  set className(value: string) {
    this.attributes.class = value;
  }

  get textContent(): string {
    return this.childNodes.map((child) => child.textContent).join('');
  }

  set textContent(value: string) {
    this.childNodes = [new FakeText(value)];
  }

  get title(): string {
    return this.attributes.title ?? '';
  }

  set title(value: string) {
    this.attributes.title = value;
  }

  setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
  }

  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null;
  }

  append(...nodes: (FakeElement | FakeText)[]): void {
    for (const node of nodes) {
      if (node instanceof FakeFragment) {
        this.append(...node.childNodes);
        continue;
      }
      node.parentNode = this;
      this.childNodes.push(node);
    }
  }

  replaceChild(next: FakeElement | FakeText | FakeFragment, previous: FakeElement | FakeText): void {
    const index = this.childNodes.indexOf(previous as never);
    if (index === -1) return;
    const produced = next instanceof FakeFragment
      ? next.childNodes.map((child) => {
          child.parentNode = this;
          return child;
        })
      : [(() => {
          (next as FakeElement | FakeText).parentNode = this;
          return next as FakeElement | FakeText;
        })()];
    this.childNodes.splice(index, 1, ...produced);
    previous.parentNode = null;
  }
}

class FakeFragment {
  childNodes: (FakeElement | FakeText)[] = [];
  append(...nodes: (FakeElement | FakeText)[]): void {
    for (const node of nodes) {
      if (node instanceof FakeFragment) {
        this.append(...node.childNodes);
        continue;
      }
      this.childNodes.push(node);
    }
  }
}

class FakeDocument {
  createElement(tagName: string): FakeElement {
    return new FakeElement(tagName.toLowerCase());
  }

  createTextNode(value: string): FakeText {
    return new FakeText(value);
  }

  createDocumentFragment(): FakeFragment {
    return new FakeFragment();
  }
}

interface GlobalWithDom {
  document?: unknown;
}
(globalThis as GlobalWithDom).document = new FakeDocument();

const { renderInstructionTemplatePreview } = await import('../src/renderer/prompt-template-preview.js');

type Node2 = FakeElement | FakeText | FakeFragment;

function elementChildren(node: FakeElement | FakeFragment): FakeElement[] {
  return node.childNodes.filter((child): child is FakeElement => child instanceof FakeElement);
}

function collectElements(node: FakeElement | FakeFragment): FakeElement[] {
  const found: FakeElement[] = [];
  for (const child of node.childNodes) {
    if (child instanceof FakeElement) {
      found.push(child, ...collectElements(child));
    }
  }
  return found;
}

function render(segments: TaskSettingsInstructionTemplate): FakeFragment {
  return renderInstructionTemplatePreview(segments) as unknown as FakeFragment;
}

test('an inline placeholder stays in the same paragraph as its surrounding text', () => {
  const fragment = render([
    { kind: 'text', source: 'builtin', text: 'You are ' },
    { kind: 'placeholder', source: 'role', label: '<role>' },
    { kind: 'text', source: 'builtin', text: ', a careful assistant.' },
  ]);

  const paragraphs = collectElements(fragment).filter((node) => node.tagName === 'p');
  assert.equal(paragraphs.length, 1);
  const paragraph = paragraphs[0]!;
  // One concatenated paragraph, not three detached blocks.
  assert.equal(paragraph.textContent, 'You are <role>, a careful assistant.');
  const chips = elementChildren(paragraph).filter((child) => child.className === 'tasks-preview-placeholder');
  assert.equal(chips.length, 1);
  assert.equal(chips[0]!.textContent, '<role>');
  assert.equal(chips[0]!.getAttribute('title'), 'role');
});

test('multiline fragments preserve paragraphs and headings', () => {
  const fragment = render([
    { kind: 'text', source: 'builtin', text: '## Heading\n\nFirst paragraph.\n\n- one\n- two' },
  ]);

  const tags = collectElements(fragment).map((node) => node.tagName);
  assert.deepEqual(tags, ['h3', 'p', 'ul', 'li', 'ul', 'li']);
  assert.equal(collectElements(fragment).find((node) => node.tagName === 'p')!.textContent, 'First paragraph.');
});

test('hostile HTML in static text remains inert text', () => {
  const fragment = render([
    { kind: 'text', source: 'builtin', text: '<img src=x onerror="alert(1)">' },
  ]);

  const elements = collectElements(fragment);
  const injected = elements.filter((node) => node.tagName === 'img' || node.tagName === 'script');
  assert.equal(injected.length, 0);
  assert.equal(collectElements(fragment).find((node) => node.tagName === 'p')!.textContent, '<img src=x onerror="alert(1)">');
});

test('adjacent placeholders do not merge into one chip', () => {
  const fragment = render([
    { kind: 'placeholder', source: 'first', label: '<a>' },
    { kind: 'placeholder', source: 'second', label: '<b>' },
  ]);

  const chips = collectElements(fragment).filter((node) => node.className === 'tasks-preview-placeholder');
  assert.equal(chips.length, 2);
  assert.deepEqual(chips.map((chip) => chip.textContent), ['<a>', '<b>']);
  assert.deepEqual(chips.map((chip) => chip.getAttribute('title')), ['first', 'second']);
});

test('placeholder-like tokens in static text cannot collide with real placeholders', () => {
  const fragment = render([
    { kind: 'text', source: 'builtin', text: 'Literal `{{role}}` stays literal. ' },
    { kind: 'placeholder', source: 'role', label: '<role>' },
  ]);

  const chips = collectElements(fragment).filter((node) => node.className === 'tasks-preview-placeholder');
  assert.equal(chips.length, 1);
  const paragraph = collectElements(fragment).find((node) => node.tagName === 'p')!;
  assert.equal(paragraph.textContent, 'Literal {{role}} stays literal. <role>');
});
