import type { ComponentType } from 'react';
import {
  AboutBuildTimeControl,
  AboutDesktopVersionControl,
  AboutDiagnosticsControl,
  AboutThemeControl,
  AboutWrenyardVersionControl,
} from './AboutSettings.js';
import {
  PetBottomOffsetControl,
  PetBubbleSecondsControl,
  PetDisplayControl,
  PetEnabledControl,
  PetHouseSkinControl,
  PetScaleControl,
  PetShowHouseControl,
  PetShowTaskgraphsControl,
  PetShowWorkersControl,
} from './PetSettings.js';
import {
  AutoPriceCapControl,
  ProviderSummaryControl,
  RuntimeAliasesControl,
} from './ProviderSettings.js';
import { RoutingWeightsControl } from './RoutingWeightsSettings.js';
import {
  DaemonControl,
  EndpointControl,
  LogsControl,
  ServiceControl,
  SettingsFileControl,
  WorkspaceControl,
} from './RuntimeSettings.js';
import { NotificationEventsControl } from './NotificationEvents.js';
import { StatusBarSettingsControl } from './StatusBarSettings.js';
import { ThemeCardsControl } from './ThemeCards.js';
import { UpdateStatusControl } from './UpdateSettings.js';
import type { CustomControlKey } from '../model/registry.js';

/**
 * Upper-layer resolution for the registry's pure-data custom control keys. The
 * model (`model/registry.ts`) stores only the `CustomControlKey` string; this
 * map lives in the component layer so the registry stays free of UI imports.
 */
export const CUSTOM_CONTROLS: Readonly<Record<CustomControlKey, ComponentType>> = {
  aboutBuildTime: AboutBuildTimeControl,
  aboutDesktopVersion: AboutDesktopVersionControl,
  aboutDiagnostics: AboutDiagnosticsControl,
  aboutTheme: AboutThemeControl,
  aboutWrenyardVersion: AboutWrenyardVersionControl,
  autoPriceCap: AutoPriceCapControl,
  daemon: DaemonControl,
  endpoint: EndpointControl,
  logs: LogsControl,
  notificationEvents: NotificationEventsControl,
  petBottomOffset: PetBottomOffsetControl,
  petBubbleSeconds: PetBubbleSecondsControl,
  petDisplay: PetDisplayControl,
  petEnabled: PetEnabledControl,
  petHouseSkin: PetHouseSkinControl,
  petScale: PetScaleControl,
  petShowHouse: PetShowHouseControl,
  petShowTaskgraphs: PetShowTaskgraphsControl,
  petShowWorkers: PetShowWorkersControl,
  providerSummary: ProviderSummaryControl,
  routingWeights: RoutingWeightsControl,
  runtimeAliases: RuntimeAliasesControl,
  service: ServiceControl,
  settingsFile: SettingsFileControl,
  statusBarItems: StatusBarSettingsControl,
  themeCards: ThemeCardsControl,
  updateStatus: UpdateStatusControl,
  workspace: WorkspaceControl,
};
