// ── Task result parsing ──────────────────────────────────────────────
// Pure helpers that turn a structured task result into readable pieces for
// the transcript panel: the parsed JSON value, the decoded top-level answer
// of a truncated preview, and the user-facing labels that go with them.
// No React, no dependencies, no I/O.

export interface ParsedTaskResult {
  status?: string;
  value?: unknown;
  answer?: string;
  /** Bounded, nonempty leading text kept separately from the parsed result. */
  summary?: string;
  truncated: boolean;
}

const TRUNCATION_MARKER = '\u2026';
const STATUS_LENGTH_LIMIT = 40;
const SUMMARY_LENGTH_LIMIT = 400;

const FOREMAN_OUTPUT_OPEN = /<foreman-task-output>/i;
const FOREMAN_OUTPUT_CLOSE = /<\/foreman-task-output>/i;
const FOREMAN_SUMMARY_OPEN = /<summary>/i;
const FOREMAN_SUMMARY_CLOSE = /<\/summary>/i;
const FOREMAN_RESULT_OPEN = /<result>/i;
const FOREMAN_RESULT_CLOSE = /<\/result>/i;
const MARKDOWN_FENCE = /^```[ \t]*(?:json)?[ \t]*\r?\n?([\s\S]*?)\r?\n?```[ \t]*$/i;

// Top-level keys the built-in task definitions put on a structured result.
// Only used to recognise a JSON suffix that follows prose; a direct or fenced
// JSON body keeps its previous, permissive handling.
const RESULT_KEYS = new Set([
  'status',
  'answer',
  'summary',
  'locations',
  'evidences',
  'assessments',
  'artifacts',
  'findings',
  'required_changes',
  'conclusion',
  'observations',
  'error',
]);

const SIMPLE_ESCAPES = new Set(['"', '\\', '/', 'b', 'f', 'n', 'r', 't']);
const UNICODE_ESCAPE = /^[0-9a-fA-F]{4}$/;

/** Chinese labels for the keys a built-in task result is known to use. */
export const FIELD_LABELS: Record<string, string> = {
  answer: '回答',
  status: '状态',
  locations: '位置',
  path: '路径',
  line: '行',
  line_range: '行范围',
  id: '编号',
  source: '来源',
  kind: '类型',
  value: '值',
  observation: '观察',
  evidences: '证据',
  assessments: '评估',
  criterion_id: '判定项',
  reason: '理由',
  artifacts: '产物',
  description: '描述',
  role: '角色',
  findings: '发现',
  conclusion: '结论',
  target: '目标',
  targets: '目标',
  confidence: '置信度',
  required_changes: '需要修改',
  action: '动作',
  instruction: '说明',
  expected: '预期',
};

/** Unknown keys keep their original text instead of being dropped. */
export function labelForField(key: string): string {
  return Object.hasOwn(FIELD_LABELS, key) ? FIELD_LABELS[key] : key;
}

const STATUS_LABELS: Record<string, string> = {
  answered: '已回答',
  not_found: '未找到',
  failed: '失败',
  running: '运行中',
  passed: '通过',
  blocked: '受阻',
  not_supported: '暂不支持',
  error: '错误',
  ok: '完成',
  success: '成功',
  cancelled: '已取消',
  pending: '进行中',
  done: '已完成',
};

/** Unmapped statuses are returned unchanged rather than dropped. */
export function statusLabel(status: string): string {
  return Object.hasOwn(STATUS_LABELS, status) ? STATUS_LABELS[status] : status;
}

/** Visual tone a status or value pill is drawn with. */
export type StatusTone = 'success' | 'destructive' | 'warning' | 'muted';

const STATUS_TONES: Record<string, StatusTone> = {
  answered: 'success',
  passed: 'success',
  ok: 'success',
  success: 'success',
  done: 'success',
  failed: 'destructive',
  error: 'destructive',
  blocked: 'warning',
  not_found: 'warning',
  running: 'warning',
  pending: 'warning',
};

const VALUE_LABELS: Record<string, Record<string, string>> = {
  confidence: { high: '高', medium: '中', low: '低' },
  action: { create: '新建', update: '修改', remove: '删除' },
  kind: { file: '文件', command: '命令', image: '图片', url: '链接' },
};

/** User-facing text for an enumerated field value; unknown values stay unchanged. */
export function valueLabel(field: string, value: string): string {
  if (field === 'status') return statusLabel(value);
  const table = Object.hasOwn(VALUE_LABELS, field) ? VALUE_LABELS[field] : undefined;
  return table !== undefined && Object.hasOwn(table, value) ? table[value] : value;
}

