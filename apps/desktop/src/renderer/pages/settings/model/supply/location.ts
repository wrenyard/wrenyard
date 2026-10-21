/**
 * Supply category sub-tab ids and legacy navigation resolution (category id plus tab).
 */

export type SupplyTabId = 'providers' | 'usage' | 'gateway' | 'routing' | 'clients';

export const SUPPLY_TAB_ORDER: readonly SupplyTabId[] = [
  'providers',
  'usage',
  'gateway',
  'routing',
  'clients',
];

export const SUPPLY_TAB_LABELS: Readonly<Record<SupplyTabId, string>> = {
  providers: '供应商',
  usage: '额度',
  gateway: '网关',
  routing: '路由',
  clients: '客户端',
};

const SUPPLY_TAB_SET = new Set<string>(SUPPLY_TAB_ORDER);

export function isSupplyTabId(value: unknown): value is SupplyTabId {
  return typeof value === 'string' && SUPPLY_TAB_SET.has(value);
}

/** Legacy sidebar category ids map to a supply sub-tab when opening 模型供应. */
const LEGACY_CATEGORY_SUPPLY_TAB: Readonly<Record<string, SupplyTabId>> = {
  providers: 'providers',
  usage: 'usage',
  catalog: 'providers',
  routingTest: 'routing',
  models: 'routing',
  clients: 'clients',
};

/**
 * Picks the supply sub-tab from saved navigation state. A valid `tab` wins;
 * otherwise a legacy category id in `category` selects the mapped tab.
 */
export function resolveSupplyTab(category: string, tab: unknown): SupplyTabId {
  if (isSupplyTabId(tab)) return tab;
  return LEGACY_CATEGORY_SUPPLY_TAB[category] ?? 'providers';
}

/** Registry `group` keys for settings moved under 模型供应. */
export function supplyTabForSettingGroup(group: string | undefined): SupplyTabId {
  if (group === 'usage' || group === 'gateway' || group === 'routing') return group;
  return 'providers';
}
