/**
 * Task results as plain text.
 *
 * A task returns structured JSON. The main model reads its result as prose, so
 * the JSON is laid out as compact Markdown: the status and the summary/answer
 * first, then every other field as nested bullets. Nothing is dropped except
 * empty values; values are never rephrased. Text that is not JSON passes
 * through unchanged.
 */

const LEAD_KEYS = ['status', 'summary', 'answer', 'result', 'message'] as const;

/** Render a task's output string for the model. */
export function renderTaskResult(output: string): string {
  const trimmed = output.trim();
  if (trimmed === '' || (trimmed[0] !== '{' && trimmed[0] !== '[')) return output;
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return output;
  }
  const lines: string[] = [];
  if (isRecord(value)) {
    for (const key of LEAD_KEYS) {
      if (key in value && !isEmpty(value[key])) writeField(lines, key, value[key], 0);
    }
    for (const [key, entry] of Object.entries(value)) {
      if ((LEAD_KEYS as readonly string[]).includes(key) || isEmpty(entry)) continue;
      writeField(lines, key, entry, 0);
    }
  } else {
    writeItems(lines, value as unknown[], 0);
  }
  return lines.length === 0 ? output : lines.join('\n');
}

function writeField(lines: string[], key: string, value: unknown, depth: number): void {
  const pad = '  '.repeat(depth);
  if (isScalar(value)) {
    const text = String(value);
    // A multi-line value keeps its own lines, indented under its key.
    if (text.includes('\n')) {
      lines.push(`${pad}- ${key}:`);
      for (const line of text.split('\n')) lines.push(`${pad}  ${line}`);
    } else {
      lines.push(`${pad}- ${key}: ${text}`);
    }
    return;
  }
  lines.push(`${pad}- ${key}:`);
  if (Array.isArray(value)) writeItems(lines, value, depth + 1);
  else writeRecord(lines, value as Record<string, unknown>, depth + 1);
}

function writeRecord(lines: string[], value: Record<string, unknown>, depth: number): void {
  for (const [key, entry] of Object.entries(value)) {
    if (!isEmpty(entry)) writeField(lines, key, entry, depth);
  }
}

function writeItems(lines: string[], items: readonly unknown[], depth: number): void {
  const pad = '  '.repeat(depth);
  for (const item of items) {
    if (isEmpty(item)) continue;
    if (isScalar(item)) {
      lines.push(`${pad}- ${String(item)}`);
    } else if (Array.isArray(item)) {
      lines.push(`${pad}-`);
      writeItems(lines, item, depth + 1);
    } else {
      // One record per bullet: its scalar fields share the bullet line.
      const record = item as Record<string, unknown>;
      const scalars = Object.entries(record).filter(([, entry]) => isScalar(entry) && !isEmpty(entry) && !String(entry).includes('\n'));
      const rest = Object.entries(record).filter(([key, entry]) => !isEmpty(entry) && !scalars.some(([name]) => name === key));
      lines.push(`${pad}- ${scalars.map(([key, entry]) => `${key}: ${String(entry)}`).join('; ')}`);
      for (const [key, entry] of rest) writeField(lines, key, entry, depth + 1);
    }
  }
}

function isScalar(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined || value === '') return true;
  if (Array.isArray(value)) return value.length === 0;
  if (isRecord(value)) return Object.keys(value).length === 0;
  return false;
}
