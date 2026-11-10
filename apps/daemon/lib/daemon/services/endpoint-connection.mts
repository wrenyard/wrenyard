import type { GatewayConnection, GatewayModel } from '@wrenyard/ai-protocol'
import { parseModelList, type NormalizedModelMetadata } from './endpoint-models.mts'

/** One standard Chat endpoint as the daemon config declares it. */
export interface EndpointConfig {
  /** Complete Chat Base URL; the model list is read from `${url}/models`. */
  url: string
  /** Bearer token sent to the endpoint. */
  token: string
}

/** The fetch seam the endpoint connection reads its model list through. */
export type EndpointFetch = (url: string, init?: RequestInit) => Promise<Response>

/** Synthetic provider identity for endpoint models without a `/` prefix. */
const ENDPOINT_PROVIDER = 'wrenyard'

function chatConnectionModel(model: NormalizedModelMetadata): GatewayModel {
  const separator = model.id.indexOf('/')
  const provider = separator > 0 ? model.id.slice(0, separator) : ENDPOINT_PROVIDER
  const id = separator > 0 ? model.id.slice(separator + 1) : model.id
  return {
    id,
    // The endpoint's own spelling is the public identity the transport sends.
    publicId: model.id,
    provider,
    protocols: ['openai_chat'],
    displayName: model.displayName,
    maxInputTokens: model.maxInputTokens,
    ...(model.maxOutputTokens === undefined ? {} : { maxOutputTokens: model.maxOutputTokens }),
    // The connection contract always carries a ladder; an unknown one is empty.
    reasoningEfforts: model.reasoningEfforts ?? [],
    inputModalities: model.inputModalities,
  }
}

/**
 * Build the daemon connection from one configured standard endpoint. The
 * complete Chat Base URL is used verbatim, the model list is read from its
 * `${url}/models` child and normalized by `parseModelList`, and every model is
 * advertised over the Chat protocol only. The other base-URL fields keep the
 * shared connection shape while no model selects those protocols.
 */
export async function endpointConnection(
  endpoint: EndpointConfig,
  fetch: EndpointFetch = globalThis.fetch,
): Promise<GatewayConnection> {
  const baseUrl = endpoint.url.replace(/\/+$/, '')
  const response = await fetch(`${baseUrl}/models`, {
    headers: { Authorization: `Bearer ${endpoint.token}` },
  })
  if (!response.ok) {
    throw new Error(`endpoint models request failed with status ${response.status}`)
  }
  const models = parseModelList(await response.json()).map(chatConnectionModel)
  return {
    openaiChatBaseUrl: baseUrl,
    openaiResponsesBaseUrl: baseUrl,
    anthropicBaseUrl: baseUrl,
    token: endpoint.token,
    models,
  }
}
