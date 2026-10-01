import { confirm } from '@/renderer/components/confirm-host';
import type { ConfirmOptions } from '@/renderer/components/confirm-host';

export type { ConfirmOptions };

/**
 * Returns the shared `confirm(options): Promise<boolean>`. The matching
 * `ConfirmHost` is mounted once in `App`; this hook just exposes the store's
 * entry point so pages never render their own confirmation dialog.
 */
export function useConfirm(): (options: ConfirmOptions) => Promise<boolean> {
  return confirm;
}
