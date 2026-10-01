import { type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import {
  Page,
  PageActions,
  PageContent,
  PageDescription,
  PageHeader,
  PageTitle,
} from '@/renderer/components/page';
import { Button } from '@/renderer/components/ui/button';
import { CardDescription, CardTitle } from '@/renderer/components/ui/card';
import { AboutSettings } from './components/AboutSettings.js';
import { AppearanceSettings } from './components/AppearanceSettings.js';
import { PetSettings } from './components/PetSettings.js';
import { ProviderSettings } from './components/ProviderSettings.js';
import { RoutingWeightsSettings } from './components/RoutingWeightsSettings.js';
import { RuntimeSettings } from './components/RuntimeSettings.js';
import { SummarySettings } from './components/SummarySettings.js';
import { UpdateSettings } from './components/UpdateSettings.js';
import * as copy from './model/describe.js';
import { SETTINGS_QUERY_KEYS } from './queries.js';

/** A labelled settings region: heading copy above one composed card group. */
function SettingsSection({ id, title, description, children }: {
  id: string;
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <CardTitle>{title}</CardTitle>
        {description !== undefined && <CardDescription>{description}</CardDescription>}
      </div>
      {children}
    </section>
  );
}

/**
 * The Settings Activity. All reads are TanStack queries over the typed desktop
 * bridge; the daemon and update snapshots are invalidated by the app-level push
 * subscriptions (see `app/query-client`), so the page owns no subscriptions.
 */
export function SettingsPage() {
  const queryClient = useQueryClient();

  const refresh = (): void => {
    for (const queryKey of SETTINGS_QUERY_KEYS) {
      void queryClient.invalidateQueries({ queryKey });
    }
  };

  return (
    <Page data-page="settings">
      <PageHeader>
        <PageTitle>{copy.PAGE_TITLE}</PageTitle>
        <PageDescription>{copy.PAGE_DESCRIPTION}</PageDescription>
        <PageActions>
          <Button variant="outline" onClick={refresh}>
            <RefreshCw />
            {copy.REFRESH_LABEL}
          </Button>
        </PageActions>
      </PageHeader>
      <PageContent>
        <SettingsSection id="settings-appearance" title={copy.APPEARANCE_TITLE} description={copy.APPEARANCE_DESCRIPTION}>
          <AppearanceSettings />
        </SettingsSection>

        <SettingsSection id="settings-runtime" title={copy.RUNTIME_TITLE} description={copy.RUNTIME_DESCRIPTION}>
          <RuntimeSettings />
        </SettingsSection>

        <SettingsSection id="settings-routing" title={copy.ROUTING_TITLE} description={copy.ROUTING_DESCRIPTION}>
          <RoutingWeightsSettings />
        </SettingsSection>

        <SettingsSection id="settings-summary" title={copy.SUMMARY_TITLE} description={copy.SUMMARY_DESCRIPTION}>
          <SummarySettings />
        </SettingsSection>

        <SettingsSection id="settings-provider" title={copy.PROVIDER_TITLE}>
          <ProviderSettings />
        </SettingsSection>

        <SettingsSection id="settings-companion" title={copy.PET_TITLE} description={copy.PET_DESCRIPTION}>
          <PetSettings />
        </SettingsSection>

        <SettingsSection id="settings-update" title={copy.UPDATE_TITLE} description={copy.UPDATE_DESCRIPTION}>
          <UpdateSettings />
        </SettingsSection>

        <SettingsSection id="settings-about" title={copy.ABOUT_TITLE} description={copy.ABOUT_DESCRIPTION}>
          <AboutSettings />
        </SettingsSection>
      </PageContent>
    </Page>
  );
}
