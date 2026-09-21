import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import type { Provider, ProviderContext } from '../base/index.ts';
import { codeBuddyClient, createCodeBuddyModels } from './models.ts';
import { loadInstalledCodeBuddyProductModels, type CodeBuddyProductModelEntry } from './product.ts';
import { applyCodeBuddyNativeHeaders, createCodeBuddyRuntime, type CodeBuddyActiveSnapshot, type CodeBuddyClientIdentity } from './runtime.ts';
import { codeBuddyDefaultPools, codeBuddyQuotaBindings } from './quota.ts';

export interface CodeBuddyOptions extends Partial<ProviderContext> {
  productPath?: string;
  /** Explicit discovery input, useful for callers owning the product snapshot. */
  productModels?: readonly CodeBuddyProductModelEntry[];
}

export interface CodeBuddy extends Provider {
  snapshot(): Promise<CodeBuddyActiveSnapshot | undefined>;
  clientIdentity(): Promise<CodeBuddyClientIdentity | undefined>;
}

/** Compose discovery, model metadata, routing and quota from one model table. */
export function createCodeBuddy(options: CodeBuddyOptions = {}): CodeBuddy {
  const context: ProviderContext = {
    env: options.env ?? process.env,
    home: options.home ?? homedir(),
    platform: options.platform ?? process.platform,
    readFile: options.readFile ?? ((path, encoding) => fs.readFile(path, encoding)),
    realpath: options.realpath ?? ((path) => fs.realpath(path)),
  };
  const entries = options.productModels ?? loadInstalledCodeBuddyProductModels({
    ...context, productPath: options.productPath,
  }).entries;
  const state = createCodeBuddyModels(entries);
  const runtime = createCodeBuddyRuntime({ ...context, codeBuddyProductPath: options.productPath }, state);
  return {
    id: state.definition.id,
    definition: state.definition,
    clients: [codeBuddyClient],
    quota: {
      bindings: codeBuddyQuotaBindings(state.definition),
      defaultPools: codeBuddyDefaultPools(),
    },
    credential: runtime.credential,
    resolveModel: (model, credential) => runtime.resolveUpstreamModel(model, credential) ?? model,
    canonicalizeModel: runtime.canonicalizeModel,
    applyHeaders: (headers, credential, protocol) => applyCodeBuddyNativeHeaders(headers, state.definition, credential, protocol),
    freeSupply: runtime.freeSupply,
    snapshot: runtime.snapshot,
    clientIdentity: runtime.clientIdentity,
  };
}

export type { CodeBuddyActiveSnapshot, CodeBuddyClientIdentity, CodeBuddyCredential, CodeBuddyEnvironment } from './runtime.ts';
