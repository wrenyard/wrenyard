/**
 * Electron-free desktop interaction policy. Kept free of any electron imports
 * so it can be tested deterministically without timers, sleeps, or an app.
 */

export type QuitOrigin = 'accelerator' | 'direct';
export type QuitDecision = 'warn' | 'quit';

export interface MacQuitConfirmationGate {
  (origin: QuitOrigin, now?: number): QuitDecision;
}

/**
 * Primary tray click restores the desktop window on every platform except
 * macOS, where a tray that owns a context menu opens that menu on primary
 * click and must never steal the restore gesture.
 */
export function trayPrimaryClickOpensDesktop(platform: NodeJS.Platform): boolean {
  return platform !== 'darwin';
}

/**
 * Two-step macOS Cmd+Q confirmation gate.
 *
 * - A direct quit (menu Quit item, tray 退出, updater, system shutdown) always
 *   clears any armed state and returns 'quit' immediately.
 * - The first accelerator press - or one arriving after the window expired -
 *   arms a deadline at `now + windowMs` and returns 'warn'.
 * - A second accelerator at or before the armed deadline clears the state and
 *   returns 'quit'.
 *
 * The gate is pure and deterministic: it keeps no timers, so callers pass the
 * current time via `now` (defaulting to `Date.now()`).
 */
export function createMacQuitConfirmationGate(options: { windowMs: number }): MacQuitConfirmationGate {
  const { windowMs } = options;
  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    throw new RangeError('createMacQuitConfirmationGate requires a positive finite windowMs');
  }
  let armedUntil = 0;
  return (origin, now = Date.now()) => {
    if (origin === 'direct') {
      armedUntil = 0;
      return 'quit';
    }
    if (now > armedUntil) {
      armedUntil = now + windowMs;
      return 'warn';
    }
    armedUntil = 0;
    return 'quit';
  };
}
