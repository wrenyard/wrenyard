// ── Task result parsing ──────────────────────────────────────────────
// Pure helpers that turn a structured task result into readable pieces for
// the transcript panel: the parsed JSON value, the decoded top-level answer
// of a truncated preview, and the user-facing labels that go with them.
// No React, no dependencies, no I/O.

export interface ParsedTaskResult {
  status?: string;
  value?: unknown;
  answer?: string;
  truncated: boolean;
}

const TRUNCATION_MARKER = '\u2026';
const STATUS_LENGTH_LIMIT = 40;

const FOREMAN_OUTPUT_OPEN = /^\s*<foreman-task-output>\s*/i;
const FOREMAN_OUTPUT_CLOSE = /\s*<\/foreman-task-output>\s*$/i;
const MARKDOWN_FENCE = /^```[ \t]*(?:json)?[ \t]*\r?\n?([\s\S]*?)\r?\n?```[ \t]*$/i;

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
};

/** Unmapped statuses are returned unchanged rather than dropped. */
export function statusLabel(status: string): string {
  return Object.hasOwn(STATUS_LABELS, status) ? STATUS_LABELS[status] : status;
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

/** Strip a whole-text `<foreman-task-output>` wrapper and a whole-text code fence. */
function unwrapText(text: string): string {
  let unwrapped = text;
  if (FOREMAN_OUTPUT_OPEN.test(unwrapped)) {
    unwrapped = unwrapped.replace(FOREMAN_OUTPUT_OPEN, '');
  }
  if (FOREMAN_OUTPUT_CLOSE.test(unwrapped)) {
    unwrapped = unwrapped.replace(FOREMAN_OUTPUT_CLOSE, '');
  }
  unwrapped = unwrapped.trim();

  const fenced = MARKDOWN_FENCE.exec(unwrapped);
  if (fenced) unwrapped = fenced[1].trim();

  return unwrapped;
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

/**
 * Parse the structured result of a task. Returns `null` when the text is not a
 * structured result, so plain running commentary, plain text results and
 * malformed text keep their current rendering.
 */
export function parseTaskResult(summary: string): ParsedTaskResult | null {
  try {
    const text = summary.trim();
    if (text.length === 0) return null;

    const candidate = unwrapText(text);
    if (!candidate.startsWith('{') && !candidate.startsWith('[')) return null;

    const parsed = tryParseJson(candidate);
    if (parsed.ok) {
      const value = parsed.value;
      if (!isStructured(value)) return null;

      const rawStatus = Array.isArray(value) ? undefined : (value as Record<string, unknown>).status;
      const status = typeof rawStatus === 'string' ? normalizeStatus(rawStatus) : '';
      return {
        ...(status !== '' ? { status } : {}),
        value,
        truncated: false,
      };
    }

    // A malformed payload that was not cut short stays plain text.
    if (!candidate.endsWith(TRUNCATION_MARKER)) return null;

    // The terminal truncation marker is not part of the JSON text.
    const recovered = recoverTruncatedFields(candidate.slice(0, -1));
    const status = recovered.status !== undefined ? normalizeStatus(recovered.status) : '';
    const answer = recovered.answer;

    return {
      ...(status !== '' ? { status } : {}),
      ...(answer !== undefined ? { answer } : {}),
      truncated: true,
    };
  } catch {
    return null;
  }
}
