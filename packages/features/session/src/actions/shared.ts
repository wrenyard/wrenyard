import type { ActionExecutionOutcome } from './index.ts';

export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function renderRunFiles(files: readonly { path: string; bytes: number }[]): string {
  if (files.length === 0) return 'The task directory has no files';
  return ['Files in the task directory:', ...files.map((file) => `- ${file.path} (${file.bytes} bytes)`)].join('\n');
}

export function fail(reason: string): ActionExecutionOutcome {
  return { status: 'failed', result: reason, deferred: [] };
}
