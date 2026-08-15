import type { WorkerClient } from '../shared/snapshot';

export function normalizeClientFamily(clientFamily: string | undefined): WorkerClient | null {
  const normalized = clientFamily?.trim().toLowerCase();
  if (!normalized) return null;

  if (normalized === 'claude') return 'claude';
  if (normalized === 'codex') return 'codex';
  // OpenCode is the client family that ships CodeBuddy; accept both spellings.
  if (normalized === 'opencode' || normalized === 'codebuddy') return 'codebuddy';
  return 'unknown';
}

export function classifyWorkerClient(profile: string, clientFamily?: string): WorkerClient {
  if (/^cb-/i.test(profile)) return 'codebuddy';

  const fromSession = normalizeClientFamily(clientFamily);

  if (fromSession === 'codebuddy') return 'codebuddy';
  if (fromSession === 'codex' || /^codex(?:-|$)/i.test(profile)) return 'codex';
  if (fromSession === 'claude' || /^cc/i.test(profile) || /claude|anthropic/i.test(profile)) return 'claude';
  return 'unknown';
}
