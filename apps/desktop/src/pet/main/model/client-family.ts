import type { WorkerClient } from '../../shared/snapshot';

/** Map a raw client-family value to a worker client. Empty maps to null. */
export function normalizeClientFamily(clientFamily: string | undefined): WorkerClient | null {
  const normalized = clientFamily?.trim().toLowerCase();
  if (!normalized) return null;

  if (normalized === 'claude') return 'claude';
  if (normalized === 'codex') return 'codex';
  if (normalized === 'codebuddy') return 'codebuddy';
  if (normalized === 'dsh') return 'dsh';
  return 'unknown';
}

/**
 * Client key of a run-syntax profile `provider/model:clientKey`. Returns null
 * when the profile is not run syntax (needs a `/` and a later `:`).
 */
function runSyntaxClientKey(profile: string): string | null {
  const slash = profile.indexOf('/');
  if (slash < 0) return null;
  const colon = profile.lastIndexOf(':');
  if (colon <= slash) return null;
  return profile.slice(colon + 1).trim();
}

/** Map a run-syntax client key to a worker client; unknown keys stay unknown. */
function clientFromKey(key: string): WorkerClient {
  const normalized = key.toLowerCase();
  if (normalized === 'cc') return 'claude';
  if (normalized === 'cb') return 'codebuddy';
  if (normalized === 'codex') return 'codex';
  if (normalized === 'dsh') return 'dsh';
  return 'unknown';
}

/**
 * Classify the client from client identity only — never from the model
 * provider or model name. Precedence: (a) a `cb-` legacy alias is always
 * CodeBuddy; (b) a run-syntax profile `provider/model:clientKey` is decided by
 * the launched client key alone and wins over the recorded client family;
 * (c) an explicit client family is otherwise authoritative; (d) legacy profile
 * aliases; (e) unknown.
 */
export function classifyWorkerClient(profile: string, clientFamily?: string): WorkerClient {
  // (a) Legacy forge-era alias: a `cb-` profile is always CodeBuddy.
  if (/^cb-/i.test(profile)) return 'codebuddy';

  // (b) Run syntax `provider/model:clientKey` — provider and model are ignored.
  // The launched client key wins over the recorded family: old forge-era rows
  // recorded client_family 'claude' for CodeBuddy runs.
  const key = runSyntaxClientKey(profile);
  if (key !== null) return clientFromKey(key);

  // (c) A present client family is authoritative and never falls back to profile.
  const fromSession = normalizeClientFamily(clientFamily);
  if (fromSession !== null) return fromSession;

  // (d) Legacy profile aliases.
  if (/^codex(?:-|$)/i.test(profile)) return 'codex';
  if (/^dsh(?:-|$)/i.test(profile)) return 'dsh';
  if (/^cc/i.test(profile)) return 'claude';
  return 'unknown';
}
