import type { ReactNode } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/renderer/components/ui/tabs';
import { cn } from 'cn';
import type { ProviderCatalogSnapshot, QuotaSnapshot } from '@/shell-contract';
import { ProviderSupply } from '../../supply/components/ProviderSupply.js';
import { ProviderUsage } from '../../supply/components/ProviderUsage.js';
import { RoutingTest } from '../../supply/components/RoutingTest.js';
import { SettingRow, type SettingBinding } from '../../components/SettingRow.js';
import type { SettingDefinition } from '../registry.js';
import {
  SUPPLY_TAB_LABELS,
  SUPPLY_TAB_ORDER,
  type SupplyTabId,
} from './location.js';

export interface SupplySettingsProps {
  tab: SupplyTabId;
  onTabChange: (tab: SupplyTabId) => void;
  snapshot: QuotaSnapshot;
  savingOrder: boolean;
  reorderError: string;
  onReorder: (providerIds: string[]) => void;
  onConfigure: (entry: ProviderCatalogSnapshot) => void;
  routingActive: boolean;
  usageSettings: readonly SettingDefinition[];
  gatewaySettings: readonly SettingDefinition[];
  routingSettings: readonly SettingDefinition[];
  preferenceBindings: Map<string, SettingBinding>;
  highlightTerms: readonly string[];
  flashId: string | null;
  renderSetting: (definition: SettingDefinition) => ReactNode;
}

/**
 * 模型供应 page body: line-style sub-tabs under the fixed category heading.
 */
export function SupplySettings({
  tab,
  onTabChange,
  snapshot,
  savingOrder,
  reorderError,
  onReorder,
  onConfigure,
  routingActive,
  usageSettings,
  gatewaySettings,
  routingSettings,
  preferenceBindings,
  highlightTerms,
  flashId,
  renderSetting,
}: SupplySettingsProps) {
  return (
    <Tabs
      value={tab}
      onValueChange={(value) => {
        if (value !== null) onTabChange(value as SupplyTabId);
      }}
      className="gap-6"
    >
      <div className="border-b">
        <TabsList
          variant="line"
          className="h-8 w-full justify-start gap-4 rounded-none bg-transparent p-0"
        >
          {SUPPLY_TAB_ORDER.map((id) => (
            <TabsTrigger
              key={id}
              value={id}
              className={cn(
                'h-8 flex-none px-0 text-muted-foreground data-active:text-foreground',
              )}
            >
              {SUPPLY_TAB_LABELS[id]}
            </TabsTrigger>
          ))}
        </TabsList>
      </div>

      <TabsContent value="providers" className="flex flex-col gap-6">
        <ProviderSupply
          snapshot={snapshot}
          savingOrder={savingOrder}
          reorderError={reorderError}
          onReorder={onReorder}
          onConfigure={onConfigure}
        />
      </TabsContent>

      <TabsContent value="usage" className="flex flex-col gap-6">
        <ProviderUsage />
        {usageSettings.length > 0 && (
          <section className="overflow-hidden rounded-xl border bg-card">
            <div className="@container/field-group flex w-full flex-col divide-y">
              {usageSettings.map((definition) => (
                <SettingRow
                  key={definition.id}
                  definition={definition}
                  binding={preferenceBindings.get(definition.id)}
                  highlightTerms={highlightTerms}
                  flashed={flashId === definition.id}
                />
              ))}
            </div>
          </section>
        )}
      </TabsContent>

      <TabsContent value="gateway" className="flex flex-col gap-6">
        {gatewaySettings.length > 0 && (
          <section className="overflow-hidden rounded-xl border bg-card">
            <div className="@container/field-group flex w-full flex-col divide-y">
              {gatewaySettings.map((definition) => renderSetting(definition))}
            </div>
          </section>
        )}
      </TabsContent>

      <TabsContent value="routing" className="flex flex-col gap-6">
        {routingSettings.length > 0 && (
          <section className="overflow-hidden rounded-xl border bg-card">
            <div className="@container/field-group flex w-full flex-col divide-y">
              {routingSettings.map((definition) => renderSetting(definition))}
            </div>
          </section>
        )}
        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-medium text-muted-foreground">路由测试</h3>
          <RoutingTest snapshot={snapshot} active={routingActive && tab === 'routing'} />
        </section>
      </TabsContent>
    </Tabs>
  );
}
