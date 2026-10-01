import { UpdatePanel } from '@/renderer/components/update-panel';

/**
 * Current-version status: the shared update panel (version, last check, and
 * the check/install actions). The `update.autoCheck` row lives beside it as a
 * standard preference control.
 */
export function UpdateStatusControl() {
  return <UpdatePanel />;
}
