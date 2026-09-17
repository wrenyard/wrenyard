import { randomUUID } from 'node:crypto';
import { canonicalizeBuiltinPublicModelId, createBuiltinCatalog } from '@wrenyard/providers';
import { getEncoding } from 'js-tiktoken';
import { parseTaskRunSnapshot } from './stats-snapshot.js';
import type {
  ConversationItemSnapshot,
  ConversationModelGroupSnapshot,
  ConversationModelsSnapshot,
  ConversationModelSelectionSnapshot,
  ConversationSessionSnapshot,
  ConversationSnapshot,
  ConversationTurnSnapshot,
  WorkspaceConfigurationSnapshot,
} from './shell-contract.js';

interface RpcSuccess {
  type: 'server-response';
  rpcId: string;
  result: { ok: true; value: unknown };
}

interface RpcFailure {
  type: 'server-response';
  rpcId: string;
  result: { ok: false; error: { code?: unknown; message?: unknown } };
}

interface RawSessionSummary {
  sessionId: string;
  updatedAt: number;
  running: boolean;
  blank: boolean;
  cwd?: string;
  agentPreset?: string;
  projections?: { values?: Record<string, unknown> };
}

interface HistoryEntry {
  event: Record<string, unknown>;
  view?: unknown;
}

interface HistoryPage {
  events: HistoryEntry[];
  hasMore: boolean;
}

interface DshConversationClientOptions {
  baseUrl: string;
  workspaceId: string;
  workspace: WorkspaceConfigurationSnapshot & { status: 'configured'; path: string };
  /**
   * Canonical product provider ids whose credentials were passed to the DSH
   * child. Copied defensively; used to filter the advertised model directory.
   */
  configuredProviderIds: readonly string[];
  onChanged(): void;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function contentText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => isObject(block) && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('\n\n')
    .trim();
}

const MAX_TOOL_RESULT_TEXT = 16_000;

/**
 * Bounded raw text for a DSH tool/result message: the joined text of every
 * nested `tool-result` block, including text blocks inside each block's
 * `content`. Capped so escaped terminal payloads stay within renderer limits.
 */
function extractToolResultText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (!isObject(block) || block.type !== 'tool-result') continue;
    const inner = block.content;
    if (typeof inner === 'string') {
      if (inner) parts.push(inner);
    } else if (Array.isArray(inner)) {
      for (const innerBlock of inner) {
        if (isObject(innerBlock) && typeof innerBlock.text === 'string' && innerBlock.text) {
          parts.push(innerBlock.text);
        }
      }
    }
  }
  const joined = parts.join('\n\n').trim();
  return joined;
}

/** Parse a JSON string into a plain object, or undefined when it is not one. */
function parseJsonObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return isObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Parse a JSON string into an array of plain objects, or undefined when it is not one. */
function parseJsonArray(value: unknown): Record<string, unknown>[] | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return undefined;
    return parsed.filter(isObject);
  } catch {
    return undefined;
  }
}

/** First nonblank string value found on the object for any of the candidate keys. */
function firstString(object: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = asString(object[key]);
    if (value && value.trim()) return value.trim();
  }
  return undefined;
}

/** Task identity candidates carried by run_task / task_run tool arguments. */
function taskIdentityFromArguments(args: Record<string, unknown> | undefined): string | undefined {
  if (!args) return undefined;
  const direct = firstString(args, ['task_id', 'taskId', 'name', 'task_name', 'taskName']);
  if (direct) return direct;
  const nested = args.task;
  return isObject(nested) ? firstString(nested, ['task_id', 'taskId', 'name', 'task_name', 'taskName']) : undefined;
}

const MAX_TOOL_SUMMARY = 120;
const MAX_DOCUMENT_LINKS = 8;
const MAX_DOCUMENT_TITLE = 120;
const MAX_DOCUMENT_PATH = 400;
/** Titles at most this long and free of newlines are trusted as document headings. */
const MAX_HEADING_TITLE = 160;

function clampSummary(text: string): string {
  return text.length > MAX_TOOL_SUMMARY ? text.slice(0, MAX_TOOL_SUMMARY) : text;
}

/** Nearest MCP tool name inside a bounded window of surrounding text. */
function nearestMcpToolName(text: string, index: number): string | undefined {
  const window = text.slice(Math.max(0, index - 200), index + 200);
  return /\bmcp__([a-z0-9_]+?)__([a-z0-9_]+)\b/i.exec(window)?.slice(1, 3).join(' ');
}

/**
 * The exact Wrenyard tool aliases exposed to the model by the DSH shell bridge
 * (`packages/dsh-shell/src/foreman-tools.mjs`). Projection never invents a name
 * outside this set.
 */
const TASK_LIST_TOOLS = new Set(['list_task', 'task_list']);
const TASK_DESCRIBE_TOOLS = new Set(['describe_task', 'task_describe']);
const TASK_RUN_TOOLS = new Set(['run_task', 'task_run']);

/**
 * Workspace-document aliases and their canonical IPC methods. Each alias owns a
 * distinct operation, so the summary name is resolved by alias rather than by a
 * shared prefix rule.
 */
const WORKSPACE_DOC_ALIASES = new Map<string, string>([
  ['list_workspace_docs', '列出'],
  ['read_workspace_doc', '读文档'],
  ['create_workspace_doc', '新建文档'],
  ['update_workspace_doc', '更新文档'],
]);

const DISCOVERY_ALIASES = new Map<string, string>([
  ['list_projects', '列出项目'],
  ['list_runtimes', '列出运行时'],
]);

/** A document read/list call targets either a directory or a document path. */
function documentTarget(args: Record<string, unknown> | undefined): string | undefined {
  const path = args ? firstString(args, ['path']) : undefined;
  if (path) return path;
  return args ? firstString(args, ['directory']) : undefined;
}

/**
 * Concise Chinese one-line summary for a tool call, derived only from the
 * observed call name and arguments. Task display names are resolved separately
 * from observed list/describe results; this stays a deterministic fallback.
 */
function summarizeToolCall(name: string, args: Record<string, unknown> | undefined, text: string): string | undefined {
  const path = args ? firstString(args, ['path', 'file', 'file_path', 'filePath', 'document', 'document_path', 'uri', 'url']) : undefined;
  if (name === 'Read') return path ? clampSummary(`读取文件 ${path}`) : '读取文件';
  const documentLabel = WORKSPACE_DOC_ALIASES.get(name);
  if (documentLabel) {
    const target = documentTarget(args);
    return clampSummary(target ? `${documentLabel} ${target}` : documentLabel);
  }
  const discoveryLabel = DISCOVERY_ALIASES.get(name);
  if (discoveryLabel) {
    const scope = args ? firstString(args, ['project', 'task_id']) : undefined;
    return clampSummary(scope ? `${discoveryLabel} ${scope}` : discoveryLabel);
  }
  if (TASK_DESCRIBE_TOOLS.has(name)) {
    const identity = taskIdentityFromArguments(args);
    return clampSummary(identity ? `查看任务定义 ${identity}` : '查看任务定义');
  }
  if (TASK_LIST_TOOLS.has(name)) {
    const project = args ? firstString(args, ['project']) : undefined;
    return clampSummary(project ? `列出任务 ${project}` : '列出任务');
  }
  const identity = taskIdentityFromArguments(args);
  if (TASK_RUN_TOOLS.has(name)) {
    return clampSummary(identity ? `运行任务 ${identity}` : '运行任务');
  }
  const mcp = nearestMcpToolName(text, text.indexOf(name));
  return mcp ? clampSummary(`调用 ${mcp}`) : undefined;
}

