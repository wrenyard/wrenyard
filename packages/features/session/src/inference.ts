/**
 * session inference driver selection.
 *
 * `createInferenceDriver` is the single place a call chooses its transport.
 * An auxiliary request (every role whose request does not declare `actionTool`)
 * always runs through the OpenAI-compatible chat driver with the acquired
 * gateway: its model is a gateway public id, so no provider protocol lookup and
 * no model substitution is applied. A main-reasoning request (`actionTool:
 * true`) is resolved against the host's provider definitions and the
 * shared {@link selectInferenceMode} precedence, which binds a provider's
 * declared gateway protocols to exactly one runtime (`openai_chat` before
 * `openai_responses`), then runs the matching adapter.
 */
import type { WrenyardGatewayConnection } from '@wrenyard/control-client';
import type { ProviderDefinition } from '@wrenyard/providers';

import {
  createGatewayDriver,
  type DriverRequest,
  type DriverResult,
  type ModelDriver,
} from './driver.ts';
import { selectInferenceMode } from './inference-mode.ts';
import { createResponsesDriver } from './responses-driver.ts';

/** Resolves the current gateway connection; called lazily inside `complete`. */
export type GatewayConnectionSource = () => Promise<WrenyardGatewayConnection>;

export interface InferenceDriverOptions {
  /** Fetch implementation forwarded to whichever protocol adapter runs. */
  fetch?: typeof fetch;
  /**
   * The host's provider definitions, the only provider source for main-runtime
   * selection: an id it does not resolve is an unknown provider.
   */
  resolveProvider: (id: string) => ProviderDefinition | undefined;
}

/**
 * The one main-reasoning runtime for a `provider/model` public id, or a thrown
 * error when the target is unknown, task-only, client-restricted or has no
 * declared runtime. Resolution uses the host resolver plus the shared
 * {@link selectInferenceMode} precedence.
 */
function selectMainRuntime(
  publicId: string,
  resolveProvider: (id: string) => ProviderDefinition | undefined,
): 'openai_chat' | 'openai_responses' {
  const separator = publicId.indexOf('/');
  if (separator <= 0 || separator === publicId.length - 1) {
    throw new Error(`Inference model must be provider/model form: ${publicId}`);
  }
  const providerId = publicId.slice(0, separator);
  const requestedModelId = publicId.slice(separator + 1);
  const provider = resolveProvider(providerId);
  if (!provider) throw new Error(`Unknown inference provider: ${providerId}`);
  const modelId = provider.modelAliases?.[requestedModelId] ?? requestedModelId;
  const model = provider.models.find((entry) => entry.id === modelId && entry.taskOnly !== true);
  if (!model) throw new Error(`Unknown inference model: ${publicId}`);
  if (model.supportedClients !== undefined) {
    throw new Error(`Inference model ${publicId} is restricted to specific clients`);
  }
  const mode = selectInferenceMode((provider.protocols ?? []).map((capability) => capability.protocol));
  if (mode === undefined) throw new Error(`Inference model ${publicId} has no supported runtime`);
  return mode;
}

/**
 * Create the session inference driver over a lazily-acquired gateway. A main
 * reasoning request selects Chat or Responses through {@link selectMainRuntime};
 * every auxiliary request always uses the chat driver with the acquired gateway
 * and forwards the request unchanged.
 */
export function createInferenceDriver(
  gateway: GatewayConnectionSource,
  options: InferenceDriverOptions,
): ModelDriver {
  return {
    async complete(request: DriverRequest): Promise<DriverResult> {
      if (request.actionTool !== true) {
        const connection = await gateway();
        return createGatewayDriver(connection, options).complete(request);
      }
      // Resolve the runtime before acquiring the gateway so an unsupported
      // target never issues a gateway or model call.
      const runtime = selectMainRuntime(request.model, options.resolveProvider);
      const connection = await gateway();
      const driver = runtime === 'openai_responses'
        ? createResponsesDriver(connection, options)
        : createGatewayDriver(connection, options);
      return driver.complete(request);
    },
  };
}