/** Colour tone for an enumerated field value. */
export function valueTone(field: string, value: string): StatusTone {
  if (field === 'status') return Object.hasOwn(STATUS_TONES, value) ? STATUS_TONES[value] : 'muted';
  if (field === 'confidence') return value === 'high' ? 'success' : value === 'medium' ? 'warning' : 'muted';
  return 'muted';
}

function isJsonWhitespace(char: string | undefined): boolean {
  return char === ' ' || char === '\t' || char === '\n' || char === '\r';
}

function normalizeStatus(status: string): string {
  return status.trim().slice(0, STATUS_LENGTH_LIMIT);
}

function isStructured(value: unknown): boolean {
  return typeof value === 'object' && value !== null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Strip a whole-text code fence so fenced JSON parses directly. */
function unwrapFence(text: string): string {
  const fenced = MARKDOWN_FENCE.exec(text);
  return fenced ? fenced[1].trim() : text;
}

/** Trim, collapse and bound a preserved summary so it can never be unbounded. */
function boundSummary(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, SUMMARY_LENGTH_LIMIT);
}

interface ScannedString {
  end: number;
  raw: string;
  /** True only when a real closing quote terminated the literal. */
  closed: boolean;
}

/**
 * Read the JSON string literal that starts at `start` (the opening quote) and
 * return its undecoded body. An unterminated string simply ends with the text
 * and reports `closed: false`.
 */
function scanString(source: string, start: number): ScannedString {
  let index = start + 1;
  let raw = '';

  while (index < source.length) {
    const char = source[index];
    if (char === '\\') {
      const next = source[index + 1];
      if (next === undefined) return { end: source.length, raw: `${raw}\\`, closed: false };
      raw += char + next;
      index += 2;
      continue;
    }
    if (char === '"') return { end: index + 1, raw, closed: true };
    raw += char;
    index += 1;
  }

  return { end: source.length, raw, closed: false };
}

/**
 * Decode the raw body of a possibly truncated JSON string by dropping only a
 * trailing incomplete escape and handing the rest to JSON.parse, so complete
 * escapes (including `\uXXXX`) become real characters. Anything malformed —
 * a `\u` escape with four non-hex characters or a complete escape that is not
 * one of the known simple escapes — makes the whole body undecodable and
 * returns `undefined`. The text is never evaluated and `\n` is never rewritten
 * by hand.
 */
function decodeRawStringBody(raw: string): string | undefined {
  let complete = '';
  let index = 0;

  while (index < raw.length) {
    const char = raw[index];
    if (char !== '\\') {
      complete += char;
      index += 1;
      continue;
    }
    const escape = raw[index + 1];
    if (escape === undefined) break;
    if (escape === 'u') {
      const hex = raw.slice(index + 2, index + 6);
      if (hex.length < 4) break;
      if (!UNICODE_ESCAPE.test(hex)) return undefined;
      complete += raw.slice(index, index + 6);
      index += 6;
      continue;
    }
    if (!SIMPLE_ESCAPES.has(escape)) return undefined;
    complete += raw.slice(index, index + 2);
    index += 2;
  }

  try {
    const decoded: unknown = JSON.parse(`"${complete}"`);
    return typeof decoded === 'string' ? decoded : undefined;
  } catch {
    return undefined;
  }
}

interface TruncatedFields {
  status?: string;
  answer?: string;
}

/**
 * Recover the top-level `status` and `answer` strings from a truncated JSON
 * object preview. The text is walked character by character while tracking
 * JSON string state and bracket depth; nothing is evaluated.
 */
function recoverTruncatedFields(text: string): TruncatedFields {
  const recovered: TruncatedFields = {};
  let depth = 0;
  let index = 0;

  while (index < text.length) {
    const char = text[index];
    if (char === '{' || char === '[') {
      depth += 1;
      index += 1;
      continue;
    }
    if (char === '}' || char === ']') {
      depth = depth > 0 ? depth - 1 : 0;
      index += 1;
      continue;
    }
    if (char !== '"') {
      index += 1;
      continue;
    }

    const scanned = scanString(text, index);
    index = scanned.end;
    if (depth !== 1) continue;

    let cursor = index;
    while (isJsonWhitespace(text[cursor])) cursor += 1;
    if (text[cursor] !== ':') continue;

    const key = scanned.raw;
    if (key !== 'status' && key !== 'answer') continue;
    if (recovered[key] !== undefined) continue;

    cursor += 1;
    while (isJsonWhitespace(text[cursor])) cursor += 1;
    if (text[cursor] !== '"') continue;

    const value = scanString(text, cursor);
    index = value.end;
    // A partial `status` is ignored rather than truncated; `answer` may be cut off.
    if (key === 'status' && !value.closed) continue;

    const decoded = decodeRawStringBody(value.raw);
    if (decoded !== undefined) recovered[key] = decoded;
  }

  return recovered;
}

