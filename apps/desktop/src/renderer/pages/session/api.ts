import type { SessionApi } from './model/types.js';

/**
 * The session page's sole read of the preload-exposed bridge. Keeping the
 * `window` access here means the rest of the page never touches the global.
 */
export function getSessionApi(): SessionApi {
  return window.wrenyardSession;
}
