/**
 * Renderer-side desktop bridge helpers. This is the only renderer module that
 * reads `window.wrenyardShell`; UI components call these functions instead of
 * touching the preload facade directly.
 */

/**
 * Copy text through the shell bridge, falling back to the browser clipboard
 * when the bridge rejects or is unavailable.
 */
export async function copyText(text: string): Promise<void> {
  const shell = window.wrenyardShell;
  if (shell && typeof shell.copyText === 'function') {
    try {
      await shell.copyText(text);
      return;
    } catch {
      // Fall through to the web clipboard when the shell bridge rejects.
    }
  }
  await navigator.clipboard.writeText(text);
}

/** Open an `http(s)` URL in the OS browser through the shell bridge. */
export function openExternal(url: string): Promise<void> {
  return window.wrenyardShell.openExternal(url);
}

/** Open a task-run transcript through the shell bridge. */
export function openTaskTranscript(taskRunId: string): Promise<void> {
  return window.wrenyardShell.openTaskTranscript(taskRunId);
}
