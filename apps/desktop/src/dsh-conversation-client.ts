import { randomUUID } from 'node:crypto';
import { canonicalizeBuiltinPublicModelId, createBuiltinCatalog } from '@wrenyard/providers';
import { getEncoding } from 'js-tiktoken';
import { parseTaskRunSnapshot } from './stats-snapshot.js';
import {
  CONVERSATION_STATE_VERSION,
  ConversationStateStore,
  type ConversationStateDocument,
  type ConversationStateMessage,
  type ConversationStateRecord,
  type ConversationStateTurn,
} from './conversation-state.js';
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

/**
 * Context for one summarization call: every previously completed turn's user
 * message and summary, plus the exact work text of the turn being summarized.
 * Only previous messages are supplied — never the full transcript.
 */
export interface ConversationSummaryInput {
  previousSummaries: Array<{ user: string; summary: string }>;
  user: string;
  work: string;
  signal: AbortSignal;
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
  /**
   * Optional one-shot summarizer. When supplied, a completed DSH turn's entire
   * text stays `work` and the model's visible answer becomes a separate final
   * assistant message produced by exactly one call to this callback. When it is
   * absent the legacy behavior is preserved: the completed DSH text is the
   * final assistant message.
   */
  summarize?(input: ConversationSummaryInput): Promise<string>;
  /**
   * Absolute path of the product-owned conversation document. When supplied,
   * the linear conversation, its execution-session mapping, and the frozen
   * terminal turn telemetry persist across restarts. Omitted → memory only.
   */
  statePath?: string;
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
 *
 * `limit` bounds the projected transcript to its newest items; a caller that
 * owns the complete process of one branch passes `Infinity` so nothing the turn
 * actually did is dropped.
 */
export function projectConversation(
  entries: HistoryEntry[],
  limit = 240,
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
    items: sortedItems.slice(-limit).map(({ order: _order, seq: _seq, ...item }) => item),
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

/**
 * The execution cut one turn was sent with. It is decided synchronously at send
 * time and never revisited, so a turn can never adopt a base that another
 * parallel turn established while it was waiting on an RPC:
 *
 * - `fork`  — an exact completed cut to fork from, with its inclusive `atSeq`.
 * - `root`  — the conversation's own established blank root may run this turn.
 * - `blank` — an independent blank execution of this turn's own, because an
 *   unfinished branch can never be forked and the root is already spoken for.
 */
type ForkPlan =
  | { kind: 'fork'; sessionId: string; atSeq?: number }
  | { kind: 'root' }
  | { kind: 'blank' };

/**
 * One local product turn: the optimistic display state the user sees and the
 * execution branch that backs it. Created synchronously on send, so several
 * turns can run in parallel and each one owns its own DSH session.
 */
interface LocalTurn {
  id: string;
  /** Ordering key of this turn in the linear conversation. */
  seq: number;
  /**
   * Stable identity of the independent logical conversation this turn
   * belongs to. Starts as a synthetic local id for a turn created before its
   * conversation's DSH root session is known, and is rekeyed to that exact
   * session id the moment it resolves — never the globally selected
   * conversation, so a turn always stays owned by the conversation it was
   * actually sent from even if the selection changes underneath it.
   */
  conversationId: string;
  /** Stable identity of the optimistic user message. */
  userItemId: string;
  prompt: string;
  clientTimeZone?: string;
  status: 'running' | 'completed' | 'cancelled' | 'failed';
  startedAt: number;
  endedAt?: number;
  /** The execution session of this turn's branch; absent until it exists. */
  sessionId?: string;
  /** The completed session this turn forked from, when there was one. */
  forkParentSessionId?: string;
  /** Inclusive `session.fork` cut, when it was known at fork time. */
  forkAtSeq?: number;
  /** Base adopted for the next send once this turn completes. */
  baseSessionId?: string;
  baseAtSeq?: number;
  /** The immutable execution cut captured for this turn at send time. */
  forkPlan: ForkPlan;
  /** Model choice captured at send time, applied before the branch prompts. */
  pendingModel?: Pick<ConversationModelSelectionSnapshot, 'provider' | 'model' | 'reasoningEffort'>;
  /** Context captured at send time: only turns completed before it. */
  previousSummaries: Array<{ user: string; summary: string }>;
  /** Retained DSH events of this turn's own branch only. */
  entries: HistoryEntry[];
  /** Last observed seq inside `entries`, for live frame gating. */
  lastSeq?: number;
  /**
   * Highest event seq this branch inherited from its fork cut, including the
   * trailing standalone events a fork replays above the cut itself. Events at
   * or below it are the forked-from history and are never this turn's own.
   */
  inheritedMaxSeq?: number;
  /** True once this turn's own branch reported its terminal `turn/end`. */
  dshEnded?: boolean;
  /** Exact `turn/end` time of this turn's own branch. */
  dshEndedAt?: number;
  work?: string;
  /**
   * The turn's own chronological process items, frozen when its branch ended.
   * They stay the visible process of a settled turn and survive a restart, so
   * the answer is never the only thing left of the work that produced it.
   */
  processItems?: ConversationItemSnapshot[];
  summary?: string;
  /** The distinct final assistant message of this turn, once produced. */
  summaryItem?: ConversationItemSnapshot;
  finalItemId?: string;
  /** Frozen terminal telemetry of this turn; never recomputed after it ends. */
  dispatchCount?: number;
  inputTokens?: number;
  outputTokens?: number;
  outputTps?: number;
  error?: string;
  /** Generation identity of the summarization call, so a stale one is ignored. */
  summaryGeneration?: number;
  /**
   * Count of `cancel()` calls that reached this turn. The executing turn
   * compares it across the prompt round trip so that a cancel already stopped
   * by `cancel()` itself is never re-issued to DSH.
   */
  cancelRequested?: number;
  /** True once `cancel()` itself has issued the DSH stop for this turn. */
  cancelReachedDsh?: boolean;
  summaryController?: AbortController;
}

export class DshConversationClient {
  private readonly baseUrl: URL;
  private readonly workspaceId: string;
  private readonly workspace: DshConversationClientOptions['workspace'];
  private readonly configuredProviderIds: ReadonlySet<string>;
  private readonly summarize?: (input: ConversationSummaryInput) => Promise<string>;
  private readonly onChanged: () => void;
  private sessions = new Map<string, RawSessionSummary>();
  private workspaceSessionIds = new Set<string>();
  private sessionHistory = new Map<string, HistoryPage>();
  private models: ConversationModelsSnapshot = { status: 'idle', groups: [] };
  private modelGeneration = 0;
  private pendingDraftModel: Pick<ConversationModelSelectionSnapshot, 'provider' | 'model' | 'reasoningEffort'> | undefined;
  private stopped = false;
  private sockets = new Set<WebSocket>();
  private reconnectTimers = new Set<ReturnType<typeof setTimeout>>();
  private notifyTimer: ReturnType<typeof setTimeout> | undefined;
  private refreshPromise: Promise<void> | undefined;
  /**
   * Every turn ever created, across every independent logical conversation
   * this client has held in memory. Never wiped by New or by switching the
   * selection — only `conversationId` scoping decides what is rendered, so a
   * conversation's turns and its own background work survive both.
   */
  private turns: LocalTurn[] = [];
  private turnsById = new Map<string, LocalTurn>();
  /**
   * Monotonic turn counter shared by every conversation, so a turn id is
   * unique across the whole workspace and a per-turn cancel can never reach a
   * turn of a different conversation.
   */
  private turnSequence = 0;
  /** Next synthetic id handed to a conversation before its DSH root is known. */
  private localConversationSequence = 0;
  private state: ConversationStateStore | undefined;
  /** Visible warning when the conversation document could not be written. */
  private persistWarning: string | undefined;
  private projectionRevision = 0;
  /** Session id → owning turn id for the lifetime of a running turn. */
  private ownedSessions = new Map<string, string>();
  /** Generated fork sessions; these are internal and never appear in the sidebar. */
  private forkSessions = new Set<string>();
  /** Conversation identity → the DSH root session that anchors it. */
  private conversationRoots = new Map<string, string>();
  /** In-flight root establishment, shared by every turn of one conversation. */
  private rootCreations = new Map<string, Promise<string>>();
  /**
   * Conversations whose established blank root has already been handed to a
   * turn. Before any completed cut exists only the first turn may run on it;
   * every other concurrent turn needs its own blank execution, because DSH
   * cannot fork a branch that has not finished a turn.
   */
  private blankRootClaims = new Set<string>();
  /**
   * Identity of the conversation currently selected in the UI: either a
   * resolved DSH root session id or, before that is known, the synthetic id
   * minted for it. `undefined` only when nothing has ever been selected or
   * started yet.
   */
  private activeConversationId: string | undefined;

  /** Root session of the selected conversation; absent for an unsent draft. */
  private get conversationRootId(): string | undefined {
    return this.activeConversationId ? this.conversationRoots.get(this.activeConversationId) : undefined;
  }

  constructor(options: DshConversationClientOptions) {
    this.baseUrl = new URL(options.baseUrl);
    this.workspaceId = options.workspaceId;
    this.workspace = options.workspace;
    this.configuredProviderIds = new Set(options.configuredProviderIds);
    this.summarize = options.summarize;
    this.onChanged = options.onChanged;
    if (options.statePath) {
      this.state = new ConversationStateStore({
        path: options.statePath,
        workspaceScope: options.workspaceId,
      });
    }
  }

  async start(): Promise<void> {
    this.restoreConversation();
    await this.refreshIndex();
    if (this.activeConversationId === undefined) {
      // A host-created blank session is only reusable implementation state for
      // the first send; it is not yet a product conversation and must not
      // appear selected in the fresh draft UI. This heuristic only runs when
      // restoring the persisted document left nothing selected — it must never
      // override a conversation that was actually restored.
      const first = [...this.sessions.values()].find(
        (session) => !session.blank && !this.forkSessions.has(session.sessionId),
      );
      if (first) {
        this.adoptConversation(first.sessionId);
        await this.loadHistory(first.sessionId);
        await this.refreshModels(first.sessionId);
      } else {
        // Fresh workspace with no durable session: load the host-scoped draft
        // model catalog via llm.models so the picker is ready before any session
        // is created. No session.create is issued here.
        await this.refreshModels();
      }
    } else if (this.conversationRootId !== undefined && this.workspaceSessionIds.has(this.conversationRootId)) {
      // The restored conversation's root session is still known to DSH.
      await this.loadHistory(this.conversationRootId);
      await this.refreshModels(this.conversationRootId);
    } else {
      // The restored conversation's root session is gone (or never existed);
      // its restored turns still display, but the picker falls back to the
      // host-scoped draft catalog.
      await this.refreshModels();
    }
    this.openStream('events.mux');
    this.openStream('events.host');
  }

  stop(): void {
    this.stopped = true;
    this.modelGeneration += 1;
    for (const turn of this.turns) turn.summaryController?.abort();
    if (this.notifyTimer) clearTimeout(this.notifyTimer);
    for (const timer of this.reconnectTimers) clearTimeout(timer);
    this.reconnectTimers.clear();
    for (const socket of this.sockets) socket.close();
    this.sockets.clear();
  }

  snapshot(): ConversationSnapshot {
    const sessions = [...this.sessions.values()]
      .filter((session) => this.workspaceSessionIds.has(session.sessionId))
      // Internal fork sessions are execution detail, not conversations: they
      // never appear in the sidebar, whether running or completed.
      .filter((session) => !this.forkSessions.has(session.sessionId))
      // A blank session is implementation state until it anchors a
      // conversation; every conversation root stays listed, selected or not.
      .filter((session) => !session.blank || [...this.conversationRoots.values()].includes(session.sessionId))
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .map((session): ConversationSessionSnapshot => ({
        id: session.sessionId,
        title: titleFromSummary(session),
        updatedAt: session.updatedAt,
        running: session.running,
        blank: session.blank,
        ...(session.agentPreset ? { agentPreset: session.agentPreset } : {}),
      }));
    const selectedId = this.conversationRootId;
    const selected = selectedId ? this.sessions.get(selectedId) : undefined;
    const projection = this.conversationProjection();
    // A turn of the selected conversation may still run on a branch whose own
    // session summary is not the selected one, so the conversation counts as
    // running while any of its own turns does.
    const running = selected?.running === true || this.turns.some(
      (turn) => turn.conversationId === this.activeConversationId && turn.status === 'running',
    );
    return {
      status: 'ready',
      workspace: this.workspace,
      sessions,
      ...(selected ? {
        selectedSessionId: selected.sessionId,
        selectedTitle: titleFromSummary(selected),
      } : {}),
      // A background turn keeps the conversation "running" even while its own
      // execution session is no longer selected.
      selectedRunning: running,
      models: this.models,
      hasMore: false,
      items: projection.items,
      ...(projection.turns.length > 0 ? { turns: projection.turns } : {}),
      ...(this.persistWarning ? { message: this.persistWarning } : {}),
    };
  }

  /** The turns owned by one conversation, in send order. */
  private turnsOf(conversationId: string | undefined): LocalTurn[] {
    if (conversationId === undefined) return [];
    return this.turns
      .filter((turn) => turn.conversationId === conversationId)
      .sort((left, right) => left.seq - right.seq);
  }

  /**
   * Project exactly one linear conversation: the one currently selected. Turns
   * of every other conversation stay in memory untouched and simply do not
   * appear, so switching the selection never destroys another conversation's
   * work — including work still running in the background.
   *
   * The optimistic user/turn snapshot is created at send time and never
   * inherited: a turn's items come only from the events of its own execution
   * branch, so no forked-in history is shown and a turn's own history is never
   * copied into a later turn.
   *
   * While a turn runs, its own branch work is shown live. Once it settles, all
   * of that DSH text is `work`: with a summarizer the turn exposes only the
   * distinct final assistant message, and the raw work never becomes the
   * answer. Send order, not completion order, defines the transcript.
   */
  private conversationProjection(): ConversationProjection {
    const revision = ++this.projectionRevision;
    const owner = this.activeConversationId;
    // Assistant/tool items live between their opening user message and the next
    // one, so the linear transcript keeps the send order even when a later turn
    // completes first.
    const ordered = this.turnsOf(owner);
    // A DSH session a product turn actually *ran on* is already represented by
    // that turn. Merely forking from a session is not: a legacy conversation
    // keeps its own durable transcript after the first managed turn branches
    // off it, instead of disappearing the moment it becomes a fork parent.
    const executed = new Set(ordered
      .map((turn) => turn.sessionId)
      .filter((id): id is string => id !== undefined));
    const root = this.conversationRootId;
    const legacy = root !== undefined && !executed.has(root) ? this.sessionHistory.get(root) : undefined;
    // A legacy session's own DSH turns are its history's timing metadata, and
    // DSH turn ids repeat across sessions, so they are namespaced apart from
    // the product turns that later continue the same conversation.
    const inherited = legacy && legacy.events.length > 0 ? projectConversation(legacy.events) : undefined;
    const items: ConversationItemSnapshot[] = (inherited?.items ?? []).map((item) => ({
      ...item,
      id: `legacy-${item.id}`,
      ...(item.turnId ? { turnId: `legacy-${item.turnId}` } : {}),
    }));
    const legacyTurns = (inherited?.turns ?? []).map((turn) => ({
      ...turn,
      id: `legacy-${turn.id}`,
      ...(turn.finalItemId ? { finalItemId: `legacy-${turn.finalItemId}` } : {}),
    }));
    for (const turn of ordered) {
      items.push({
        id: turn.userItemId,
        kind: 'user',
        text: turn.prompt,
        time: turn.startedAt,
        turnId: turn.id,
      });
      // The turn's own process stays visible after it settles: the work is the
      // process block, and the answer is a separate final item. A running turn
      // projects its live branch; a settled one its frozen process.
      items.push(...(turn.processItems ?? this.liveProcessItems(turn)));
      const finalItem = this.finalItemFor(turn);
      if (finalItem) items.push(finalItem);
    }
    return {
      items,
      turns: [...legacyTurns, ...this.turnSnapshots()],
      source: [],
      sourceLength: 0,
      revision,
    };
  }

  /**
   * The running turn's own branch items. Branch item ids are only unique inside
   * their own execution session and DSH's own turn ids repeat across branches,
   * so both are namespaced by the product turn that owns them. An inherited
   * user message is execution detail of the forked cut and never re-enters the
   * transcript, which already carries this turn's own prompt.
   */
  private liveProcessItems(turn: LocalTurn): ConversationItemSnapshot[] {
    if (turn.entries.length === 0) return [];
    return projectConversation(turn.entries, Number.POSITIVE_INFINITY).items
      .filter((item) => item.kind !== 'user')
      .map((item) => ({ ...item, id: `${turn.id}:${item.id}`, turnId: turn.id }));
  }

  async select(sessionId: string): Promise<ConversationSnapshot> {
    if (!this.workspaceSessionIds.has(sessionId)) throw new Error('会话不属于当前 workspace');
    // Fork sessions are internal execution branches; selecting one as the
    // product conversation is never a renderer operation.
    if (this.forkSessions.has(sessionId)) return this.snapshot();
    // Switching the selection only moves which conversation is projected; the
    // previously selected conversation's own turns and background work stay
    // exactly as they were, ready to be selected again later.
    this.adoptConversation(sessionId);
    // The selection itself is part of the durable document, so a restart
    // reopens the conversation the user was actually looking at.
    this.persistConversation();
    await this.loadHistory(sessionId);
    await this.refreshModels(sessionId);
    return this.snapshot();
  }

  async create(): Promise<ConversationSnapshot> {
    const current = this.models.current;
    if (this.conversationRootId) {
      this.pendingDraftModel = current?.advertised && current.configured
        ? { provider: current.provider, model: current.model, ...(current.reasoningEffort ? { reasoningEffort: current.reasoningEffort } : {}) }
        : undefined;
    }
    this.modelGeneration += 1;
    // New is a local reset, not a DSH call: it only clears the selected UI
    // draft, and no durable session is created until a non-empty send
    // arrives. Every other conversation — running, background, or merely not
    // selected — is completely untouched, so its work is never lost.
    this.beginConversation();
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
    // A root a turn is executing on right now is never mutated by the picker —
    // changing the model under a live branch would rewrite work in flight. The
    // choice is kept in memory instead, and the next send captures it.
    const rootId = this.conversationRootId;
    const sessionId = rootId !== undefined && !this.turns.some(
      (turn) => turn.status === 'running' && turn.sessionId === rootId,
    ) ? rootId : undefined;
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
        if (generation !== this.modelGeneration || sessionId !== this.conversationRootId) return this.snapshot();
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
        if (generation === this.modelGeneration && sessionId === this.conversationRootId) {
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

    // Draft path (no durable conversation yet): keep the choice in memory only
    // and reflect it in the snapshot current selection. Never call
    // session.selectModel or session.create here; the first send applies it.
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

  /**
   * Start one independent user turn.
   *
   * The optimistic user message and running turn snapshot are created
   * synchronously, before any RPC, so a second send never waits for the first
   * one. Each turn then forks its own execution session from the latest
   * *completed* cut and prompts it independently — no steer and no queue, so
   * parallel sends cannot interfere with each other.
   */
  async send(text: string, clientTimeZone?: string): Promise<ConversationSnapshot> {
    const prompt = text.trim();
    if (!prompt) throw new Error('消息不能为空');
    if (prompt.length > 100_000) throw new Error('消息过长');
    // A send with nothing selected starts a fresh conversation, still in
    // memory only. A send into an already-selected conversation — whether it
    // was just created, switched to, or restored from disk — always appends.
    // The owning conversation is captured synchronously, before any await, so
    // the turn belongs to the conversation it was actually sent from.
    const conversationId = this.activeConversationId ?? this.beginConversation();
    const turn = this.createTurn(conversationId, prompt, clientTimeZone);
    this.notify();
    void this.executeTurn(turn).catch(() => undefined);
    return this.snapshot();
  }

  /**
   * Cancel one user turn. With no `turnId` the oldest still-running turn is
   * cancelled. Only that turn's own execution session is stopped, and its
   * in-flight summarization is aborted, so parallel turns are unaffected.
   */
  async cancel(turnId?: string): Promise<ConversationSnapshot> {
    const target = turnId
      ? this.turnsById.get(turnId)
      : [...this.turns]
        .filter((turn) => turn.conversationId === this.activeConversationId)
        .sort((left, right) => left.seq - right.seq)
        .find((turn) => turn.status === 'running');
    if (!target || target.status !== 'running') return this.snapshot();
    target.summaryController?.abort();
    target.cancelRequested = (target.cancelRequested ?? 0) + 1;
    const sessionId = target.sessionId;
    this.finishTurn(target, 'cancelled');
    if (sessionId) {
      await this.rpc('session.cancel', { sessionId }).catch(() => undefined);
      // DSH itself has now stopped the work, so the executing turn must not
      // issue a second, redundant stop for the same cancel.
      target.cancelReachedDsh = true;
      const summary = this.sessions.get(sessionId);
      if (summary) summary.running = false;
    }
    this.notify();
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

  /**
   * Merge one DSH history page into a retained buffer. The returned page owns
   * duplicate seqs, so identical seqs are folded once and the merged buffer is
   * ordered by the observed event seq — a recovered entry may arrive after a
   * live frame it precedes.
   */
  private mergeHistoryPage(history: HistoryPage, value: unknown, live: HistoryEntry[]): HistoryPage {
    if (!isObject(value) || !Array.isArray(value.events)) throw new Error('DSH 会话历史格式无效');
    const page = value.events.filter((entry): entry is HistoryEntry => isObject(entry) && isObject(entry.event));
    // The fetched page is authoritative for any seq it contains; frames that
    // arrived while it was in flight only contribute the seqs it could not have
    // had yet, so a late response never discards live output.
    const seen = new Set<number>();
    const events = [...page, ...live, ...history.events].filter((entry) => {
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
    return { events, hasMore: value.hasMore === true };
  }

  /** Load the durable history of one ordinary (non-fork) conversation session. */
  private async loadHistory(sessionId: string): Promise<void> {
    // Snapshot the frames already received before awaiting the page.
    const before = (this.sessionHistory.get(sessionId) ?? { events: [], hasMore: false }).events;
    const live = [...before];
    const value = await this.rpc('session.history', { sessionId, maxMessages: 80 });
    if (this.conversationRootId !== sessionId) return;
    const current = this.sessionHistory.get(sessionId) ?? { events: [], hasMore: false };
    // Keep only the frames that arrived during the round trip; the pre-await
    // ones are already represented by the page.
    const fresh = current.events.filter((entry) => !live.includes(entry));
    this.sessionHistory.set(sessionId, this.mergeHistoryPage(current, value, [...live, ...fresh]));
  }

  private async loadTurnHistory(turn: LocalTurn, sessionId: string): Promise<void> {
    // Snapshot the branch frames already received before awaiting the page, so
    // events still routed into this turn during the round trip survive.
    const live = [...turn.entries];
    const value = await this.rpc('session.history', { sessionId, maxMessages: 80 });
    if (turn.sessionId !== sessionId) return;
    const merged = this.mergeHistoryPage({ events: turn.entries, hasMore: false }, value, live);
    // A refresh merges only this turn's own events: the inherited cut a fork
    // replayed stays execution detail no matter which path delivered it.
    turn.entries = merged.events.filter((entry) => this.isOwnEvent(turn, entry));
    turn.lastSeq = this.lastSeqOf(turn.entries);
    this.updateTurnTelemetry(turn);
    this.notify();
  }

  /** Whether one retained event is this turn's own rather than inherited. */
  private isOwnEvent(turn: LocalTurn, entry: HistoryEntry): boolean {
    if (turn.inheritedMaxSeq === undefined) return true;
    const seq = asNumber(entry.event.seq);
    return seq === undefined || seq > turn.inheritedMaxSeq;
  }

  private lastSeqOf(entries: HistoryEntry[]): number | undefined {
    let last: number | undefined;
    for (const entry of entries) {
      const seq = asNumber(entry.event.seq);
      if (seq !== undefined && (last === undefined || seq > last)) last = seq;
    }
    return last;
  }

  /**
   * Freeze the terminal per-turn telemetry from the turn's own branch. The
   * projection owns the exact turn/start→turn/end boundaries and the TPS
   * window, so completion/usage is copied verbatim once the turn ends.
   */
  private updateTurnTelemetry(turn: LocalTurn): void {
    // Terminal telemetry is captured exactly once. A frame arriving on the same
    // branch after its `turn/end` never recomputes a settled turn's stats.
    if (turn.dshEnded || turn.entries.length === 0 || turn.status !== 'running') return;
    const projected = projectConversation(turn.entries, Number.POSITIVE_INFINITY);
    const match = projected.turns.find((candidate) => candidate.running === false) ?? projected.turns.at(-1);
    if (!match) return;
    if (match.inputTokens !== undefined) turn.inputTokens = match.inputTokens;
    if (match.outputTokens !== undefined) turn.outputTokens = match.outputTokens;
    if (match.outputTps !== undefined) turn.outputTps = match.outputTps;
    // A DSH turn that never ended is still running and keeps waiting for its
    // own `turn/end`; only that event closes the branch.
    if (match.running || match.endedAt === undefined) return;
    turn.dshEnded = true;
    turn.dshEndedAt = match.endedAt;
    turn.dispatchCount = projected.turns.reduce((sum, candidate) => sum + candidate.dispatchCount, 0);
    turn.processItems = this.freezeProcessItems(turn);
    // Everything the branch actually did — its prose and its tool calls and
    // results — is the work the summarizer receives.
    turn.work = this.workTextOf(turn.processItems);
    if (match.finalItemId === undefined) {
      // An unclean end still tells the user what happened, without exposing the
      // raw work text as if it were an answer.
      turn.error = this.turnEndError(turn.entries);
      turn.endedAt = match.endedAt;
      this.finishTurn(turn, 'failed');
      return;
    }
    // The product turn stays running through exactly one summarization call, so
    // a cancel arriving mid-summary still reaches it.
    void this.summarizeTurn(turn);
  }

  /** The turn's own process, frozen: a settled item is never still running. */
  private freezeProcessItems(turn: LocalTurn): ConversationItemSnapshot[] {
    return this.liveProcessItems(turn).map(({ running: _running, ...item }) => item);
  }

  /** Concise, non-leaking description of why a turn did not complete cleanly. */
  private turnEndError(entries: HistoryEntry[]): string {
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const event = entries[index]?.event;
      if (asString(event?.type) !== 'turn/end') continue;
      const data = isObject(event?.data) ? event.data : {};
      const reason = isObject(data.reason) ? data.reason : undefined;
      const kind = asString(reason?.kind);
      if (kind === 'cancelled') return '已取消';
      if (kind === 'aborted') return '已中断';
      const message = asString(reason?.message);
      return message ? `未完成：${message}` : '未完成';
    }
    return '未完成';
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
      if (sessionId && sessionId !== this.conversationRootId) return;
      this.models = next;
      this.notify();
    } catch (error) {
      if (generation !== this.modelGeneration) return;
      if (sessionId && sessionId !== this.conversationRootId) return;
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
            // A branch that was still running when the stream dropped is
            // recovered from its own durable history, so the frames missed
            // during the outage are not lost with the socket.
            for (const turn of this.turns) {
              if (turn.status !== 'running' || turn.sessionId === undefined) continue;
              await this.loadTurnHistory(turn, turn.sessionId).catch(() => undefined);
            }
            if (!this.conversationRootId) return;
            await this.loadHistory(this.conversationRootId);
            await this.refreshModels(this.conversationRootId);
          })
          .catch(() => undefined)
          .finally(() => this.openStream(name, attempt + 1));
      }, delay);
      this.reconnectTimers.add(timer);
    });
  }