function tryParseJson(candidate: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(candidate) };
  } catch {
    return { ok: false };
  }
}

/** An array of evidence objects, the shape an `edit`/`test` result can be. */
function isEvidenceArray(value: unknown[]): boolean {
  return value.length > 0 && value.every((item) => isRecord(item) && 'source' in item && 'observation' in item);
}

function hasExpectedShape(value: unknown): boolean {
  if (Array.isArray(value)) return isEvidenceArray(value);
  if (isRecord(value)) return Object.keys(value).some((key) => RESULT_KEYS.has(key));
  return false;
}

/**
 * True when a possibly truncated preview opens with a built-in result key.
 * Only the first key is guaranteed complete in a cut-off object, so a leading
 * `[` is accepted as a truncated evidence list.
 */
function startsWithResultKey(text: string): boolean {
  if (text.startsWith('[')) return true;
  const body = text.startsWith('{') ? text.slice(1).trimStart() : text.trimStart();
  for (const key of RESULT_KEYS) {
    if (body.startsWith(`"${key}"`)) return true;
  }
  return false;
}

/**
 * True when text is a built-in task result shape: either it parses and carries
 * an expected key (or is an evidence array), or the received preview ends with
 * the real truncation marker and opens with a result key.
 */
function looksLikeResult(candidate: string): boolean {
  const parsed = tryParseJson(candidate);
  if (parsed.ok) return hasExpectedShape(parsed.value);
  if (candidate.endsWith(TRUNCATION_MARKER)) return startsWithResultKey(candidate.slice(0, -1));
  return false;
}

interface Envelope {
  /** Text before the envelope opening tag, trimmed; '' when the tag opens the text. */
  prose: string;
  /** Complete `<summary>` body; '' when the tag is absent or was cut off. */
  summary: string;
  /** `<result>` body (or the text after the summary), trimmed. */
  candidate: string;
}

/**
 * Read a `<foreman-task-output>` envelope, tolerating a truncated tail: the
 * closing tags may be missing and the summary may be cut off. The envelope
 * must open at a line boundary so inline prose mentioning the tag is ignored.
 */
function readEnvelope(text: string): Envelope | null {
  const open = FOREMAN_OUTPUT_OPEN.exec(text);
  if (!open) return null;

  const before = text.slice(0, open.index);
  if (before.trim() !== '' && !before.endsWith('\n')) return null;

  let body = text.slice(open.index + open[0].length);
  const envelopeClose = FOREMAN_OUTPUT_CLOSE.exec(body);
  if (envelopeClose) body = body.slice(0, envelopeClose.index);

  let summary = '';
  let afterSummary = body;
  const summaryOpen = FOREMAN_SUMMARY_OPEN.exec(body);
  if (summaryOpen) {
    const rest = body.slice(summaryOpen.index + summaryOpen[0].length);
    const summaryClose = FOREMAN_SUMMARY_CLOSE.exec(rest);
    if (summaryClose) {
      summary = rest.slice(0, summaryClose.index).trim();
      afterSummary = rest.slice(summaryClose.index + summaryClose[0].length);
    } else {
      // The preview was cut inside the summary element; keep what arrived.
      summary = rest.trim();
      afterSummary = '';
    }
  }

  let candidate = afterSummary;
  const resultOpen = FOREMAN_RESULT_OPEN.exec(afterSummary);
  if (resultOpen) {
    candidate = afterSummary.slice(resultOpen.index + resultOpen[0].length);
    const resultClose = FOREMAN_RESULT_CLOSE.exec(candidate);
    if (resultClose) candidate = candidate.slice(0, resultClose.index);
  }

  return { prose: before.trim(), summary: boundSummary(summary), candidate: candidate.trim() };
}

interface ProseSuffix {
  prose: string;
  candidate: string;
}

/**
 * Split `prose + JSON` text at the first line that opens a JSON body. The
 * suffix must start at a line boundary, so a JSON example quoted inside a
 * sentence is never mistaken for a task result.
 */
function splitProseSuffix(text: string): ProseSuffix | null {
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const candidate = lines.slice(index).join('\n').trim();
    if (candidate === '' || (candidate[0] !== '{' && candidate[0] !== '[')) continue;
    return { prose: lines.slice(0, index).join('\n').trim(), candidate };
  }
  return null;
}

/**
 * Turn an isolated structured candidate plus its preserved summary into the
 * renderable result. `cut` records that the whole received preview ended with
 * the truncation marker. Returns `null` when there is nothing safe to show, so
 * malformed non-truncated text keeps its plain rendering.
 */
