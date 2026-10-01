import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { RefreshCwIcon } from 'lucide-react';
import {
  Page,
  PageActions,
  PageContent,
  PageHeader,
  PageTitle,
} from '@/renderer/components/page';
import { Alert, AlertDescription } from '@/renderer/components/ui/alert';
import { Button } from '@/renderer/components/ui/button';
import { QueryError } from '@/renderer/components/query-error';
import { Skeleton } from '@/renderer/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/renderer/components/ui/tabs';
import type { ProviderCatalogSnapshot } from '@/shell-contract';
import { ModelList } from './components/ModelList.js';
import { ProviderDialog } from './components/ProviderDialog.js';
import { ProviderSupply } from './components/ProviderSupply.js';
import { RoutingTest } from './components/RoutingTest.js';
import {
  PAGE_TITLE,
  QUOTA_TABS,
  QUOTA_UNAVAILABLE_FALLBACK,
  REFRESHING_LABEL,
  REFRESH_LABEL,
  errorMessage,
  isQuotaTab,
  type QuotaTab,
} from './model/describe.js';
import { buildModelListRows } from './model/models.js';
import { quotaQuery, useQuotaQuery, useQuotaRefresh, useSaveProviderOrder } from './queries.js';

/**
 * Model Supply page: a header refresh action over three tabs (supply, routing
 * test, model list). All data and every mutating action flow through the typed
 * queries, and the page keeps only page-local view state.
 */
export function QuotaPage() {
  const [tab, setTab] = useState<QuotaTab>('models');
  const [dialogEntry, setDialogEntry] = useState<ProviderCatalogSnapshot | null>(null);
  const [reorderError, setReorderError] = useState('');

  const client = useQueryClient();
  const quota = useQuotaQuery();
  const refresh = useQuotaRefresh();
  const order = useSaveProviderOrder();

  const snapshot = quota.data ?? null;
  const rows = useMemo(() => buildModelListRows(snapshot), [snapshot]);

  const handleReorder = (providerIds: string[]): void => {
    setReorderError('');
    order.mutate(providerIds, {
      onError: (cause) => setReorderError(errorMessage(cause)),
    });
  };

  return (
    <>
      <Page data-page="quota">
        <PageHeader>
          <PageTitle>{PAGE_TITLE}</PageTitle>
          <PageActions>
            <Button
              type="button"
              variant="ghost"
             
              disabled={refresh.isPending}
              onClick={() => refresh.mutate()}
            >
              <RefreshCwIcon />
              {refresh.isPending ? REFRESHING_LABEL : REFRESH_LABEL}
            </Button>
          </PageActions>
        </PageHeader>
        <PageContent>
          {quota.isPending ? (
            <QuotaSkeleton />
          ) : quota.isError || snapshot === null ? (
            <QueryError query={quota} title={QUOTA_UNAVAILABLE_FALLBACK} />
          ) : (
            <Tabs
              value={tab}
              onValueChange={(value) => {
                if (isQuotaTab(value)) setTab(value);
              }}
            >
              <TabsList variant="line">
                {QUOTA_TABS.map((item) => (
                  <TabsTrigger key={item.value} value={item.value}>{item.label}</TabsTrigger>
                ))}
              </TabsList>

              <TabsContent value="supply" keepMounted>
                <div className="flex flex-col gap-4">
                  {snapshot.status !== 'available' && (
                    <Alert variant="destructive">
                      <AlertDescription>{snapshot.message ?? QUOTA_UNAVAILABLE_FALLBACK}</AlertDescription>
                    </Alert>
                  )}
                  <ProviderSupply
                    snapshot={snapshot}
                    savingOrder={order.isPending}
                    reorderError={reorderError}
                    onReorder={handleReorder}
                    onConfigure={setDialogEntry}
                  />
                </div>
              </TabsContent>

              <TabsContent value="routing" keepMounted>
                <RoutingTest snapshot={snapshot} active={tab === 'routing'} />
              </TabsContent>

              <TabsContent value="models" keepMounted>
                <ModelList rows={rows} />
              </TabsContent>
            </Tabs>
          )}
        </PageContent>
      </Page>

      <ProviderDialog
        entry={dialogEntry}
        onClose={() => setDialogEntry(null)}
        onSaved={(next) => client.setQueryData(quotaQuery.queryKey, next)}
      />
    </>
  );
}

/** Placeholder blocks shown while the first quota snapshot loads. */
function QuotaSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      <Skeleton className="h-8 w-64" />
      <div className="flex flex-col gap-3">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    </div>
  );
}