/** Bounded same-line position of an absolute or workspace-relative document path. */
function documentPathAt(text: string, index: number): string | undefined {
  const line = /[^\s`"'()<>\[\]]+/.exec(text.slice(index, index + MAX_DOCUMENT_PATH));
  const path = line?.[0]?.replace(/[.,;:]+$/, '');
  if (!path || (!path.includes('/') && !path.includes('\\'))) return undefined;
  return path;
}

/**
 * Bounded document references parsed from a `read_workspace_doc`/
 * `list_workspace_docs` tool result. The first visible heading, when it is a
 * plausible title, becomes the shared title; otherwise each reference falls back
 * to its own path. Raw HTML is never trusted as a title, and every reference
 * must be path-shaped, so arbitrary markup is discarded.
 */
function documentLinksFromText(text: string): ConversationItemSnapshot['documentLinks'] {
  const links: Array<{ title: string; path: string }> = [];
  const seen = new Set<string>();
  const heading = /^#{1,6}[ \t]+(.+)$/m.exec(text)?.[1]?.trim();
  const headingTitle = heading && heading.length <= MAX_HEADING_TITLE && !heading.includes('<')
    ? heading
    : undefined;

  const push = (rawPath: string): void => {
    const path = rawPath.replace(/[.,;:]+$/, '');
    if (!path || path.length > MAX_DOCUMENT_PATH || seen.has(path)) return;
    if (path.includes('<') || path.includes('>')) return;
    seen.add(path);
    links.push({ title: (headingTitle ?? path).slice(0, MAX_DOCUMENT_TITLE), path });
  };

  // A workspace doc result may report the document path as a field rather than
  // inline prose, so an explicit `path` is a reference in its own right.
  const declaredPath = firstString(parseJsonObject(text) ?? {}, ['path']);
  if (declaredPath) push(declaredPath);
  // A heading names the document, so the path on its own line is its reference.
  const headingLine = /^#{1,6}[ \t]+.*$/m.exec(text);
  if (headingLine) {
    const path = documentPathAt(text, headingLine.index + headingLine[0].length);
    if (path) push(path);
  }
  for (const match of text.matchAll(/[A-Za-z0-9_./\\-]*\/[A-Za-z0-9_./\\-]+\.(?:md|mdx|txt|markdown|rst)\b/gi)) {
    push(match[0]);
  }
  return links.length > 0 ? links.slice(0, MAX_DOCUMENT_LINKS) : undefined;
}

/**
 * Task display names observed from `list_task`/`describe_task` results, keyed by
 * the exact task identity that appears in `task_id`/`name`/`identity`. Only
 * identities that resolve to a usable display name are stored.
 */
function collectTaskDisplayNames(
  rawText: string,
  into: Map<string, string>,
): void {
  const roots: Record<string, unknown>[] = [];
  const object = parseJsonObject(rawText);
  if (object) roots.push(object);
  const array = parseJsonArray(rawText);
  if (array) roots.push(...array);
  if (roots.length === 0) return;

  for (const root of roots) {
    const queue: Record<string, unknown>[] = [root];
    let visited = 0;
    while (queue.length > 0 && visited < 200) {
      const current = queue.shift() as Record<string, unknown>;
      visited += 1;
      // `display_name` is the authoritative label; a definition only carries
      // `name` (the task_id), so `task_name`/`taskName` are not titles here.
      const display = firstString(current, ['display_name', 'displayName']);
      const identity = firstString(current, ['identity', 'task_id', 'taskId', 'name']);
      if (display && identity) into.set(identity, display);
      for (const value of Object.values(current)) {
        if (isObject(value)) queue.push(value);
        else if (Array.isArray(value)) queue.push(...value.filter(isObject));
      }
    }
  }
}

/** Best-effort parse of a tool/call `arguments` string into its object form. */
function parseToolCallArguments(value: unknown): Record<string, unknown> | undefined {
  return parseJsonObject(value);
}

function titleFromSummary(summary: RawSessionSummary): string {
  const title = summary.projections?.values?.title;
  if (typeof title === 'string' && title.trim()) return title.trim();
  return summary.blank ? '新会话' : '未命名会话';
}

function eventTime(event: Record<string, unknown>): number {
  return asNumber(event.time) ?? Date.now();
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`DSH 模型目录缺少 ${field}`);
  return value;
}

function catalogProviderForRoute(provider: string, model: string): string {
  if (provider !== 'wrenyard') return provider;
  const separator = model.indexOf('/');
  return separator > 0 ? model.slice(0, separator) : provider;
}

function canonicalConversationModel(provider: string, model: string): string {
  if (provider === 'wrenyard') return canonicalizeBuiltinPublicModelId(model);
  const canonical = canonicalizeBuiltinPublicModelId(`${provider}/${model}`);
  return canonical.startsWith(`${provider}/`) ? canonical.slice(provider.length + 1) : model;
}

/**
 * Authoritative built-in Catalog, instantiated once. Used only to read the exact
 * input capabilities (`text`/`image`) of a model already projected into the
 * product directory — never to enumerate, re-merge, or fabricate models.
 */
const BUILTIN_CATALOG = createBuiltinCatalog();

/**
 * Project a model's exact Catalog input capabilities for a DSH directory entry.
 * The authoritative provider/model identity comes from the built-in Catalog, not
 * the raw DSH claim or the model name: for the `wrenyard` transport the catalog
 * provider is the first segment of the `provider/model` public id, and for a
 * native transport it is the DSH provider itself. Aliases are resolved through
 * the existing canonicalizer. Capabilities are copied only when the exact model
 * resolves in the Catalog; otherwise `undefined` is returned so the UI can fall
 * back to a neutral label instead of assuming a model is text-only.
 */
function catalogInputTypes(provider: string, model: string): readonly ('text' | 'image')[] | undefined {
  const catalogProvider = provider === 'wrenyard' && model.includes('/')
    ? model.slice(0, model.indexOf('/'))
    : provider;
  const catalogModel = provider === 'wrenyard' && model.includes('/')
    ? model.slice(model.indexOf('/') + 1)
    : model;
  const canonical = canonicalizeBuiltinPublicModelId(`${catalogProvider}/${catalogModel}`);
  const separator = canonical.indexOf('/');
  if (separator <= 0) return undefined;
  const exactProvider = canonical.slice(0, separator);
  const exactModel = canonical.slice(separator + 1);
  const definition = BUILTIN_CATALOG
    .provider(exactProvider)
    ?.models.find((candidate) => candidate.id === exactModel);
  return definition?.capabilities ? [...definition.capabilities] : undefined;
}

export interface PersistedModelSelectionRepair {
  provider: string;
  model: string;
  reasoningEffort?: string;
}

/**
 * Return the one safe persistence repair for a retired public Gateway alias.
 * The provider/catalog directory remains authoritative: this never changes
 * providers, invents a fallback model, or rewrites a genuinely unknown id.
 */
export function persistedModelSelectionRepair(
  selection: unknown,
  groups: ConversationModelGroupSnapshot[],
): PersistedModelSelectionRepair | undefined {
  if (!isObject(selection) || selection.provider !== 'wrenyard' || typeof selection.model !== 'string') return undefined;
  const model = canonicalConversationModel('wrenyard', selection.model);
  if (model === selection.model) return undefined;
  const option = groups
    .find((group) => group.provider === 'wrenyard')
    ?.models.find((candidate) => candidate.model === model);
  if (!option) return undefined;
  return {
    provider: 'wrenyard',
    model,
    ...(option.defaultReasoningEffort ? { reasoningEffort: option.defaultReasoningEffort } : {}),
  };
}

function modelSelectionSnapshot(
  selection: Record<string, unknown>,
  groups: ConversationModelGroupSnapshot[],
  configuredProviderIds?: ReadonlySet<string>,
): ConversationModelSelectionSnapshot {
  const provider = requiredString(selection.provider, 'current.provider');
  const model = canonicalConversationModel(provider, requiredString(selection.model, 'current.model'));
  const group = groups.find((candidate) => candidate.provider === provider);
  const option = group?.models.find((candidate) => candidate.model === model);
  return {
    provider,
    catalogProvider: option?.catalogProvider ?? catalogProviderForRoute(provider, model),
    model,
    label: option?.label ?? model,
    providerLabel: group?.label ?? provider,
    advertised: option !== undefined,
    configured: configuredProviderIds === undefined || configuredProviderIds.has(provider),
    ...(typeof selection.reasoningEffort === 'string' && selection.reasoningEffort
      ? { reasoningEffort: selection.reasoningEffort }
      : {}),
  };
}

/**
 * Validate and project DSH's `groups` + `failures` arrays into the strict
 * product model directory. Shared between the per-session projection (which
 * also carries `current`/`routable`) and the host-scoped draft projection
 * (groups/failures only). When `configured` is supplied, only providers whose
 * credentials were actually passed to the DSH child are advertised.
 */
function projectModelGroups(
  value: Record<string, unknown>,
  configured?: ReadonlySet<string>,
): { groups: ConversationModelGroupSnapshot[]; failures: string[] } {
  if (!Array.isArray(value.groups) || !Array.isArray(value.failures)) {
    throw new Error('DSH 模型目录格式无效');
  }
  const groups = value.groups.map((rawGroup, groupIndex): ConversationModelGroupSnapshot => {
    if (!isObject(rawGroup) || !Array.isArray(rawGroup.models)) throw new Error(`DSH 模型目录第 ${groupIndex + 1} 组格式无效`);
    const provider = requiredString(rawGroup.id, `groups[${groupIndex}].id`);
    const providerLabel = requiredString(rawGroup.name, `groups[${groupIndex}].name`);
    return {
      provider,
      label: providerLabel,
      models: rawGroup.models.flatMap((rawModel, modelIndex) => {
        if (!isObject(rawModel)) throw new Error(`DSH 模型目录 ${provider} 第 ${modelIndex + 1} 项格式无效`);
        const model = requiredString(rawModel.id, `groups[${groupIndex}].models[${modelIndex}].id`);
        const sourceLabel = requiredString(rawModel.name, `groups[${groupIndex}].models[${modelIndex}].name`);
        const reasoning = isObject(rawModel.reasoning) ? rawModel.reasoning : undefined;
        return [{
          provider,
          catalogProvider: catalogProviderForRoute(provider, model),
          providerLabel,
          model,
          label: sourceLabel,
          ...(() => {
            const inputTypes = catalogInputTypes(provider, model);
            return inputTypes ? { inputTypes } : {};
          })(),
          ...(typeof rawModel.description === 'string' && rawModel.description
            ? { description: rawModel.description.slice(0, 500) }
            : {}),
          ...(reasoning && Array.isArray(reasoning.efforts)
            ? { reasoningEfforts: reasoning.efforts.filter((effort): effort is string => typeof effort === 'string' && effort.length > 0) }
            : {}),
          ...(reasoning && typeof reasoning.defaultEffort === 'string' && reasoning.defaultEffort
            ? { defaultReasoningEffort: reasoning.defaultEffort }
            : {}),
        }];
      }),
    };
  }).filter((group) => configured === undefined || configured.has(group.provider));
  const failures = value.failures.flatMap((failure) => {
    if (!isObject(failure)) return [];
    const name = asString(failure.name) ?? asString(failure.id) ?? '模型提供方';
    const message = asString(failure.message);
    return message ? [`${name}: ${message}`] : [];
  });
  return { groups, failures };
}

/**
 * Validate and project DSH's advisory per-session model directory. When
 * `configuredProviderIds` is supplied, only providers whose credentials were
 * actually passed to the DSH child are advertised. This projection stays
 * strict about `current` and `routable`: it is only used for `session.models`.
 */
export function projectConversationModels(
  value: unknown,
  configuredProviderIds?: readonly string[],
): ConversationModelsSnapshot {
  if (!isObject(value) || !isObject(value.current)) throw new Error('DSH 模型目录格式无效');
  if (typeof value.routable !== 'boolean') throw new Error('DSH 模型目录缺少 routable');
  const configured = configuredProviderIds === undefined
    ? undefined
    : new Set(configuredProviderIds);
  const { groups, failures } = projectModelGroups(value, configured);
  return {
    status: 'ready',
    groups,
    current: modelSelectionSnapshot(value.current, groups, configured),
    routable: value.routable,
    ...(failures.length > 0 ? { message: failures.join('；').slice(0, 1_000) } : {}),
  };
}

/**
 * Project the host-scoped draft catalog returned by `llm.models`. DSH
 * 0.1.1-rc.2 sends only `groups` and `failures` — there is no `current`
 * selection and no `routable` flag. The picker is therefore seeded without
 * ever fabricating a current model, and `routable` is derived from whether at
 * least one advertised, configured model is present.
 */
export function projectHostModels(
  value: unknown,
  configuredProviderIds?: readonly string[],
): ConversationModelsSnapshot {
  if (!isObject(value)) throw new Error('DSH 模型目录格式无效');
  const configured = configuredProviderIds === undefined
    ? undefined
    : new Set(configuredProviderIds);
  const { groups, failures } = projectModelGroups(value, configured);
  // Every option that survived configured-provider filtering is both
  // advertised by the host catalog and backed by credentials passed to DSH.
  const routable = groups.some((group) => group.models.length > 0);
  return {
    status: 'ready',
    groups,
    current: undefined,
    routable,
    ...(failures.length > 0 ? { message: failures.join('；').slice(0, 1_000) } : {}),
  };
}

interface ConversationProjection {
  items: ConversationItemSnapshot[];
  turns: ConversationTurnSnapshot[];
  /** Retained history array the projection was derived from; part of the cache key. */
  source: HistoryEntry[];
  /** Length of `source` when projected; stream frames mutate it in place. */
  sourceLength: number;
  revision: number;
}

/**
 * One assistant response (one `turn`+`step` pair). Its generation window runs
 * from the first nonempty delta to the last nonempty delta, so an empty delta,
 * a tool wait, or completion latency never opens or extends a measurement.
 */
interface ObservedResponse {
  /** Arrival times of the nonempty deltas, in fold (seq) order. */
  deltaTimes: number[];
  /** Concatenated nonempty deltas per content channel (type/block or call id). */
  channels: Map<string, string>;
  /** Terminal `finish` observed for this step; false until one arrives without a failure reason. */
  finishedCleanly: boolean;
  /** Per-step usage, counted once even when DSH repeats the observation. */
  usage?: { inputTokens?: number; outputTokens?: number };
}

interface ObservedTurn {
  id: string;
  order: number;
  startedAt: number;
  endedAt?: number;
  /** Exact observed `turn/end` reason kind; the only source of `completed`. */
  endReason?: string;
  completed: boolean;
  /** Per-step responses of this turn, keyed by the exact step number. */
  responses: Map<number, ObservedResponse>;
  finalItemId?: string;
  /** Number of `run_task`/`task_run` dispatches observed in this turn. */
  dispatchCount: number;
}

/**
 * Fixed cl100k_base tokenizer behind the unified approximate TPS
 * contract: one encoding for every model, so the estimate never varies by
 * route. Special strings are counted as ordinary text instead of raising.
 */
const TOKENIZER = getEncoding('cl100k_base');

/** cl100k_base token count of one fully concatenated content stream. */
function countTokens(stream: string): number {
  return TOKENIZER.encode(stream, [], []).length;
}

/**
 * The content a delta chunk actually carries, routed to its own accumulation
 * channel: `type:block-index` for text/reasoning streams and the exact tool
 * call id for streamed arguments. The DSH 0.1.1-rc.2 chunk schema names the
 * streamed tool arguments field `argumentsDelta`.
 */
function deltaChunkContent(
  chunkType: string | undefined,
  chunk: Record<string, unknown>,
): { channel: string; text: string } | undefined {
  if (chunkType === 'text-delta' || chunkType === 'reasoning-delta') {
    const text = asString(chunk.text) ?? '';
    if (!text) return undefined;
    return { channel: `${chunkType}:${asNumber(chunk.index) ?? 0}`, text };
  }
  if (chunkType === 'tool-call-delta') {
    const text = asString(chunk.argumentsDelta) ?? '';
    if (!text) return undefined;
    const callId = asString(chunk.id);
    return { channel: `tool-call:${callId ?? asNumber(chunk.index) ?? 0}`, text };
  }
  return undefined;
}

/**
 * Project the durable DSH event history into the bounded product-owned renderer
 * model. Retained `turn/start`/`turn/end` events provide the exact turn
 * boundaries, and per-step `assistant/chunk` observations provide the response
 * generation window and token counts. Only a `turn/end` may end the turn:
 * TPS counts fixed cl100k_base tokens over only the deltas the stream
 * actually carried and divides by exactly the first-to-last-delta window, so
 * turn completion, tool waiting, and completion latency never inflate it.
 * Reasoning and streamed tool-argument deltas participate in TPS only
 * and are never projected as content.
 */
export function projectConversation(
  entries: HistoryEntry[],
): { items: ConversationItemSnapshot[]; turns: ConversationTurnSnapshot[] } {
  const items: Array<ConversationItemSnapshot & { order: number; seq: number }> = [];
  const drafts = new Map<string, ConversationItemSnapshot & { order: number; seq: number }>();
  const finalizedSteps = new Set<string>();
  const tools = new Map<string, ConversationItemSnapshot & { order: number; seq: number }>();
  const toolArguments = new Map<string, Record<string, unknown> | undefined>();
  const turnOrder: string[] = [];
  const observedTurns = new Map<string, ObservedTurn>();
  const turnsById = observedTurns;
  const taskDisplayNames = new Map<string, string>();
  let activeTurnId: string | undefined;

  const observeTurn = (turnId: string, time: number, order: number): ObservedTurn => {
    const existing = turnsById.get(turnId);
    if (existing) return existing;
    const observed: ObservedTurn = {
      id: turnId,
      order: asNumber(entries[order]?.event.seq) ?? order,
      startedAt: time,
      completed: false,
      responses: new Map<number, ObservedResponse>(),
      dispatchCount: 0,
    };
    turnsById.set(turnId, observed);
    turnOrder.push(turnId);
    return observed;
  };

  const observeResponse = (turnId: string, step: number, time: number, order: number): ObservedResponse => {
    const turn = observeTurn(turnId, time, order);
    const existing = turn.responses.get(step);
    if (existing) return existing;
    const response: ObservedResponse = {
      deltaTimes: [],
      channels: new Map<string, string>(),
      finishedCleanly: false,
    };
    turn.responses.set(step, response);
    return response;
  };

  // The retained buffer is merged by seq, so the fold is ordered by seq and
  // every distinct event is folded exactly once. Recovery can replay an event
  // the buffer already holds, so identical seqs are folded once and a seq that
  // reuses an earlier number for a *different* event is still applied.
  const folded = new Set<string>();
  const orderedEntries = entries
    .map((entry, order) => ({ entry, order, seq: asNumber(entry.event.seq) ?? order }))
    .sort((left, right) => left.seq - right.seq || left.order - right.order);

  for (const { entry, order, seq } of orderedEntries) {
    const event = entry.event;
    const type = asString(event.type);
    const data = isObject(event.data) ? event.data : {};
    const time = eventTime(event);
    const identity = `${seq}:${type ?? ''}`;
    if (folded.has(identity)) continue;
    folded.add(identity);

    if (type === 'turn/start') {
      const turn = asNumber(data.turn);
      const turnId = turn === undefined ? activeTurnId ?? `assistant-${seq}` : `turn-${turn}`;
      observeTurn(turnId, time, order).startedAt = time;
      activeTurnId = turnId;
      continue;
    }

    if (type === 'turn/end') {
      const turn = asNumber(data.turn);
      const turnId = turn === undefined ? activeTurnId ?? `assistant-${seq}` : `turn-${turn}`;
      const observed = observeTurn(turnId, time, order);
      observed.endedAt = time;
      const reason = isObject(data.reason) ? data.reason : undefined;
      observed.endReason = asString(reason?.kind);
      observed.completed = observed.endReason === 'completed';
      activeTurnId = turnId;
      continue;
    }

    if (type === 'user/message') {
      if (isObject(data.source) && data.source.kind !== 'user') continue;
      activeTurnId = undefined;
      const text = contentText(data.content);
      if (text) items.push({ id: `user-${seq}`, kind: 'user', text, time, order, seq });
      continue;
    }

    if (type === 'assistant/chunk') {
      const chunk = isObject(data.chunk) ? data.chunk : {};
      const turn = asNumber(data.turn);
      const step = asNumber(data.step) ?? 0;
      const chunkType = asString(chunk.type);
      const turnId = turn === undefined ? activeTurnId ?? `assistant-${seq}` : `turn-${turn}`;
      activeTurnId = turnId;
      if (chunkType === 'usage') {
        // DSH repeats the same per-step usage observation across chunks; each
        // step contributes at most once so token totals are never double counted.
        const response = observeResponse(turnId, step, time, order);
        if (!response.usage) {
          const usage = isObject(chunk.usage) ? chunk.usage : undefined;
          const inputTokens = usage ? asNumber(usage.inputTokens) : undefined;
          const outputTokens = usage ? asNumber(usage.outputTokens) : undefined;
          if (inputTokens !== undefined || outputTokens !== undefined) response.usage = { inputTokens, outputTokens };
        }
        continue;
      }
      const content = deltaChunkContent(chunkType, chunk);
      if (content) {
        const response = observeResponse(turnId, step, time, order);
        response.deltaTimes.push(time);
        response.channels.set(content.channel, (response.channels.get(content.channel) ?? '') + content.text);
      }
      if (chunkType === 'finish') {
        // A finish completes this response only; the turn stays running until
        // its own `turn/end` arrives. `error` and `aborted` finishes report
        // failures, and an unfinished response never contributes TPS.
        const response = observeResponse(turnId, step, time, order);
        const reasonKind = asString(isObject(chunk.reason) ? chunk.reason.kind : undefined);
        response.finishedCleanly = reasonKind !== 'error' && reasonKind !== 'aborted';
        continue;
      }
      // Reasoning deltas are not conversation projection; only visible text is.
      if (chunkType !== 'text-delta') continue;
      const delta = asString(chunk.text) ?? '';
      if (!delta) continue;
      const key = `${turnId}:${step}`;
      if (finalizedSteps.has(key)) continue;
      const draft = drafts.get(key) ?? {
        id: `assistant-${key}`,
        kind: 'assistant' as const,
        text: '',
        time,
        turnId,
        step,
        running: true,
        order,
        seq,
      };
      draft.text += delta;
      drafts.set(key, draft);
      continue;
    }

    if (type === 'assistant/message') {
      const turn = asNumber(data.turn);
      const step = asNumber(data.step) ?? 0;
      const turnId = turn === undefined ? activeTurnId ?? `assistant-${seq}` : `turn-${turn}`;
      const key = `${turnId}:${step}`;
      activeTurnId = turnId;
      observeTurn(turnId, time, order);
      finalizedSteps.add(key);
      drafts.delete(key);
      const message = isObject(data.message) ? data.message : {};
      // Only visible text is projected; reasoning blocks are intentionally dropped.
      const text = contentText(message.content);
      if (text) {
        const item: ConversationItemSnapshot & { order: number; seq: number } = {
          id: `assistant-${key}`,
          kind: 'assistant',
          text,
          turnId,
          step,
          time,
          order,
          seq,
        };
        items.push(item);
        const observed = turnsById.get(turnId);
        if (observed) observed.finalItemId = item.id;
      }
      continue;
    }

    if (type === 'tool/call') {
      const callId = asString(data.callId) ?? `seq-${seq}`;
      const name = asString(data.name) ?? '工具调用';
      const args = asString(data.arguments)?.trim();
      const turn = asNumber(data.turn);
      const turnId = turn === undefined ? activeTurnId : `turn-${turn}`;
      if (turnId && turn !== undefined) activeTurnId = turnId;
      const parsedArgs = parseToolCallArguments(args);
      const step = asNumber(data.step);
      const item: ConversationItemSnapshot & { order: number; seq: number } = {
        id: `tool-${callId}`,
        kind: 'tool',
        toolName: name,
        toolState: 'running',
        text: args ? args.slice(0, 4_000) : '',
        time,
        ...(turnId ? { turnId } : {}),
        ...(step !== undefined ? { step } : {}),
        ...(() => {
          const summary = summarizeToolCall(name, parsedArgs, args ?? '');
          return summary ? { toolSummary: summary } : {};
        })(),
        order,
        seq,
      };
      tools.set(callId, item);
      toolArguments.set(callId, parsedArgs);
      items.push(item);
      // The dispatch count counts task executions, so only `run_task` counts,
      // including a repeated dispatch of the same task.
      if (turnId && TASK_RUN_TOOLS.has(name)) observeTurn(turnId, time, order).dispatchCount += 1;
      continue;
    }

    if (type === 'tool/result') {
      const message = isObject(data.message) ? data.message : {};
      const source = isObject(message.source) ? message.source : {};
      const callId = asString(source.callId);
      if (!callId) continue;
      const tool = tools.get(callId);
      if (tool) {
        const blocks = Array.isArray(message.content) ? message.content : [];
        const failed = blocks.some((block) => isObject(block) && block.isError === true) || isObject(data.error);
        const rawText = extractToolResultText(blocks);
        const toolName = tool.toolName ?? '';
        const isTaskRead = TASK_DESCRIBE_TOOLS.has(toolName) || TASK_LIST_TOOLS.has(toolName);
        let taskRunFailed = false;
        if (toolName === 'run_task' || toolName === 'task_run') {
          const resultObject = parseJsonObject(rawText);
          if (resultObject) {
            let candidate: Record<string, unknown> = resultObject;
            if (!asString(candidate.task_id)) {
              const argTaskId = toolArguments.get(callId);
              const fallbackTaskId = argTaskId ? asString(argTaskId.task_id) : undefined;
              if (fallbackTaskId) candidate = { ...candidate, task_id: fallbackTaskId };
            }
            const displayName = firstString(candidate, ['task_name', 'taskName', 'display_name', 'displayName']);
            const resultTaskId = firstString(candidate, ['task_id', 'taskId']);
            if (displayName && resultTaskId) taskDisplayNames.set(resultTaskId, displayName);
            const taskRun = parseTaskRunSnapshot(candidate);
            if (taskRun) {
              tool.taskRun = taskRun;
              // A run that reports a failed/cancelled terminal status failed for
              // the caller even when the transport marked the call successful.
              taskRunFailed = taskRun.status === 'failed' || taskRun.status === 'cancelled';
            }
          }
        }
        tool.toolState = failed || taskRunFailed ? 'failed' : 'done';
        if (rawText) tool.toolResultText = rawText.slice(0, MAX_TOOL_RESULT_TEXT);
        if (!failed && rawText && isTaskRead) collectTaskDisplayNames(rawText, taskDisplayNames);
        const isDocumentRead = WORKSPACE_DOC_ALIASES.has(toolName) || toolName === 'Read' || toolName === 'read_document';
        if (!failed && !taskRunFailed && rawText && isDocumentRead) {
          const links = documentLinksFromText(rawText);
          if (links) tool.documentLinks = links;
        }
      }
    }
  }

  for (const draft of drafts.values()) {
    if (draft.text) items.push(draft);
  }

  // Resolve observed task identities to their display names; identities that were
  // never observed in a list/describe result keep the deterministic fallback.
  for (const item of items) {
    if (item.kind !== 'tool' || item.toolSummary === undefined) continue;
    const identity = taskIdentityFromArguments(toolArguments.get(item.id.slice('tool-'.length)));
    const displayName = identity ? taskDisplayNames.get(identity) : undefined;
    if (!identity || !displayName) continue;
    item.toolSummary = clampSummary(item.toolSummary.replace(identity, displayName));
  }

  const orderedItems = items.sort((left, right) => left.order - right.order);
  // A merged history page can place a live frame before a recovered page entry
  // (dedupe keeps array order), so the transcript is ordered by the observed
  // event seq rather than by arrival position.
  const sortedItems = [...orderedItems].sort((left, right) => left.seq - right.seq);
  const visibleItemIds = new Set(orderedItems.map((item) => item.id));
  const turns: ConversationTurnSnapshot[] = [];
  const sortedTurnIds = [...turnOrder].sort((left, right) => {
    const a = observedTurns.get(left);
    const b = observedTurns.get(right);
    return (a?.order ?? 0) - (b?.order ?? 0);
  });
  for (const turnId of sortedTurnIds) {
    const observed = turnsById.get(turnId);
    if (!observed) continue;
    const endedAt = observed.endedAt;
    // Token totals count each step exactly once; a turn without usage keeps the
    // observation absent rather than asserting zero.
    const usages = [...observed.responses.values()].flatMap((response) => response.usage ? [response.usage] : []);
    const inputTokens = usages.reduce<number | undefined>(
      (sum, usage) => usage.inputTokens === undefined ? sum : (sum ?? 0) + usage.inputTokens,
      undefined,
    );
    const outputTokens = usages.reduce<number | undefined>(
      (sum, usage) => usage.outputTokens === undefined ? sum : (sum ?? 0) + usage.outputTokens,
      undefined,
    );
    // Throughput follows the unified approximate contract: fixed cl100k_base
    // tokens counted over only the deltas the stream actually carried, divided
    // by exactly the response's first-to-last-delta window. A response
    // contributes only when it finished successfully and its deltas arrived
    // across at least two distinct timestamps spanning >=100ms; completion
    // latency, tool waits, and tool output never enter the measurement, and one
    // unobservable or buffered window never poisons the other valid windows.
    let measuredTokens = 0;
    let measuredGenerationMs = 0;
    let responseCount = 0;
    for (const response of observed.responses.values()) {
      if (!response.finishedCleanly) continue;
      if (new Set(response.deltaTimes).size < 2) continue;
      const generationMs = Math.max(...response.deltaTimes) - Math.min(...response.deltaTimes);
      if (generationMs < 100) continue;
      let responseTokens = 0;
      for (const stream of response.channels.values()) responseTokens += countTokens(stream);
      if (responseTokens === 0) continue;
      measuredTokens += responseTokens;
      measuredGenerationMs += generationMs;
      responseCount += 1;
    }
    const outputTps = responseCount > 0 && measuredGenerationMs > 0
      ? measuredTokens / (measuredGenerationMs / 1_000)
      : undefined;
    turns.push({
      id: observed.id,
      startedAt: observed.startedAt,
      ...(endedAt !== undefined ? { endedAt } : {}),
      running: endedAt === undefined,
      ...(observed.completed && observed.finalItemId && visibleItemIds.has(observed.finalItemId)
        ? { finalItemId: observed.finalItemId }
        : {}),
      dispatchCount: observed.dispatchCount,
      ...(inputTokens !== undefined ? { inputTokens } : {}),
      ...(outputTokens !== undefined ? { outputTokens } : {}),
      ...(outputTps !== undefined ? { outputTps } : {}),
    });
  }

  return {
    items: sortedItems.slice(-240).map(({ order: _order, seq: _seq, ...item }) => item),
    turns,
  };
}

/** Fold DSH's durable history protocol into the bounded product-owned renderer model. */
export function projectConversationHistory(entries: HistoryEntry[]): ConversationItemSnapshot[] {
  return projectConversation(entries).items;
}

/**
 * Project the observed turn boundaries, token usage, and dispatch counts for the
 * retained history. Turns are ordered by first observation, so the projection is
 * a pure function of the retained events.
 */
export function projectConversationTurns(entries: HistoryEntry[]): ConversationTurnSnapshot[] {
  return projectConversation(entries).turns;
}

export class DshConversationClient {
  private readonly baseUrl: URL;
  private readonly workspaceId: string;
  private readonly workspace: DshConversationClientOptions['workspace'];
  private readonly configuredProviderIds: ReadonlySet<string>;
  private readonly onChanged: () => void;
  private sessions = new Map<string, RawSessionSummary>();
  private workspaceSessionIds = new Set<string>();
  private selectedSessionId: string | undefined;
  private history: HistoryPage = { events: [], hasMore: false };
  private models: ConversationModelsSnapshot = { status: 'idle', groups: [] };
  private modelGeneration = 0;
  private pendingDraftModel: Pick<ConversationModelSelectionSnapshot, 'provider' | 'model' | 'reasoningEffort'> | undefined;
  private materializeDraftPromise: Promise<string> | undefined;
  private initialSendPromise: Promise<ConversationSnapshot> | undefined;
  private stopped = false;
  private sockets = new Set<WebSocket>();
  private reconnectTimers = new Set<ReturnType<typeof setTimeout>>();
  private notifyTimer: ReturnType<typeof setTimeout> | undefined;
  private refreshPromise: Promise<void> | undefined;
  private projection: ConversationProjection | undefined;
  private projectionRevision = 0;

  constructor(options: DshConversationClientOptions) {
    this.baseUrl = new URL(options.baseUrl);
    this.workspaceId = options.workspaceId;
    this.workspace = options.workspace;
    this.configuredProviderIds = new Set(options.configuredProviderIds);
    this.onChanged = options.onChanged;
  }

  async start(): Promise<void> {
    await this.refreshIndex();
    // A host-created blank session is only reusable implementation state for
    // the first send; it is not yet a product conversation and must not appear
    // selected in the fresh draft UI.
    const first = [...this.sessions.values()].find((session) => !session.blank);
    if (first) {
      this.selectedSessionId = first.sessionId;
      await this.loadHistory(first.sessionId);
      await this.refreshModels(first.sessionId);
    } else {
      // Fresh workspace with no durable session: load the host-scoped draft
      // model catalog via llm.models so the picker is ready before any session
      // is created. No session.create is issued here.
      await this.refreshModels();
    }
    this.openStream('events.mux');
    this.openStream('events.host');
  }

  stop(): void {
    this.stopped = true;
    this.modelGeneration += 1;
    if (this.notifyTimer) clearTimeout(this.notifyTimer);
    for (const timer of this.reconnectTimers) clearTimeout(timer);
    this.reconnectTimers.clear();
    for (const socket of this.sockets) socket.close();
    this.sockets.clear();
  }

  snapshot(): ConversationSnapshot {
    const sessions = [...this.sessions.values()]
      .filter((session) => this.workspaceSessionIds.has(session.sessionId) && (!session.blank || session.sessionId === this.selectedSessionId))
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .map((session): ConversationSessionSnapshot => ({
        id: session.sessionId,
        title: titleFromSummary(session),
        updatedAt: session.updatedAt,
        running: session.running,
        blank: session.blank,
        ...(session.agentPreset ? { agentPreset: session.agentPreset } : {}),
      }));
    const selected = this.selectedSessionId ? this.sessions.get(this.selectedSessionId) : undefined;
    const projection = this.conversationProjection();
    return {
      status: 'ready',
      workspace: this.workspace,
      sessions,
      ...(selected ? {
        selectedSessionId: selected.sessionId,
        selectedTitle: titleFromSummary(selected),
      } : {}),
      selectedRunning: selected?.running ?? false,
      models: this.models,
      hasMore: this.history.hasMore,
      items: projection.items,
      ...(projection.turns.length > 0 ? { turns: projection.turns } : {}),
    };
  }

  /**
   * Cache the history projection against its retained-events identity so a
   * snapshot burst (mux frames arrive per chunk) reuses one projection. Live
   * frames are pushed in place, so the array identity alone is not enough: the
   * observed length is part of the key. In-place appends explicitly invalidate
   * the cache because trimming a full buffer leaves its length unchanged.
   * Any reassignment of `this.history` —
   * select, create, reload — also invalidates the cache.
   */
  private conversationProjection(): ConversationProjection {
    const events = this.history.events;
    const cached = this.projection;
    if (cached && cached.source === events && cached.sourceLength === events.length) return cached;
    const projected = projectConversation(events);
    const next: ConversationProjection = {
      items: projected.items,
      turns: projected.turns,
      source: events,
      sourceLength: events.length,
      revision: ++this.projectionRevision,
    };
    this.projection = next;
    return next;
  }

  async select(sessionId: string): Promise<ConversationSnapshot> {
    if (!this.workspaceSessionIds.has(sessionId)) throw new Error('会话不属于当前 workspace');
    this.selectedSessionId = sessionId;
    this.history = { events: [], hasMore: false };
    this.models = { status: 'loading', groups: [] };
    this.notify();
    await this.loadHistory(sessionId);
    await this.refreshModels(sessionId);
    return this.snapshot();
  }

  async create(): Promise<ConversationSnapshot> {
    if (this.initialSendPromise) return this.snapshot();
    const current = this.models.current;
    if (this.selectedSessionId) {
      this.pendingDraftModel = current?.advertised && current.configured
        ? { provider: current.provider, model: current.model, ...(current.reasoningEffort ? { reasoningEffort: current.reasoningEffort } : {}) }
        : undefined;
    }
    this.modelGeneration += 1;
    this.selectedSessionId = undefined;
    this.history = { events: [], hasMore: false };
    this.notify();
    return this.snapshot();
  }

  async selectModel(provider: string, model: string, reasoningEffort?: string): Promise<ConversationSnapshot> {
    const option = this.models.groups
      .find((group) => group.provider === provider)
      ?.models.find((candidate) => candidate.model === model);
    if (!option) throw new Error('所选模型不在当前 DSH 模型目录中');
    if (reasoningEffort !== undefined && !option.reasoningEfforts?.includes(reasoningEffort)) {
      throw new Error('所选思考强度不在当前模型支持范围内');
    }
    const selectedEffort = reasoningEffort ?? (
      this.models.current?.provider === provider && this.models.current.model === model
        ? this.models.current.reasoningEffort ?? option.defaultReasoningEffort
        : option.defaultReasoningEffort
    );

    // Existing-session path: persist the choice through session.selectModel.
    const sessionId = this.selectedSessionId;
    if (sessionId) {
      if (this.models.current?.provider === provider && this.models.current.model === model
        && this.models.current.reasoningEffort === selectedEffort) return this.snapshot();

      const generation = ++this.modelGeneration;
      this.models = { ...this.models, status: 'loading', message: undefined };
      this.notify();
      try {
        const value = await this.rpc('session.selectModel', {
          sessionId,
          provider,
          model,
          ...(selectedEffort ? { reasoningEffort: selectedEffort } : {}),
        });
        if (!isObject(value) || !isObject(value.selected)) throw new Error('DSH 未返回已选择模型');
        if (generation !== this.modelGeneration || sessionId !== this.selectedSessionId) return this.snapshot();
        this.models = {
          ...this.models,
          status: 'ready',
          current: modelSelectionSnapshot(value.selected, this.models.groups, this.configuredProviderIds),
          routable: true,
          message: undefined,
        };
        this.notify();
        return this.snapshot();
      } catch (error) {
        if (generation === this.modelGeneration && sessionId === this.selectedSessionId) {
          this.models = {
            ...this.models,
            status: 'error',
            message: error instanceof Error ? error.message : String(error),
          };
          this.notify();
        }
        throw error;
      }
    }

    // Draft path (no durable session yet): keep the choice in memory only and
    // reflect it in the snapshot current selection. Never call session.selectModel
    // or session.create here; the first send materializes exactly one session.
    const selected = modelSelectionSnapshot(
      { provider, model, ...(selectedEffort ? { reasoningEffort: selectedEffort } : {}) },
      this.models.groups,
      this.configuredProviderIds,
    );
    this.pendingDraftModel = { provider, model, ...(selectedEffort ? { reasoningEffort: selectedEffort } : {}) };
    this.models = {
      ...this.models,
      status: 'ready',
      current: selected,
      routable: this.models.routable,
    };
    this.notify();
    return this.snapshot();
  }

  async send(text: string, clientTimeZone?: string): Promise<ConversationSnapshot> {
    const prompt = text.trim();
    if (!prompt) throw new Error('消息不能为空');
    if (prompt.length > 100_000) throw new Error('消息过长');
    if (this.initialSendPromise) return this.initialSendPromise;
    if (!this.selectedSessionId) {
      const pending = this.sendInitial(prompt, clientTimeZone);
      this.initialSendPromise = pending;
      try {
        return await pending;
      } finally {
        if (this.initialSendPromise === pending) this.initialSendPromise = undefined;
      }
    }
    return this.sendToSession(this.selectedSessionId, prompt, clientTimeZone);
  }

  private async sendInitial(prompt: string, clientTimeZone?: string): Promise<ConversationSnapshot> {
    const sessionId = await this.materializeDraftSession();
    return this.sendToSession(sessionId, prompt, clientTimeZone);
  }

  private async sendToSession(sessionId: string, prompt: string, clientTimeZone?: string): Promise<ConversationSnapshot> {
    const running = this.sessions.get(sessionId)?.running === true;
    await this.rpc('session.prompt', {
      sessionId,
      mode: running ? 'steer' : 'queue',
      content: [{ type: 'text', text: prompt }],
      ...(clientTimeZone ? { clientTimeZone } : {}),
    });
    const summary = this.sessions.get(sessionId);
    if (summary) {
      summary.running = true;
      summary.blank = false;
      summary.updatedAt = Date.now();
    }
    if (this.selectedSessionId === sessionId) {
      await this.loadHistory(sessionId).catch(() => undefined);
    }
    this.notify();
    return this.snapshot();
  }

  private async materializeDraftSession(): Promise<string> {
    if (this.selectedSessionId) return this.selectedSessionId;
    if (this.materializeDraftPromise) return this.materializeDraftPromise;

    const pendingModel = this.pendingDraftModel;
    const operation = (async (): Promise<string> => {
      let target = [...this.sessions.values()].find(
        (session) => this.workspaceSessionIds.has(session.sessionId) && session.blank,
      );
      if (!target) {
        const created = await this.rpc('session.create', { workspaceId: this.workspaceId });
        if (!isObject(created) || typeof created.sessionId !== 'string') throw new Error('DSH 未返回新会话 id');
        // A host refresh started during creation may still contain the old index.
        // Let it settle before adding the successfully created session locally.
        if (this.refreshPromise) await this.refreshPromise.catch(() => undefined);
        target = {
          sessionId: created.sessionId,
          updatedAt: Date.now(),
          running: false,
          blank: true,
          cwd: this.workspace.path,
          ...(typeof created.agentPreset === 'string' ? { agentPreset: created.agentPreset } : {}),
        };
        this.sessions.set(target.sessionId, target);
        this.workspaceSessionIds.add(target.sessionId);
      }

      let nextModels = await this.fetchModels(target.sessionId);
      if (pendingModel) {
        const option = nextModels.groups
          .find((group) => group.provider === pendingModel.provider)
          ?.models.find((candidate) => candidate.model === pendingModel.model);
        if (!option) {
          throw new Error(`新会话无法使用原选择模型 ${pendingModel.provider}/${pendingModel.model}`);
        }
        if (nextModels.current?.provider !== pendingModel.provider
          || nextModels.current.model !== pendingModel.model
          || nextModels.current.reasoningEffort !== pendingModel.reasoningEffort) {
          const value = await this.rpc('session.selectModel', {
            sessionId: target.sessionId,
            provider: pendingModel.provider,
            model: pendingModel.model,
            ...(pendingModel.reasoningEffort ? { reasoningEffort: pendingModel.reasoningEffort } : {}),
          });
          if (!isObject(value) || !isObject(value.selected)) throw new Error('DSH 未返回已选择模型');
          nextModels = {
            ...nextModels,
            current: modelSelectionSnapshot(value.selected, nextModels.groups, this.configuredProviderIds),
            routable: true,
          };
        }
      }

      if (!this.selectedSessionId) {
        this.selectedSessionId = target.sessionId;
        this.history = { events: [], hasMore: false };
        this.models = nextModels;
        this.pendingDraftModel = undefined;
        this.notify();
      }
      return target.sessionId;
    })();
    this.materializeDraftPromise = operation;
    try {
      return await operation;
    } finally {
      if (this.materializeDraftPromise === operation) this.materializeDraftPromise = undefined;
    }
  }

  async cancel(): Promise<ConversationSnapshot> {
    if (!this.selectedSessionId) return this.snapshot();
    await this.rpc('session.cancel', { sessionId: this.selectedSessionId });
    return this.snapshot();
  }

  private async rpc(method: string, payload: Record<string, unknown> = {}): Promise<unknown> {
    const rpcId = randomUUID();
    const target = new URL(`/api/${method}`, this.baseUrl);
    const response = await fetch(target, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
    });
    if (!response.ok) throw new Error(`DSH ${method} 请求失败（HTTP ${response.status}）`);
    const envelope = await response.json() as RpcSuccess | RpcFailure;
    if (!isObject(envelope) || envelope.type !== 'server-response' || envelope.rpcId !== rpcId || !isObject(envelope.result)) {
      throw new Error(`DSH ${method} 返回了无效响应`);
    }
    if (envelope.result.ok) return envelope.result.value;
    const code = asString(envelope.result.error.code) ?? 'unknown';
    const message = asString(envelope.result.error.message) ?? '未知错误';
    throw new Error(`${message}（${code}）`);
  }

  private async refreshIndex(): Promise<void> {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = (async () => {
      const [sessionValue, workspaceValue] = await Promise.all([
        this.rpc('session.list'),
        this.rpc('workspace.list'),
      ]);
      if (!isObject(sessionValue) || !Array.isArray(sessionValue.items)) throw new Error('DSH 会话列表格式无效');
      if (!isObject(workspaceValue) || !Array.isArray(workspaceValue.items)) throw new Error('DSH workspace 列表格式无效');
      const workspace = workspaceValue.items.find((item) => isObject(item) && item.workspaceId === this.workspaceId);
      if (!isObject(workspace) || !Array.isArray(workspace.sessionIds)) throw new Error('DSH 未注册产品 workspace');
      this.workspaceSessionIds = new Set(workspace.sessionIds.filter((id): id is string => typeof id === 'string'));
      const next = new Map<string, RawSessionSummary>();
      for (const item of sessionValue.items) {
        if (!isObject(item) || typeof item.sessionId !== 'string' || !this.workspaceSessionIds.has(item.sessionId)) continue;
        next.set(item.sessionId, {
          sessionId: item.sessionId,
          updatedAt: asNumber(item.updatedAt) ?? 0,
          running: item.running === true,
          blank: item.blank === true,
          ...(typeof item.cwd === 'string' ? { cwd: item.cwd } : {}),
          ...(typeof item.agentPreset === 'string' ? { agentPreset: item.agentPreset } : {}),
          ...(isObject(item.projections) ? { projections: item.projections as RawSessionSummary['projections'] } : {}),
        });
      }
      this.sessions = next;
    })().finally(() => { this.refreshPromise = undefined; });
    return this.refreshPromise;
  }

  private async loadHistory(sessionId: string): Promise<void> {
    const history = this.history;
    const existing = new Set(history.events);
    const value = await this.rpc('session.history', { sessionId, maxMessages: 80 });
    if (!isObject(value) || !Array.isArray(value.events)) throw new Error('DSH 会话历史格式无效');
    // A selection change or another completed load makes this response obsolete.
    if (this.selectedSessionId !== sessionId || this.history !== history) return;
    const page = value.events.filter((entry): entry is HistoryEntry => isObject(entry) && isObject(entry.event));
    // Preserve frames received while fetching, even if the bounded buffer trimmed
    // older entries. The returned page owns duplicate seqs and pagination metadata.
    const live = history.events.filter((entry) => !existing.has(entry));
    const seen = new Set<number>();
    const events = [...page, ...live].filter((entry) => {
      const seq = asNumber(entry.event.seq);
      if (seq === undefined) return true;
      if (seen.has(seq)) return false;
      seen.add(seq);
      return true;
    });
    events.sort((a, b) => {
      const left = asNumber(a.event.seq);
      const right = asNumber(b.event.seq);
      return left !== undefined && right !== undefined ? left - right : 0;
    });
    this.history = { events, hasMore: value.hasMore === true };
  }

  /**
   * Load the model catalog. With a `sessionId` the per-session directory comes
   * from `session.models`; without one the host-scoped draft catalog comes from
   * `llm.models`. Both share the same strict projection path, so the picker is
   * identically shaped before and after a session exists.
   */
  private async refreshModels(sessionId?: string): Promise<void> {
    const generation = ++this.modelGeneration;
    this.models = { ...this.models, status: 'loading', message: undefined };
    this.notify();
    try {
      const next = await this.fetchModels(sessionId);
      if (generation !== this.modelGeneration) return;
      if (sessionId && sessionId !== this.selectedSessionId) return;
      this.models = next;
      this.notify();
    } catch (error) {
      if (generation !== this.modelGeneration) return;
      if (sessionId && sessionId !== this.selectedSessionId) return;
      this.models = {
        ...this.models,
        status: 'error',
        message: error instanceof Error ? error.message : String(error),
      };
      this.notify();
    }
  }

  private async fetchModels(sessionId?: string): Promise<ConversationModelsSnapshot> {
    const value = await this.rpc(sessionId ? 'session.models' : 'llm.models', sessionId ? { sessionId } : {});
    if (!sessionId) return projectHostModels(value, [...this.configuredProviderIds]);
    let next = projectConversationModels(value, [...this.configuredProviderIds]);
    const repair = isObject(value)
      ? persistedModelSelectionRepair(value.current, next.groups)
      : undefined;
    if (!repair) return next;
    const repaired = await this.rpc('session.selectModel', { sessionId, ...repair });
    if (!isObject(repaired) || !isObject(repaired.selected)) throw new Error('DSH 未返回归一化后的模型选择');
    const selected = modelSelectionSnapshot(repaired.selected, next.groups, this.configuredProviderIds);
    if (selected.provider !== repair.provider || selected.model !== repair.model) {
      throw new Error('DSH 未持久化归一化后的模型选择');
    }
    next = { ...next, current: selected };
    return next;
  }

  private openStream(name: 'events.mux' | 'events.host', attempt = 0): void {
    if (this.stopped) return;
    const url = new URL(`/api/${name}`, this.baseUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(url);
    this.sockets.add(socket);
    socket.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') return;
      try {
        const envelope: unknown = JSON.parse(event.data);
        if (!isObject(envelope) || envelope.type !== 'server-request' || !isObject(envelope.payload)) return;
        if (name === 'events.mux') this.handleMux(envelope.payload);
        else this.handleHost(envelope.payload);
      } catch {
        // A malformed push is isolated from the rest of the Desktop runtime.
      }
    });
    socket.addEventListener('close', () => {
      this.sockets.delete(socket);
      if (this.stopped) return;
      const delay = Math.min(5_000, 300 * (2 ** Math.min(attempt, 4)));
      const timer = setTimeout(() => {
        this.reconnectTimers.delete(timer);
        void this.refreshIndex()
          .then(async () => {
            if (!this.selectedSessionId) return;
            await this.loadHistory(this.selectedSessionId);
            await this.refreshModels(this.selectedSessionId);
          })
          .catch(() => undefined)
          .finally(() => this.openStream(name, attempt + 1));
      }, delay);
      this.reconnectTimers.add(timer);
    });
  }

  private handleMux(frame: Record<string, unknown>): void {
    const type = asString(frame.type);
    const sessionId = asString(frame.sessionId);
    if (!sessionId || !this.workspaceSessionIds.has(sessionId)) return;
    if (type === 'session/event' && isObject(frame.event)) {
      const event = frame.event;
      const seq = asNumber(event.seq);
      const latest = this.history.events.at(-1)?.event;
      const latestSeq = latest ? asNumber(latest.seq) : undefined;
      if (sessionId === this.selectedSessionId && (seq === undefined || latestSeq === undefined || seq > latestSeq)) {
        this.projection = undefined;
        this.history.events.push({ event, ...(frame.view !== undefined ? { view: frame.view } : {}) });
        if (this.history.events.length > 8_000) this.history.events.splice(0, this.history.events.length - 8_000);
      }
      const summary = this.sessions.get(sessionId);
      if (summary) {
        summary.updatedAt = eventTime(event);
        if (event.type === 'turn/start') {
          summary.running = true;
          summary.blank = false;
        }
        if (event.type === 'turn/end') {
          summary.running = false;
          // A terminal turn boundary is delivered immediately rather than waiting
          // out the burst window, so completion/usage never arrives late.
          this.flushNotify();
          return;
        }
        if (event.type === 'session/title' && isObject(event.data) && typeof event.data.title === 'string') {
          summary.projections = { values: { ...(summary.projections?.values ?? {}), title: event.data.title } };
        }
      }
      this.notify();
      return;
    }
    if (type === 'session/projection' && frame.key === 'title') {
      const summary = this.sessions.get(sessionId);
      if (summary) summary.projections = { values: { ...(summary.projections?.values ?? {}), title: frame.value } };
      this.notify();
    }
  }

  private handleHost(frame: Record<string, unknown>): void {
    const type = asString(frame.type);
    const sessionId = asString(frame.sessionId);
    if (type === 'host/remote-event'
      && (frame.event === 'llm/adapters-updated' || frame.event === 'settings/document-updated')) {
      if (this.selectedSessionId) void this.refreshModels(this.selectedSessionId);
      return;
    }
    if (type === 'host/session-status' && sessionId && this.workspaceSessionIds.has(sessionId)) {
      const summary = this.sessions.get(sessionId);
      if (summary) {
        summary.running = frame.running === true;
        if (summary.running) summary.blank = false;
      }
      this.notify();
      return;
    }
    if (type?.startsWith('host/session-') || type === 'host/workspace-changed') {
      void this.refreshIndex().then(() => this.notify()).catch(() => undefined);
    }
  }

  /**
   * Coalesce burst notifications (one per streamed chunk) onto a short timer.
   * The delay never delays delivery: a snapshot always follows the burst that
   * requested it, and `flushNotify` delivers a terminal boundary on its own
   * clock so completion/usage never waits out the window.
   */
  private notify(): void {
    if (this.notifyTimer) return;
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = undefined;
      this.onChanged();
    }, 100);
  }

  /** Deliver a notification now, collapsing any burst still inside the window. */
  private flushNotify(): void {
    if (this.notifyTimer) {
      clearTimeout(this.notifyTimer);
      this.notifyTimer = undefined;
    }
    this.onChanged();
  }
}

export function unavailableConversation(
  workspace: WorkspaceConfigurationSnapshot,
  message?: string,
): ConversationSnapshot {
  return {
    status: workspace.status === 'configured' ? 'unavailable' : 'workspace-required',
    workspace,
    sessions: [],
    selectedRunning: false,
    models: { status: 'idle', groups: [] },
    hasMore: false,
    items: [],
    message: message ?? (workspace.status === 'configured'
      ? 'DSH 会话后端暂时不可用'
      : '请先配置 Wrenyard workspace 路径'),
  };
}
