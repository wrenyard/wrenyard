import { getSessionBridge } from '@/renderer/lib/session';
import type { SessionApi } from './model/types.js';

/** Page-local facade; the shared bridge also supplies session settings. */
export function getSessionApi(): SessionApi {
  return getSessionBridge();
}
