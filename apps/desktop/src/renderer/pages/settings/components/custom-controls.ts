import type { ComponentType } from 'react';
import {
  AboutBuildTimeControl,
  AboutDesktopVersionControl,
  AboutDiagnosticsControl,
  AboutThemeControl,
  AboutWrenyardVersionControl,
} from './AboutSettings.js';
import { OperationComponentsControl } from './OperationComponentsSettings.js';
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
import { RuntimeAliasesControl } from './ProviderSettings.js';
import { RoutingWeightsControl } from './RoutingWeightsSettings.js';
import {
  DaemonControl,
  GatewayControl,
  EndpointControl,
  LogsControl,
  ServiceControl,
  SettingsFileControl,
  WorkspaceControl,
} from './RuntimeSettings.js';
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
  daemon: DaemonControl,
  endpoint: EndpointControl,
  gateway: GatewayControl,
  logs: LogsControl,
  operationComponents: OperationComponentsControl,
  petBottomOffset: PetBottomOffsetControl,
  petBubbleSeconds: PetBubbleSecondsControl,
  petDisplay: PetDisplayControl,
  petEnabled: PetEnabledControl,
  petHouseSkin: PetHouseSkinControl,
  petScale: PetScaleControl,
  petShowHouse: PetShowHouseControl,
  petShowTaskgraphs: PetShowTaskgraphsControl,
  petShowWorkers: PetShowWorkersControl,
  routingWeights: RoutingWeightsControl,
  runtimeAliases: RuntimeAliasesControl,
  service: ServiceControl,
  settingsFile: SettingsFileControl,
  statusBarItems: StatusBarSettingsControl,
  themeCards: ThemeCardsControl,
  updateStatus: UpdateStatusControl,
  workspace: WorkspaceControl,
};
