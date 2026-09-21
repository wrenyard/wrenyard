import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ProviderCatalogSnapshot, ProviderModelSnapshot, QuotaSnapshot } from '../src/shell-contract.js';
import {
  averageMeasuredTps,
  buildModelListRows,
  classifyFamily,
  formatPriceRange,
  providerBrand,
  renderModelList,
} from '../src/renderer/model-list.js';

interface FakeElement {
  tagName: string;
  children: FakeElement[];
  textContent: string;
  className: string;
  title: string;
  colSpan: number;
  scope: string;
  src: string;
  alt: string;
  width: number;
  height: number;
  dataset: Record<string, string>;
  append(...nodes: unknown[]): void;
  replaceChildren(...nodes: unknown[]): void;
  setAttribute(name: string, value: string): void;
}

function fakeElement(tagName: string): FakeElement {
  const element: FakeElement = {
    tagName,
    children: [],
    textContent: '',
    className: '',
    title: '',
    colSpan: 0,
    scope: '',
    src: '',
    alt: '',
    width: 0,
    height: 0,
    dataset: {},
    append(...nodes: unknown[]) {
      for (const node of nodes) if (isFake(node)) element.children.push(node);
    },
    replaceChildren(...nodes: unknown[]) {
      element.children = [];
      element.append(...nodes);
    },
    setAttribute() {},
  };
  return element;
}

function isFake(value: unknown): value is FakeElement {
  return typeof value === 'object' && value !== null && typeof (value as FakeElement).tagName === 'string';
}

(globalThis as { document?: unknown }).document = {
  createElement: (tag: string) => fakeElement(tag),
};

/** Depth-first text of a fake node tree. */
function collectText(node: unknown): string {
  if (node === null || node === undefined) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(collectText).join(' ');
  const record = node as { textContent?: string; children?: unknown[]; dataset?: Record<string, string> };
  const own = typeof record.textContent === 'string' ? record.textContent : '';
  const child = Array.isArray(record.children) ? record.children.map(collectText).join(' ') : '';
  return `${own} ${child}`.trim();
}

function find(node: FakeElement, className: string): FakeElement[] {
  const matches: FakeElement[] = [];
  if (node.className.split(' ').includes(className)) matches.push(node);
  for (const child of node.children) matches.push(...find(child, className));
  return matches;
}

function catalogEntry(
  id: string,
  label: string,
  models: ProviderModelSnapshot[],
): ProviderCatalogSnapshot {
  return {
    id,
    label,
    description: '',
    configured: true,
    authMode: 'api-key',
    setupHint: '',
    models,
  };
}

function snapshot(catalog: ProviderCatalogSnapshot[]): QuotaSnapshot {
  return { status: 'available', providers: [], catalog, providerOrder: [] };
}

