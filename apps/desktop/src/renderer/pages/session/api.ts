import { getSessionBridge } from '@/renderer/lib/session';
import type {
  SessionPromptCancelParams,
  SessionPromptSuggestParams,
  SessionPromptSuggestResult,
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

/** Request one next-input suggestion; the daemon reads the session itself. */
export function promptSuggest(
  request: SessionPromptSuggestParams,
): Promise<SessionPromptSuggestResult> {
  return getSessionApi().promptSuggest(request);
}

/** Cancel one in-flight suggestion request by its own request id. */
export function promptCancel(request: SessionPromptCancelParams): Promise<void> {
  return getSessionApi().promptCancel(request);
}