function finishParse(candidate: string, summary: string, envelope: boolean, cut: boolean): ParsedTaskResult | null {
  const label = summary === '' ? {} : { summary };
  const truncated = cut || candidate.endsWith(TRUNCATION_MARKER);

  if (candidate.startsWith('{') || candidate.startsWith('[')) {
    const parsed = tryParseJson(candidate);
    if (parsed.ok) {
      const value = parsed.value;
      if (!isStructured(value)) return null;
      const rawStatus = Array.isArray(value) ? undefined : (value as Record<string, unknown>).status;
      const status = typeof rawStatus === 'string' ? normalizeStatus(rawStatus) : '';
      return {
        ...(status !== '' ? { status } : {}),
        value,
        ...label,
        truncated: false,
      };
    }

    // A malformed payload that was not cut short stays plain text, unless the
    // envelope explicitly marked it as a task result.
    if (!truncated) {
      return envelope && summary !== '' ? { ...label, truncated: false } : null;
    }

    // The terminal truncation marker is not part of the JSON text.
    const body = candidate.endsWith(TRUNCATION_MARKER) ? candidate.slice(0, -1) : candidate;
    const recovered = recoverTruncatedFields(body);
    const status = recovered.status !== undefined ? normalizeStatus(recovered.status) : '';
    const answer = recovered.answer;

    return {
      ...(status !== '' ? { status } : {}),
      ...(answer !== undefined ? { answer } : {}),
      ...label,
      truncated: true,
    };
  }

  // The envelope carried no JSON body at all: keep only what is safe — the
  // preserved summary and, for a cut-off preview, the truncation notice.
  if (!envelope) return null;
  if (summary !== '') return { ...label, truncated };
  if (candidate !== '' && truncated) return { truncated: true };
  return null;
}

/**
 * Parse the structured result of a task. Returns `null` when the text is not a
 * structured result, so plain running commentary, plain text results and
 * malformed text keep their current rendering.
 */
export function parseTaskResult(summary: string): ParsedTaskResult | null {
  try {
    const text = summary.trim();
    if (text.length === 0) return null;

    const envelope = readEnvelope(text);
    if (envelope !== null) {
      const label = envelope.summary !== '' ? envelope.summary : boundSummary(envelope.prose);
      return finishParse(envelope.candidate, label, true, text.endsWith(TRUNCATION_MARKER));
    }

    const fenced = unwrapFence(text);
    if (fenced !== text) return finishParse(fenced, '', false, false);

    if (!text.startsWith('{') && !text.startsWith('[')) {
      const suffix = splitProseSuffix(text);
      if (suffix === null || !looksLikeResult(suffix.candidate)) return null;
      return finishParse(suffix.candidate, boundSummary(suffix.prose), false, text.endsWith(TRUNCATION_MARKER));
    }

    return finishParse(text, '', false, false);
  } catch {
    return null;
  }
}

// ── Compact file references ──────────────────────────────────────────

export interface FileReference {
  kind?: string;
  text: string;
}

/** Keys a source object may use to describe a file target. */
const REFERENCE_KEYS = new Set(['kind', 'value', 'path', 'line', 'line_range']);

function rangeSuffix(value: unknown): string | null {
  if (value === undefined) return '';
  if (typeof value === 'number' && Number.isFinite(value)) return `:${value}`;
  if (Array.isArray(value) && value.length === 2 && value.every((n) => typeof n === 'number' && Number.isFinite(n))) {
    return `:${value[0]}–${value[1]}`;
  }
  return null;
}

/**
 * A `{path|value, kind?, line?|line_range?}` target as one line, or null.
 * Collapsing is only allowed when nothing would be lost: the object may carry
 * no other keys, exactly one target key and it must be a string, `kind` must
 * be a string when present, and the line metadata must be valid and
 * nonconflicting. Anything else is left to the generic renderer.
 */
export function fileReference(value: unknown): FileReference | null {
  if (!isRecord(value)) return null;
  const keys = Object.keys(value);
  if (keys.length === 0 || !keys.every((key) => REFERENCE_KEYS.has(key))) return null;

  const hasPath = Object.hasOwn(value, 'path');
  const hasValue = Object.hasOwn(value, 'value');
  if (hasPath === hasValue) return null;
  const target = hasPath ? value.path : value.value;
  if (typeof target !== 'string') return null;

  if (value.kind !== undefined && typeof value.kind !== 'string') return null;
  if (value.line !== undefined && value.line_range !== undefined) return null;

  const suffix = rangeSuffix(value.line !== undefined ? value.line : value.line_range);
  if (suffix === null || target.includes('\n')) return null;

  return { ...(typeof value.kind === 'string' ? { kind: value.kind } : {}), text: `${target}${suffix}` };
}

/** `[a, b]` line range as `a–b`, or null. */
export function lineRangeText(value: unknown): string | null {
  const suffix = Array.isArray(value) ? rangeSuffix(value) : null;
  return suffix ? suffix.slice(1) : null;
}