  /**
   * Route one mux frame by session identity. A frame for an execution branch
   * is namespaced into that turn's own retained events; a frame for the
   * conversation session feeds the ordinary history. Events for a cancelled
   * turn are dropped, so a late frame can never revive it. Sessions owned by
   * another workspace are ignored.
   */
  private handleMux(frame: Record<string, unknown>): void {
    const type = asString(frame.type);
    const sessionId = asString(frame.sessionId);
    if (!sessionId) return;
    const owner = this.ownedSessions.get(sessionId);
    if (owner) {
      this.handleTurnMux(owner, frame);
      return;
    }
    if (!this.workspaceSessionIds.has(sessionId)) return;
    if (type === 'session/event' && isObject(frame.event)) {
      const event = frame.event;
      const seq = asNumber(event.seq);
      // An unowned top-level frame belongs to a plain DSH session with no
      // product turns of its own (a legacy conversation, selected or not).
      // Its ordinary history is retained regardless of the current
      // selection, so a background conversation's activity is never lost by
      // switching away from it.
      const history = this.sessionHistory.get(sessionId) ?? { events: [], hasMore: false };
      const latest = history.events.at(-1)?.event;
      const latestSeq = latest ? asNumber(latest.seq) : undefined;
      if (seq === undefined || latestSeq === undefined || seq > latestSeq) {
        history.events.push({ event, ...(frame.view !== undefined ? { view: frame.view } : {}) });
        if (history.events.length > 8_000) history.events.splice(0, history.events.length - 8_000);
        this.sessionHistory.set(sessionId, history);
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

  private handleTurnMux(turnId: string, frame: Record<string, unknown>): void {
    const turn = this.turnsById.get(turnId);
    if (!turn || turn.status !== 'running') return;
    if (asString(frame.type) !== 'session/event' || !isObject(frame.event)) return;
    const event = frame.event;
    const seq = asNumber(event.seq);
    if (!this.isOwnEvent(turn, { event })) return;
    // A branch that already reported its terminal `turn/end` is closed: a later
    // frame never reopens it, re-finalizes it, or disturbs its frozen stats.
    if (turn.dshEnded) return;
    if (seq === undefined || turn.lastSeq === undefined || seq > turn.lastSeq) {
      turn.entries.push({ event, ...(frame.view !== undefined ? { view: frame.view } : {}) });
      if (seq !== undefined) turn.lastSeq = seq;
      if (turn.entries.length > 8_000) turn.entries.splice(0, turn.entries.length - 8_000);
    }
    this.updateTurnTelemetry(turn);
    this.notify();
  }

  private handleHost(frame: Record<string, unknown>): void {
    const type = asString(frame.type);
    const sessionId = asString(frame.sessionId);
    if (type === 'host/remote-event'
      && (frame.event === 'llm/adapters-updated' || frame.event === 'settings/document-updated')) {
      if (this.conversationRootId) void this.refreshModels(this.conversationRootId);
      return;
    }
    if (type === 'host/session-status' && sessionId) {
      const owner = this.ownedSessions.get(sessionId);
      if (owner) {
        const summary = this.sessions.get(sessionId);
        if (summary) summary.running = frame.running === true;
        this.notify();
        return;
      }
      if (!this.workspaceSessionIds.has(sessionId)) return;
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

  // ---------------------------------------------------------------------------
  // Independent user turns
  // ---------------------------------------------------------------------------

  /**
   * Start a new product conversation. Nothing is sent to DSH and nothing is
   * discarded: only the selection moves to a fresh local draft, identified by
   * a synthetic id until its first send establishes a DSH root. Every other
   * conversation keeps its turns, its retained events, and its running
   * background work, so New can never destroy work.
   */
  private beginConversation(): string {
    const conversationId = `local-${++this.localConversationSequence}`;
    this.activeConversationId = conversationId;
    this.persistConversation();
    return conversationId;
  }

  /** Select an existing DSH session as the conversation shown in the UI. */
  private adoptConversation(sessionId: string): void {
    this.activeConversationId = sessionId;
    this.conversationRoots.set(sessionId, sessionId);
  }

  /**
   * Bind one conversation to the DSH root session that anchors it. The turns
   * created before the root existed were captured against the conversation's
   * synthetic id, so they are rekeyed here — and only they are, so a turn
   * always stays owned by the conversation it was sent from even when the user
   * selected a different one while the root was being created.
   */
  private adoptConversationRoot(conversationId: string, rootSessionId: string): void {
    this.conversationRoots.set(conversationId, rootSessionId);
    if (rootSessionId === conversationId) return;
    this.conversationRoots.delete(conversationId);
    this.conversationRoots.set(rootSessionId, rootSessionId);
    if (this.blankRootClaims.delete(conversationId)) this.blankRootClaims.add(rootSessionId);
    for (const turn of this.turns) {
      if (turn.conversationId === conversationId) turn.conversationId = rootSessionId;
    }
    if (this.activeConversationId === conversationId) this.activeConversationId = rootSessionId;
  }

  /**
   * Adopt the ordinary session one conversation will display. The fork chain
   * always descends from it, so the sidebar entry survives every send. The
   * conversation is passed in rather than read from the selection: several
   * turns of the same conversation may race here, and the user may switch
   * conversations while the root is still being created.
   */
  private async ensureConversationRoot(conversationId: string): Promise<string> {
    const existing = this.conversationRoots.get(conversationId);
    if (existing) return existing;
    // Every turn of one conversation shares a single establishment, so two
    // simultaneous first sends can never create two roots for one conversation.
    const pending = this.rootCreations.get(conversationId);
    if (pending) return pending;
    const creation = this.createConversationRoot();
    this.rootCreations.set(conversationId, creation);
    try {
      const rootSessionId = await creation;
      this.adoptConversationRoot(conversationId, rootSessionId);
      return rootSessionId;
    } finally {
      this.rootCreations.delete(conversationId);
    }
  }

  /** Reuse a blank unowned session, or create one, as a conversation root. */
  private async createConversationRoot(): Promise<string> {
    const roots = new Set(this.conversationRoots.values());
    const blank = [...this.sessions.values()].find((session) => session.blank
      && this.workspaceSessionIds.has(session.sessionId)
      // A session that already anchors another conversation, or that a turn is
      // executing on, is never adopted as a second conversation's root.
      && !roots.has(session.sessionId)
      && !this.ownedSessions.has(session.sessionId)
      && !this.forkSessions.has(session.sessionId));
    if (blank) return blank.sessionId;
    const created = await this.rpc('session.create', { workspaceId: this.workspaceId });
    if (!isObject(created) || typeof created.sessionId !== 'string') throw new Error('DSH 未返回新会话 id');
    // A host refresh started during creation may still contain the old index.
    if (this.refreshPromise) await this.refreshPromise.catch(() => undefined);
    const summary: RawSessionSummary = {
      sessionId: created.sessionId,
      updatedAt: Date.now(),
      running: false,
      blank: true,
      cwd: this.workspace.path,
      ...(typeof created.agentPreset === 'string' ? { agentPreset: created.agentPreset } : {}),
    };
    this.sessions.set(summary.sessionId, summary);
    this.workspaceSessionIds.add(summary.sessionId);
    return summary.sessionId;
  }

  /**
   * Create the optimistic user + running turn snapshot synchronously. The id,
   * order, and owning conversation are all assigned here, so the transcript
   * never depends on the order in which turns later complete and a turn is
   * never re-attributed to whichever conversation the user selected later.
   */
  private createTurn(conversationId: string, prompt: string, clientTimeZone?: string): LocalTurn {
    const seq = ++this.turnSequence;
    const turn: LocalTurn = {
      id: `turn-${seq}`,
      seq,
      conversationId,
      userItemId: `turn-${seq}-user`,
      prompt,
      ...(clientTimeZone ? { clientTimeZone } : {}),
      status: 'running',
      startedAt: Date.now(),
      // The execution cut is decided here, before any await, so a turn never
      // adopts a base another parallel turn established while it waited.
      forkPlan: this.captureForkPlan(conversationId),
      pendingModel: this.models.current?.advertised && this.models.current.configured
        ? {
          provider: this.models.current.provider,
          model: this.models.current.model,
          ...(this.models.current.reasoningEffort ? { reasoningEffort: this.models.current.reasoningEffort } : {}),
        }
        : undefined,
      // Summary context is captured at send, from this conversation only: the
      // turns of another conversation are never context for this one.
      previousSummaries: this.turnsOf(conversationId)
        .filter((candidate) => candidate.status === 'completed' && candidate.summary !== undefined)
        .map((candidate) => ({ user: candidate.prompt, summary: candidate.summary as string })),
      entries: [],
    };
    this.turns.push(turn);
    this.turnsById.set(turn.id, turn);
    return turn;
  }

  /**
   * The immutable execution cut for a new turn, chosen synchronously at send
   * time from what has *already* completed: this conversation's own latest
   * completed product turn, else the completed cut of its legacy root session.
   *
   * With no completed cut there is nothing to fork — DSH rejects a fork of an
   * unfinished branch — so each concurrent turn needs its own blank execution.
   * Only the first such turn may use the conversation's established blank root;
   * the claim is recorded here, before any await, so two simultaneous first
   * sends can never both decide they own it.
   */
  private captureForkPlan(conversationId: string): ForkPlan {
    const completed = this.turnsOf(conversationId)
      .filter((candidate) => candidate.status === 'completed' && candidate.baseSessionId)
      .at(-1);
    if (completed?.baseSessionId) {
      return {
        kind: 'fork',
        sessionId: completed.baseSessionId,
        ...(completed.baseAtSeq !== undefined ? { atSeq: completed.baseAtSeq } : {}),
      };
    }
    const root = this.conversationRoots.get(conversationId);
    const legacyAtSeq = root === undefined ? undefined : this.legacyCut(root);
    if (root !== undefined && legacyAtSeq !== undefined) {
      return { kind: 'fork', sessionId: root, atSeq: legacyAtSeq };
    }
    if (this.blankRootClaims.has(conversationId)) return { kind: 'blank' };
    this.blankRootClaims.add(conversationId);
    return { kind: 'root' };
  }

  /**
   * The inclusive cut of a legacy root session that already holds a completed
   * DSH turn of its own. Its retained history is the conversation the user sees
   * there, so a managed turn continues it by forking that exact cut.
   */
  private legacyCut(sessionId: string): number | undefined {
    const history = this.sessionHistory.get(sessionId);
    if (!history?.events.some((entry) => asString(entry.event.type) === 'turn/end')) return undefined;
    return this.lastSeqOf(history.events);
  }

  /**
   * Bind one turn to its execution session. Ownership is what routes that
   * session's events into the turn and keeps them out of the linear
   * conversation history, and it is also what `cancel()` reads to reach the
   * right session. It is therefore published as soon as the id is known.
   */
  private claimTurnSession(turn: LocalTurn, sessionId: string): void {
    turn.sessionId = sessionId;
    this.ownedSessions.set(sessionId, turn.id);
  }

  /**
   * Run one turn's execution branch: fork it from the latest completed cut,
   * prompt it without steer/queue, and freeze its telemetry when it ends. Each
   * turn owns its session, so turns never share a queue or a steer channel.
   */
  private async executeTurn(turn: LocalTurn): Promise<void> {
    try {
      // The root is established for the turn's own conversation, never for
      // whichever conversation happens to be selected when it resolves. Every
      // conversation keeps a root even when this turn runs on its own branch,
      // so the sidebar entry survives each send.
      const root = await this.ensureConversationRoot(turn.conversationId);
      if (turn.status !== 'running') return;
      const plan = turn.forkPlan;
      const sessionId = plan.kind === 'fork'
        ? await this.forkExecution(turn, plan.sessionId, plan.atSeq)
        : plan.kind === 'root' && this.rootIsFreeFor(root, turn)
          ? root
          : await this.createExecution(turn);
      // Publish the execution session before any further await: `cancel()`
      // reaches the right session the moment the id is known, and only this
      // turn's events are ever routed into it.
      this.claimTurnSession(turn, sessionId);
      if (await this.abandonIfCancelled(turn, sessionId)) return;
      if (turn.forkParentSessionId !== undefined) {
        // Read the inherited ceiling exactly once, before the branch produces
        // anything of its own, so replayed history can never be mistaken for
        // this turn's work.
        const inherited = await this.readInheritedSeq(sessionId, turn.forkAtSeq);
        turn.inheritedMaxSeq = Math.max(turn.inheritedMaxSeq ?? 0, inherited ?? 0);
        turn.entries = turn.entries.filter((entry) => this.isOwnEvent(turn, entry));
        if (await this.abandonIfCancelled(turn, sessionId)) return;
      }
      this.persistConversation();
      await this.applyModel(sessionId, turn.pendingModel);
      if (await this.abandonIfCancelled(turn, sessionId)) return;
      // A cancel already applied before the prompt is dispatched has itself
      // stopped DSH (`cancel()` reaches the session as soon as the id is
      // known), so only a cancel that arrives while the prompt is in flight
      // leaves work to stop here — and only when that cancel could not stop it.
      const cancelsBeforePrompt = turn.cancelRequested ?? 0;
      await this.rpc('session.prompt', {
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: turn.prompt }],
        ...(turn.clientTimeZone ? { clientTimeZone: turn.clientTimeZone } : {}),
      });
      // A cancel that landed while the prompt was in flight must not be undone.
      if (turn.status !== 'running') {
        if ((turn.cancelRequested ?? 0) > cancelsBeforePrompt) {
          await this.rpc('session.cancel', { sessionId }).catch(() => undefined);
          turn.cancelReachedDsh = true;
        }
        return;
      }
      const summary = this.sessions.get(sessionId);
      if (summary) {
        summary.running = true;
        summary.blank = false;
        summary.updatedAt = Date.now();
      }
      await this.loadTurnHistory(turn, sessionId).catch(() => undefined);
      this.persistConversation();
      this.notify();
    } catch (error) {
      if (turn.status !== 'running') return;
      turn.error = error instanceof Error ? error.message : String(error);
      this.finishTurn(turn, 'failed');
    }
  }

  /**
   * Stop before prompting when the turn was cancelled during an awaited call.
   * The execution session already exists at that point, so a cancel that could
   * not reach it yet is issued here instead of leaving the branch behind.
   */
  private async abandonIfCancelled(turn: LocalTurn, sessionId: string): Promise<boolean> {
    if (turn.status === 'running') return false;
    if ((turn.cancelRequested ?? 0) > 0 && !turn.cancelReachedDsh) {
      await this.rpc('session.cancel', { sessionId }).catch(() => undefined);
      turn.cancelReachedDsh = true;
    }
    return true;
  }

  /**
   * Whether the conversation's own root may still run this turn directly. Only
   * an established blank root that no other turn claimed is usable; anything
   * else means a parallel turn got there first and this one needs its own
   * execution.
   */
  private rootIsFreeFor(root: string, turn: LocalTurn): boolean {
    const owner = this.ownedSessions.get(root);
    if (owner !== undefined && owner !== turn.id) return false;
    return this.sessions.get(root)?.blank === true;
  }

  /**
   * Record one generated execution session. It is internal branch state rather
   * than a conversation, so it never appears in the sidebar.
   */
  private registerExecutionSession(turn: LocalTurn, sessionId: string): void {
    this.ownedSessions.set(sessionId, turn.id);
    this.forkSessions.add(sessionId);
    this.sessions.set(sessionId, {
      sessionId,
      updatedAt: Date.now(),
      running: false,
      // An internal execution branch is never a sidebar conversation.
      blank: false,
      cwd: this.workspace.path,
    });
    this.workspaceSessionIds.add(sessionId);
  }

  /** Fork this turn's branch from the exact completed cut captured at send time. */
  private async forkExecution(turn: LocalTurn, parentSessionId: string, atSeq?: number): Promise<string> {
    if (atSeq === undefined) throw new Error('已完成会话缺少分支边界');
    const forked = await this.rpc('session.fork', {
      sessionId: parentSessionId,
      ...(atSeq !== undefined ? { atSeq } : {}),
    });
    if (!isObject(forked) || typeof forked.sessionId !== 'string') throw new Error('DSH 未返回分支会话 id');
    turn.forkParentSessionId = parentSessionId;
    turn.forkAtSeq = atSeq;
    // Fence replayed completed work before publishing session ownership.
    turn.inheritedMaxSeq = atSeq;
    this.registerExecutionSession(turn, forked.sessionId);
    return forked.sessionId;
  }

  /**
   * Create an independent blank execution for a turn with no completed cut to
   * fork. It is execution state exactly like a fork and is hidden the same way.
   */
  private async createExecution(turn: LocalTurn): Promise<string> {
    const created = await this.rpc('session.create', { workspaceId: this.workspaceId });
    if (!isObject(created) || typeof created.sessionId !== 'string') throw new Error('DSH 未返回新会话 id');
    this.registerExecutionSession(turn, created.sessionId);
    return created.sessionId;
  }

  /**
   * The highest event seq a freshly forked branch inherited, read exactly once
   * before it is prompted. The page includes the trailing standalone events a
   * fork replays above its own cut, so the ceiling covers them too. A failed
   * read stops setup because the inherited boundary could not be verified.
   */
  private async readInheritedSeq(sessionId: string, atSeq?: number): Promise<number | undefined> {
    const value = await this.rpc('session.history', { sessionId, maxMessages: 80 });
    if (!isObject(value) || !Array.isArray(value.events)) throw new Error('DSH 会话历史格式无效');
    const entries = value.events.filter((entry): entry is HistoryEntry => isObject(entry) && isObject(entry.event));
    return this.lastSeqOf(entries) ?? atSeq;
  }

  /**
   * Apply the model captured at send time to this turn's execution session. A
   * directory or apply failure is never swallowed: continuing would silently
   * run the turn on a different model than the one the user chose.
   */
  private async applyModel(
    sessionId: string,
    pending: LocalTurn['pendingModel'],
  ): Promise<void> {
    if (!pending) return;
    const models: ConversationModelsSnapshot = await this.fetchModels(sessionId);
    const option = models.groups
      .find((group) => group.provider === pending.provider)
      ?.models.find((candidate) => candidate.model === pending.model);
    if (!option) throw new Error(`新会话无法使用原选择模型 ${pending.provider}/${pending.model}`);
    if (models.current?.provider === pending.provider
      && models.current.model === pending.model
      && models.current.reasoningEffort === pending.reasoningEffort) return;
    const value = await this.rpc('session.selectModel', {
      sessionId,
      provider: pending.provider,
      model: pending.model,
      ...(pending.reasoningEffort ? { reasoningEffort: pending.reasoningEffort } : {}),
    });
    if (!isObject(value) || !isObject(value.selected)) throw new Error('DSH 未返回已选择模型');
  }

  /**
   * Close one turn exactly once. Terminal telemetry is frozen here and never
   * recomputed, and a cancelled turn leaves the running branch for good.
   */
  private finishTurn(turn: LocalTurn, status: 'completed' | 'cancelled' | 'failed'): void {
    if (turn.status !== 'running') return;
    turn.status = status;
    turn.endedAt = turn.endedAt ?? Date.now();
    // A turn cancelled or failed before its branch ended never froze its own
    // counts, so they are taken from what the branch did observe — once.
    if (turn.dispatchCount === undefined) {
      turn.dispatchCount = turn.entries.length === 0 ? 0 : projectConversation(turn.entries, Number.POSITIVE_INFINITY)
        .turns.reduce((sum, candidate) => sum + candidate.dispatchCount, 0);
    }
    if (turn.processItems === undefined) turn.processItems = this.freezeProcessItems(turn);
    // A failed turn's concise error is its answer; the raw work stays process.
    if (status === 'failed' && turn.error) turn.finalItemId = `${turn.id}-error`;
    if (status === 'completed') {
      turn.baseSessionId = turn.sessionId;
      turn.baseAtSeq = this.lastSeqOf(turn.entries);
    }
    // The shared conversation session stays displayed as the product
    // conversation; only a generated branch is released from ownership by
    // simply remaining hidden in the sidebar.
    const summary = turn.sessionId ? this.sessions.get(turn.sessionId) : undefined;
    if (summary) summary.running = false;
    this.persistConversation();
    // The linear display order is send order, so completion order is dropped
    // here rather than leaking into the transcript.
    this.notify();
  }

  /**
   * Produce the distinct final assistant message of a turn whose own branch
   * ended cleanly, and settle the turn.
   *
   * With no summarizer the legacy behavior is preserved: the branch's own final
   * DSH body is the answer, and it is already part of the turn's process. With
   * a summarizer, all DSH text stays `work` and exactly one callback call
   * yields the final message; a failure yields a visible concise error while
   * the raw work remains the turn's process rather than becoming the answer.
   *
   * The turn's `endedAt` is frozen exactly once here — including the
   * summarization time when a summarizer is configured — and never recomputed.
   */
  private async summarizeTurn(turn: LocalTurn): Promise<void> {
    if (!this.summarize) {
      const body = [...(turn.processItems ?? [])]
        .reverse()
        .find((item) => item.kind === 'assistant' && item.text);
      turn.endedAt = turn.dshEndedAt ?? Date.now();
      this.finishTurn(turn, 'completed');
      turn.finalItemId = body?.id;
      this.persistConversation();
      this.flushNotify();
      return;
    }
    const generation = (turn.summaryGeneration ?? 0) + 1;
    turn.summaryGeneration = generation;
    const controller = new AbortController();
    turn.summaryController = controller;
    let summary: string | undefined;
    let failure: string | undefined;
    try {
      const result = await this.summarize({
        previousSummaries: turn.previousSummaries,
        user: turn.prompt,
        work: turn.work ?? '',
        signal: controller.signal,
      });
      summary = result.trim();
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    // A late result is discarded by generation, controller identity, and turn
    // status alike, so a cancelled or re-summarized turn is never reopened.
    if (turn.summaryGeneration !== generation) return;
    if (turn.summaryController !== controller || controller.signal.aborted) return;
    if (turn.status !== 'running') return;
    turn.summaryController = undefined;
    turn.endedAt = Date.now();
    if (failure !== undefined || !summary) {
      turn.error = failure ? `总结失败：${failure}` : '总结失败：未返回内容';
      this.finishTurn(turn, 'failed');
      this.flushNotify();
      return;
    }
    turn.summary = summary;
    this.finishTurn(turn, 'completed');
    this.appendMessage(turn, summary);
  }

  /** Record the turn's distinct final assistant message and publish it. */
  private appendMessage(turn: LocalTurn, text: string): void {
    const item: ConversationItemSnapshot = {
      id: `${turn.id}-final`,
      kind: 'assistant',
      text,
      time: turn.endedAt ?? Date.now(),
      turnId: turn.id,
    };
    turn.finalItemId = item.id;
    turn.summaryItem = item;
    this.persistConversation();
    this.flushNotify();
  }

  /**
   * The distinct final assistant item of a turn, appended after its process. A
   * running turn has none; a cancelled or failed turn exposes only its concise
   * error. In legacy mode (no summarizer) the answer is the branch's own final
   * DSH body, which is already part of the process and is pointed at by the
   * turn's `finalItemId` rather than duplicated here.
   */
  private finalItemFor(turn: LocalTurn): ConversationItemSnapshot | undefined {
    if (turn.summaryItem) return turn.summaryItem;
    if (turn.error) {
      return {
        id: `${turn.id}-error`,
        kind: 'assistant',
        text: turn.error,
        time: turn.endedAt ?? turn.startedAt,
        turnId: turn.id,
      };
    }
    return undefined;
  }

  private dispatchCountFor(turn: LocalTurn): number {
    if (turn.status === 'running') return 0;
    // Frozen when the turn settled and never recomputed, so a restored turn and
    // a live one report the same count.
    return turn.dispatchCount ?? 0;
  }

  /**
   * The complete work context of one branch: every assistant prose item plus
   * every tool call and its result, in the order the branch produced them. A
   * summary written from prose alone would miss what the tools actually did.
   */
  private workTextOf(items: readonly ConversationItemSnapshot[]): string | undefined {
    const parts: string[] = [];
    for (const item of items) {
      if (item.kind === 'assistant') {
        if (item.text.trim()) parts.push(item.text);
        continue;
      }
      if (item.kind !== 'tool') continue;
      const lines = [`[${item.toolSummary ?? item.toolName ?? '工具调用'}]`];
      if (item.text.trim()) lines.push(item.text);
      if (item.toolResultText?.trim()) lines.push(item.toolResultText);
      parts.push(lines.join('\n'));
    }
    const text = parts.join('\n\n').trim();
    return text || undefined;
  }

  /** Turn telemetry of the selected conversation only, in send order. */
  private turnSnapshots(): ConversationTurnSnapshot[] {
    return this.turnsOf(this.activeConversationId)
      .map((turn): ConversationTurnSnapshot => ({
        id: turn.id,
        startedAt: turn.startedAt,
        ...(turn.endedAt !== undefined ? { endedAt: turn.endedAt } : {}),
        running: turn.status === 'running',
        ...(turn.finalItemId ? { finalItemId: turn.finalItemId } : {}),
        dispatchCount: this.dispatchCountFor(turn),
        ...(turn.inputTokens !== undefined ? { inputTokens: turn.inputTokens } : {}),
        ...(turn.outputTokens !== undefined ? { outputTokens: turn.outputTokens } : {}),
        ...(turn.outputTps !== undefined ? { outputTps: turn.outputTps } : {}),
      }));
  }

  /**
   * Persist every conversation this client holds, not just the selected one:
   * the document is the workspace's conversation history, so a background or
   * merely unselected conversation must survive a restart exactly like the
   * visible one. A write failure leaves the live conversation running and is
   * surfaced as a snapshot warning instead of being silently dropped.
   */
  private persistConversation(): void {
    if (!this.state) return;
    const records = new Map<string, ConversationStateRecord>();
    const recordFor = (conversationId: string): ConversationStateRecord => {
      const existing = records.get(conversationId);
      if (existing) return existing;
      const rootSessionId = this.conversationRoots.get(conversationId);
      const record: ConversationStateRecord = {
        id: conversationId,
        ...(rootSessionId ? { rootSessionId } : {}),
        messages: [],
        turns: [],
        summaries: [],
      };
      records.set(conversationId, record);
      return record;
    };
    // The selected conversation is recorded even before it owns a turn, so the
    // selection itself is restorable.
    if (this.activeConversationId !== undefined) recordFor(this.activeConversationId);
    for (const turn of [...this.turns].sort((left, right) => left.seq - right.seq)) {
      const record = recordFor(turn.conversationId);
      record.messages.push({
        id: turn.userItemId,
        kind: 'user',
        text: turn.prompt,
        time: turn.startedAt,
      });
      // The complete process is recorded on the turn itself, next to the
      // distinct final summary; one never replaces the other.
      if (turn.summaryItem) {
        record.messages.push({
          id: turn.summaryItem.id,
          kind: 'assistant',
          text: turn.summaryItem.text,
          time: turn.summaryItem.time,
        });
      }
      record.turns.push({
        id: turn.id,
        seq: turn.seq,
        userItemId: turn.userItemId,
        executionSessionId: turn.sessionId ?? '',
        ...(turn.forkParentSessionId ? { forkParentSessionId: turn.forkParentSessionId } : {}),
        ...(turn.forkAtSeq !== undefined ? { forkAtSeq: turn.forkAtSeq } : {}),
        ...(turn.baseSessionId ? { baseSessionId: turn.baseSessionId } : {}),
        ...(turn.baseAtSeq !== undefined ? { baseAtSeq: turn.baseAtSeq } : {}),
        ...(turn.finalItemId ? { finalItemId: turn.finalItemId } : {}),
        ...(turn.inheritedMaxSeq !== undefined ? { inheritedMaxSeq: turn.inheritedMaxSeq } : {}),
        ...(turn.dshEndedAt !== undefined ? { dshEndedAt: turn.dshEndedAt } : {}),
        ...(turn.processItems && turn.processItems.length > 0 ? { process: turn.processItems } : {}),
        ...(turn.work ? { work: turn.work } : {}),
        ...(turn.summary ? { summary: turn.summary } : {}),
        ...(turn.pendingModel ? { model: turn.pendingModel } : {}),
        dispatchCount: this.dispatchCountFor(turn),
        status: turn.status,
        startedAt: turn.startedAt,
        ...(turn.endedAt !== undefined ? { endedAt: turn.endedAt } : {}),
        ...(turn.inputTokens !== undefined ? { inputTokens: turn.inputTokens } : {}),
        ...(turn.outputTokens !== undefined ? { outputTokens: turn.outputTokens } : {}),
        ...(turn.outputTps !== undefined ? { outputTps: turn.outputTps } : {}),
        ...(turn.error ? { error: turn.error } : {}),
      });
      if (turn.summary !== undefined) record.summaries.push({ user: turn.prompt, summary: turn.summary });
    }
    const document: ConversationStateDocument = {
      version: CONVERSATION_STATE_VERSION,
      workspaceScope: this.workspaceId,
      records: [...records.values()],
      ...(this.activeConversationId !== undefined ? { selectedRecordId: this.activeConversationId } : {}),
      nextSeq: this.turnSequence,
    };
    try {
      this.state.save(document);
      this.persistWarning = undefined;
    } catch (error) {
      this.persistWarning = `会话记录保存失败：${error instanceof Error ? error.message : String(error)}`;
    }
  }

  /**
   * Restore every persisted conversation, the selected identity, and each
   * conversation's root mapping. A turn persisted as running can never be
   * resumed, so it restores as a settled failed turn with a terminal error and
   * an end time instead of a phantom live turn.
   */
  private restoreConversation(): void {
    if (!this.state) return;
    const document = this.state.load();
    this.turnSequence = document.nextSeq;
    for (const record of document.records) {
      const rootSessionId = record.rootSessionId ?? (record.id.startsWith('local-') ? undefined : record.id);
      if (rootSessionId) this.conversationRoots.set(record.id, rootSessionId);
      const local = /^local-(\d+)$/.exec(record.id);
      if (local) {
        this.localConversationSequence = Math.max(this.localConversationSequence, Number(local[1]));
      }
      const summaries: Array<{ user: string; summary: string }> = [];
      for (const persisted of [...record.turns].sort((left, right) => left.seq - right.seq)) {
        const turn = this.restoreTurn(record, persisted, [...summaries]);
        this.turns.push(turn);
        this.turnsById.set(turn.id, turn);
        // A branch a turn ran on that is not the conversation's own root is an
        // internal execution session; restoring it as hidden keeps the sidebar
        // showing conversations rather than the branches behind them.
        if (turn.sessionId !== undefined && turn.sessionId !== rootSessionId) this.forkSessions.add(turn.sessionId);
        this.turnSequence = Math.max(this.turnSequence, turn.seq);
        if (turn.summary !== undefined) summaries.push({ user: turn.prompt, summary: turn.summary });
      }
    }
    if (document.selectedRecordId !== undefined) this.activeConversationId = document.selectedRecordId;
  }

  /** Rebuild one persisted turn, including its work, summary, and anchors. */
  private restoreTurn(
    record: ConversationStateRecord,
    persisted: ConversationStateTurn,
    previousSummaries: Array<{ user: string; summary: string }>,
  ): LocalTurn {
    const messageById = (id: string | undefined): ConversationStateMessage | undefined => (
      id === undefined ? undefined : record.messages.find((candidate) => candidate.id === id)
    );
    // A legacy-mode `finalItemId` points at one of the turn's own process
    // items, which are restored whole; only a distinct summary is a message.
    const summaryMessage = messageById(persisted.finalItemId);
    const interrupted = persisted.status === 'running';
    const endedAt = persisted.endedAt ?? (interrupted ? persisted.startedAt : undefined);
    const error = persisted.error ?? (interrupted ? '已中断：上次运行未完成' : undefined);
    return {
      id: persisted.id,
      seq: persisted.seq,
      conversationId: record.id,
      userItemId: persisted.userItemId,
      prompt: messageById(persisted.userItemId)?.text ?? '',
      status: interrupted ? 'failed' : persisted.status,
      startedAt: persisted.startedAt,
      ...(endedAt !== undefined ? { endedAt } : {}),
      sessionId: persisted.executionSessionId || undefined,
      ...(persisted.forkParentSessionId ? { forkParentSessionId: persisted.forkParentSessionId } : {}),
      ...(persisted.forkAtSeq !== undefined ? { forkAtSeq: persisted.forkAtSeq } : {}),
      ...(persisted.baseSessionId ? { baseSessionId: persisted.baseSessionId } : {}),
      ...(persisted.baseAtSeq !== undefined ? { baseAtSeq: persisted.baseAtSeq } : {}),
      ...(persisted.finalItemId ? { finalItemId: persisted.finalItemId } : {}),
      ...(summaryMessage ? { summaryItem: this.messageItem(summaryMessage, persisted.id) } : {}),
      ...(persisted.process && persisted.process.length > 0 ? { processItems: persisted.process } : {}),
      ...(persisted.inheritedMaxSeq !== undefined ? { inheritedMaxSeq: persisted.inheritedMaxSeq } : {}),
      ...(persisted.dshEndedAt !== undefined ? { dshEndedAt: persisted.dshEndedAt, dshEnded: true } : {}),
      // A restored turn is settled and never executes again, so it carries no
      // live cut; a new send captures its own.
      forkPlan: { kind: 'blank' },
      ...(persisted.work ? { work: persisted.work } : {}),
      ...(persisted.model ? { pendingModel: persisted.model } : {}),
      ...(persisted.dispatchCount !== undefined ? { dispatchCount: persisted.dispatchCount } : {}),
      ...(persisted.inputTokens !== undefined ? { inputTokens: persisted.inputTokens } : {}),
      ...(persisted.outputTokens !== undefined ? { outputTokens: persisted.outputTokens } : {}),
      ...(persisted.outputTps !== undefined ? { outputTps: persisted.outputTps } : {}),
      ...(persisted.summary ? { summary: persisted.summary } : {}),
      ...(error ? { error } : {}),
      previousSummaries,
      entries: [],
    };
  }

  private messageItem(message: ConversationStateMessage, turnId: string): ConversationItemSnapshot {
    return { id: message.id, kind: message.kind, text: message.text, time: message.time, turnId };
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
