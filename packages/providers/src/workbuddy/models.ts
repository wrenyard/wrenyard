import type { ModelDefinition, ProviderDefinition } from '../base/index.ts';
import { createCodeBuddyModels } from '../codebuddy/models.ts';
import { codeBuddyRouteFailure } from '../codebuddy/route-errors.ts';
import type { CodeBuddyProductModelEntry } from '../codebuddy/product.ts';
import type { WorkBuddyBuild } from './definition.ts';

export interface WorkBuddyModelState {
  readonly definition: ProviderDefinition;
  upstreamModels: Readonly<Record<string, string>>;
  publish(entries: readonly CodeBuddyProductModelEntry[]): void;
}

export function createWorkBuddyModelState(build: WorkBuddyBuild): WorkBuddyModelState {
  const definition: ProviderDefinition = emptyDefinition(build);
  let upstreamModels: Readonly<Record<string, string>> = Object.freeze({});

  const publish = (entries: readonly CodeBuddyProductModelEntry[]): void => {
    const seeded = createCodeBuddyModels(entries);
    const protocol = seeded.definition.protocols?.[0];
    upstreamModels = Object.freeze(protocol?.upstreamModels ?? {});
    definition.models = seeded.definition.models;
    definition.modelAliases = seeded.definition.modelAliases;
    definition.reasoningEffortMappings = seeded.definition.reasoningEffortMappings;
    definition.defaultModel = seeded.definition.models[0]?.id;
    definition.convertReasoningEffort = seeded.definition.convertReasoningEffort;
    definition.protocols = [{
      protocol: 'openai_chat',
      endpoint: build.chatEndpoint,
      authScheme: 'bearer',
      upstreamModels,
    }];
  };

  return {
    definition,
    get upstreamModels() { return upstreamModels; },
    publish,
  };
}

function emptyDefinition(build: WorkBuddyBuild): ProviderDefinition {
  return {
    id: build.id,
    displayName: build.displayName,
    description: `${build.displayName} 模型供应。`,
    setupHint: build.setupHint,
    credentialResolver: 'workbuddy',
    // The CN endpoint can return prose even when the requested tool is required.
    ignoresForcedToolChoice: build.id === 'workbuddy',
    models: [],
    protocols: [{
      protocol: 'openai_chat',
      endpoint: build.chatEndpoint,
      authScheme: 'bearer',
      upstreamModels: Object.freeze({}),
    }],
    classifyUpstreamError: codeBuddyRouteFailure,
    convertReasoningEffort(modelId, effort) {
      throw new Error(`WorkBuddy model ${modelId} does not support reasoning effort ${effort}`);
    },
  };
}

export type { ModelDefinition };
