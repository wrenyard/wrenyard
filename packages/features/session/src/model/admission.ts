/**
 * Session model admission: the endpoint's model list decides which model a
 * session may run. No provider catalog lookup participates.
 */
import type { GatewayModel } from '@wrenyard/ai-protocol';

/**
 * The endpoint row a session selection names, or a rejection when the endpoint
 * does not list it. `provider` and `model` are the selection's separate
 * dimensions; the endpoint publishes their provider-qualified `publicId`.
 */
export function admitSessionModel(
  models: readonly GatewayModel[],
  provider: string,
  model: string,
): GatewayModel {
  const publicId = `${provider}/${model}`;
  const definition = models.find((entry) => entry.publicId === publicId);
  if (definition === undefined) {
    throw new Error(
      `Model ${publicId} is unavailable for sessions: the endpoint does not list it`,
    );
  }
  return definition;
}