test('rows group by canonicalId and never unify distinct models that share a label', () => {
  const rows = buildModelListRows(snapshot([
    catalogEntry('openai', 'OpenAI', [
      { id: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol', canonicalId: 'gpt-5.6', available: true, pricing: [0.1, 1, 2] as const },
    ]),
    catalogEntry('chatgpt', 'ChatGPT', [
      { id: 'gpt-5.6-sol-codex', displayName: 'GPT-5.6 Sol', canonicalId: 'gpt-5.6', available: true, pricing: [0.1, 1, 2] as const },
    ]),
  ]));

  assert.equal(rows.length, 1, 'canonicalId unifies the exact same model');
  assert.equal(rows[0].key, 'gpt-5.6');
  assert.deepEqual(rows[0].providers.map((provider) => provider.id), ['openai', 'chatgpt']);

  // Identical labels without a shared canonicalId stay separate rows.
  const split = buildModelListRows(snapshot([
    catalogEntry('a', 'A', [{ id: 'model-a', displayName: 'Same Label', available: true, pricing: [0.1, 1, 2] as const }]),
    catalogEntry('b', 'B', [{ id: 'model-b', displayName: 'Same Label', available: true, pricing: [0.1, 1, 2] as const }]),
  ]));
  assert.equal(split.length, 2, 'a label is never treated as equivalence proof');
});

test('family classification is deterministic prefix matching with a stable fallback', () => {
  assert.equal(classifyFamily('gpt-5.6-sol'), 'GPT');
  assert.equal(classifyFamily('claude-opus-5'), 'Claude');
  assert.equal(classifyFamily('gemini-3-pro'), 'Gemini');
  assert.equal(classifyFamily('grok-4.5'), 'Grok');
  assert.equal(classifyFamily('deepseek-chat'), 'DeepSeek');
  assert.equal(classifyFamily('kimi-k2.6'), 'Kimi');
  assert.equal(classifyFamily('glm-5.3'), 'GLM');
  assert.equal(classifyFamily('qwen3.7-plus'), 'Qwen');
  assert.equal(classifyFamily('minimax-m3'), 'MiniMax');
  assert.equal(classifyFamily('hunyuan-hy4-preview'), 'Hunyuan');
  assert.equal(classifyFamily('doubao-seed-2-0-lite-260215'), 'Doubao');
  assert.equal(classifyFamily('composer-1'), 'Composer');
  assert.equal(classifyFamily('ling-3.0-flash'), 'Other');
  assert.equal(classifyFamily(''), 'Other');
});

test('provider ids map onto the supplying brand keys', () => {
  assert.equal(providerBrand('chatgpt'), 'openai');
  assert.equal(providerBrand('openai'), 'openai');
  assert.equal(providerBrand('anthropic'), 'claude');
  assert.equal(providerBrand('anthropic-api'), 'claude');
  assert.equal(providerBrand('claude-coding'), 'claude');
  assert.equal(providerBrand('spacex-ai'), 'grok');
  assert.equal(providerBrand('zhipu-coding'), 'zhipu');
  assert.equal(providerBrand('tokenhub'), 'tencentcloud');
  assert.equal(providerBrand('volcengine'), 'volcengine');
});

test('active families sort first, then by series and descending version', () => {
  const rows = buildModelListRows(snapshot([
    catalogEntry('inactive', 'Inactive', [{ id: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol', available: false, pricing: [0.1, 1, 2] as const }]),
    catalogEntry('spacex-ai', 'SpaceX AI', [
      { id: 'grok-4.5', displayName: 'Grok 4.5', intelligence: 'premium', available: true, pricing: [0.1, 1, 2] as const },
    ]),
    catalogEntry('openai', 'OpenAI', [
      { id: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol', intelligence: 'mid', available: true, pricing: [0.1, 1, 2] as const },
      { id: 'gpt-5.6-luna', displayName: 'GPT-5.6 Luna', intelligence: 'premium', available: true, pricing: [0.1, 1, 2] as const },
    ]),
    catalogEntry('anthropic', 'Anthropic', [
      { id: 'claude-opus-5', displayName: 'Claude Opus 5', intelligence: 'high', available: true, pricing: [0.1, 1, 2] as const },
    ]),
  ]));

  // Active before inactive; GPT → Claude → Grok is the confirmed frontier order.
  assert.deepEqual(
    rows.map((row) => row.key),
    ['gpt-5.6-luna', 'gpt-5.6-sol', 'claude-opus-5', 'grok-4.5'],
  );
  assert.equal(rows.every((row) => row.active), true, 'the unavailable GPT row is active via openai');
  assert.equal(rows.some((row) => row.key === 'gpt-5.6-sol'), true, 'inactive models stay listed');
});

test('keeps Claude series contiguous and sorts versions before variants', () => {
  const rows = buildModelListRows(snapshot([
    catalogEntry('anthropic', 'Anthropic', [
      { id: 'claude-opus-5', displayName: 'Claude Opus 5', available: true, pricing: [0.1, 1, 2] as const },
      { id: 'claude-fable-5', displayName: 'Claude Fable 5', available: true, pricing: [0.1, 1, 2] as const },
      { id: 'claude-fable-5.1', displayName: 'Claude Fable 5.1', available: true, pricing: [0.1, 1, 2] as const },
    ]),
    catalogEntry('google', 'Google', [
      { id: 'gemini-3', displayName: 'Gemini 3', available: true, pricing: [0.1, 1, 2] as const },
    ]),
    catalogEntry('spacex-ai', 'SpaceX AI', [
      { id: 'grok-4', displayName: 'Grok 4', available: true, pricing: [0.1, 1, 2] as const },
    ]),
  ]));
  assert.deepEqual(rows.map((row) => row.key), [
    'claude-fable-5.1',
    'claude-fable-5',
    'claude-opus-5',
    'gemini-3',
    'grok-4',
  ]);
});

test('TPS averages providers equally even when measurements match and prefers measured sources over catalog defaults', () => {
  // Equal measurements from different providers still count independently.
  assert.equal(averageMeasuredTps([
    { id: 'a', displayName: 'A', effectiveTps: 40, pricing: [0.1, 1, 2] as const },
    { id: 'b', displayName: 'B', effectiveTps: 40, pricing: [0.1, 1, 2] as const },
    { id: 'c', displayName: 'C', effectiveTps: 60, pricing: [0.1, 1, 2] as const },
  ]), 140 / 3);
  assert.equal(averageMeasuredTps([{ id: 'a', displayName: 'A', effectiveTps: null, pricing: [0.1, 1, 2] as const }]), null);

  const rows = buildModelListRows(snapshot([
    catalogEntry('openai', 'OpenAI', [
      { id: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol', effectiveTps: 100, speedSource: 'catalog_default', available: true, pricing: [0.1, 1, 2] as const },
    ]),
    catalogEntry('chatgpt', 'ChatGPT', [
      { id: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol', effectiveTps: 42, speedSource: 'local_31d', available: true, pricing: [0.1, 1, 2] as const },
    ]),
  ]));
  assert.equal(rows[0].tps, 42, 'a measured source outranks the catalog default globally');
});

test('pricing shows per-component min–max of the actual list prices', () => {
  assert.equal(formatPriceRange([3, 5]), '3–5');
  assert.equal(formatPriceRange([5]), '5');
  assert.equal(formatPriceRange([0.003, 0.006]), '0.003–0.006');

  const rows = buildModelListRows(snapshot([
    catalogEntry('openai', 'OpenAI', [{
      id: 'gpt-5.6-sol',
      displayName: 'GPT-5.6 Sol',
      available: true,
      pricing: [0.3, 3, 12] as const,
    }]),
    catalogEntry('chatgpt', 'ChatGPT', [{
      id: 'gpt-5.6-sol',
      displayName: 'GPT-5.6 Sol',
      available: true,
      pricing: [0.6, 5, 12] as const,
    }]),
  ]));

  assert.equal(rows[0].inputLabel, '3–5');
  assert.equal(rows[0].outputLabel, '12');
  assert.equal(rows[0].cacheLabel, '0.3–0.6');
});

test('rendering exposes the uniform columns, units, and muted unavailable names', () => {
  const host = fakeElement('div');
  renderModelList(host as unknown as HTMLElement, snapshot([
    catalogEntry('openai', 'OpenAI API', [
      { id: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol', intelligence: 'premium', effectiveTps: 50, available: true, pricing: [0.1, 1, 2] as const },
    ]),
    catalogEntry('spacex-ai', 'SpaceX AI', [
      { id: 'grok-4.5', displayName: 'Grok 4.5', available: false, pricing: [0.1, 1, 2] as const },
    ]),
  ]));

  const text = collectText(host);
  for (const header of ['模型', '缓存（$/Mtok）', '输入（$/Mtok）', '输出（$/Mtok）', '速度', '供应商']) {
    assert.ok(text.includes(header), `missing column heading: ${header}`);
  }
  assert.ok(text.includes('GPT-5.6 Sol'));
  assert.ok(text.includes('OpenAI API'));
  assert.ok(text.includes('Grok 4.5'));

  const muted = find(host, 'is-muted');
  const mutedText = muted.map((element) => collectText(element));
  assert.ok(mutedText.some((value) => value === 'Grok 4.5'), 'an unavailable model name is muted');
  assert.ok(mutedText.some((value) => value === 'SpaceX AI'), 'an unavailable provider name is muted');
  assert.ok(
    find(host, 'model-list-name').some((element) => element.textContent === 'GPT-5.6 Sol' && element.className === 'model-list-name'),
    'an available model name stays normal',
  );
  assert.ok(find(host, 'model-list-icon').length > 0, 'model and provider names carry brand icons');
});

test('an empty catalog renders one bounded empty row instead of throwing', () => {
  const host = fakeElement('div');
  renderModelList(host as unknown as HTMLElement, snapshot([]));
  assert.ok(collectText(host).includes('未发现受支持的模型。'));
  renderModelList(host as unknown as HTMLElement, null);
  assert.ok(collectText(host).includes('未发现受支持的模型。'));
});


test('family activation keeps inactive siblings grouped and TPS counts each provider once', () => {
  const rows = buildModelListRows(snapshot([
    catalogEntry('a', 'A', [
      { id: 'gpt-a', displayName: 'GPT A', intelligence: 'premium', available: false, pricing: [0.1, 1, 2] as const },
      { id: 'gpt-b', displayName: 'GPT B', intelligence: 'mid', available: true, pricing: [0.1, 1, 2] as const },
      { id: 'glm-5.3', displayName: 'GLM', effectiveTps: 40, speedSource: 'local_31d', pricing: [0.1, 1, 2] as const },
      { id: 'glm-alias', canonicalId: 'glm-5.3', displayName: 'GLM', effectiveTps: 40, speedSource: 'local_31d', pricing: [0.1, 1, 2] as const },
    ]),
    catalogEntry('b', 'B', [{ id: 'glm-5.3', displayName: 'GLM', effectiveTps: 40, speedSource: 'local_31d', pricing: [0.1, 1, 2] as const }]),
    catalogEntry('c', 'C', [{ id: 'glm-5.3', displayName: 'GLM', effectiveTps: 60, speedSource: 'provider_override', pricing: [0.1, 1, 2] as const }]),
    catalogEntry('d', 'D', [{ id: 'glm-5.3', displayName: 'GLM', effectiveTps: 999, speedSource: 'catalog_default', pricing: [0.1, 1, 2] as const }]),
    catalogEntry('e', 'E', [{ id: 'claude-a', displayName: 'Claude A', intelligence: 'high', available: true, pricing: [0.1, 1, 2] as const }]),
  ]));
  assert.deepEqual(rows.map(row => row.key), ['gpt-a', 'gpt-b', 'claude-a', 'glm-5.3']);
  assert.equal(rows[3].tps, 140 / 3);
});
