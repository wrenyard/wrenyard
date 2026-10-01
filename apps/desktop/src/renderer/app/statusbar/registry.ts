/**
 * `app/` facade over the status-bar registry that lives below `components/` in
 * `@/renderer/lib/statusbar`. Pages register items through this module so the
 * registration surface can evolve without every page reaching into `lib/`.
 * This file is a thin re-export only; the store and metadata live in `lib/`.
 */
export {
  registerStatusBarItem,
  useStatusBarItem,
  useStatusBarItems,
  STATUS_BAR_CONFIGURABLE_ITEMS,
  STATUS_BAR_MANDATORY_IDS,
  isConfigurableStatusBarItem,
  isMandatoryStatusBarItem,
} from '@/renderer/lib/statusbar';

export type {
  StatusBarItemDefinition,
  StatusBarSide,
  UseStatusBarItemOptions,
} from '@/renderer/lib/statusbar';
