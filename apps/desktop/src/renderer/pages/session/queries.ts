import { queryOptions } from '@tanstack/react-query';
import type { ContextInspection } from '@/shell-contract';
import type { SessionRoutesPreviewResult } from '@wrenyard/protocol';
import { getSessionApi, routesPreview } from './api.js';

/** Draft sessions have no persisted ledger yet. */
export function contextInspectSessionId(sessionKey: string): string | undefined {
  return sessionKey === '' || sessionKey === 'draft' ? undefined : sessionKey;
}

/** Refreshed explicitly by the session provider, never by ledger sequence changes. */
export function contextQuery(sessionKey: string, model: string) {
  const sessionId = contextInspectSessionId(sessionKey);
  return queryOptions<ContextInspection>({
    queryKey: ['session', 'context', sessionKey, model] as const,
    queryFn: async () => validateContextInspection(await getSessionApi().contextInspect({
      ...(sessionId === undefined ? {} : { sessionId }),
      model,
    }), model),
    enabled: false,
    retry: false,
    staleTime: Infinity,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}

function validateContextInspection(value: unknown, modelId: string): ContextInspection {
  const fail = (): never => { throw new Error('Context inspection returned invalid data.'); };
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return fail();
  const result = value as Record<string, unknown>;
  if (result.model === null || typeof result.model !== 'object' || Array.isArray(result.model)
    || (result.model as Record<string, unknown>).publicId !== modelId) return fail();
  if (typeof result.totalTokens !== 'number' || !Number.isFinite(result.totalTokens) || result.totalTokens < 0) return fail();
  if (typeof result.computedAtSeq !== 'number' || !Number.isSafeInteger(result.computedAtSeq) || result.computedAtSeq < 0) return fail();
  if (!Array.isArray(result.layers) || !Array.isArray(result.items)) return fail();
  const validTokenEntries = (entries: unknown[]): boolean => entries.every((entry) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const tokens = (entry as Record<string, unknown>).tokens;
    return typeof tokens === 'number' && Number.isFinite(tokens) && tokens >= 0;
  });
  if (!validTokenEntries(result.layers) || !validTokenEntries(result.items)) return fail();
  return value as ContextInspection;
}

/** Route previews share the provider's explicit refresh triggers. */
export function routesPreviewQuery(sessionKey: string) {
  const sessionId = contextInspectSessionId(sessionKey);
  return queryOptions<SessionRoutesPreviewResult>({
    queryKey: ['session', 'routes-preview', sessionKey] as const,
    queryFn: () => routesPreview({ ...(sessionId === undefined ? {} : { sessionId }) }),
    enabled: false,
    retry: false,
    staleTime: Infinity,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}
