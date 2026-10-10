import { getSessionBridge } from '@/renderer/lib/session';
import type {
  SessionRoutesPreviewParams,
  SessionRoutesPreviewResult,
} from '@wrenyard/protocol';
import type { SessionApi } from './model/types.js';

/** Page-local facade; the shared bridge also supplies session settings. */
export function getSessionApi(): SessionApi {
  return getSessionBridge();
}

/**
 * Read-only per-role auxiliary route preview; the same accessor pattern as the
 * context inspection query. The preview is session-independent, so the request
 * only carries an optional `sessionId`.
 */
export function routesPreview(
  request: SessionRoutesPreviewParams = {},
): Promise<SessionRoutesPreviewResult> {
  return getSessionApi().routesPreview(request);
}
