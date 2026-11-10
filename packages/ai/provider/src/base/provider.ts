import type { ClientDefinition, GatewayProtocol, ProviderDefinition } from './contracts.ts';
import type { ProviderQuota } from './provider-quota.ts';

export interface ProviderCredential {
  value: string;
}

/** Privacy-safe free-supply evidence for an exact model and loaded credential.
 * CodeBuddy environment rules and verified managed free-model rules are separate.
 * No credential or account identity is exposed in this fact. */
export interface RoutingFreeSupplyFact {
  readonly confirmedFree: true
  /** Stable source label for the classification evidence. */
  readonly source: string
  /** Stable policy rule id granting the confirmed-free classification. */
  readonly ruleId: string
}


/** One supplier: its offerings and the behavior needed to use them. */
export interface Provider {
  readonly id: string;
  readonly definition: ProviderDefinition;
  readonly clients: readonly ClientDefinition[];
  readonly quota: ProviderQuota;
  credential(): Promise<ProviderCredential | undefined>;
  resolveModel(model: string, credential?: ProviderCredential): string;
  canonicalizeModel(model: string): string;
  applyHeaders(headers: Headers, credential: ProviderCredential, protocol: GatewayProtocol): void;
  freeSupply(model: string, credential: ProviderCredential): RoutingFreeSupplyFact | undefined;
  configureApiKey?(key: string): Promise<void>;
}

export interface ProviderContext {
  env: NodeJS.ProcessEnv;
  home: string;
  platform: NodeJS.Platform;
  readFile(path: string, encoding: 'utf8'): Promise<string>;
  realpath(path: string): Promise<string>;
}
