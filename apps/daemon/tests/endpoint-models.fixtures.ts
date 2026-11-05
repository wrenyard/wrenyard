/**
 * Frozen, credential-free model-list fixtures for the approved R4 cases.
 *
 * Each fixture is a complete response wrapper with a synthetic endpoint name.
 * Sources are the documented response shapes checked on 2026-11-05; no fixture
 * is downloaded or replayed against a live service during the unit test.
 */
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const nested of Object.values(value)) freeze(nested)
  }
  return value
}

/** Magpie routing-group list shape, synthetic endpoint values. */
export const magpieRoutingGroup = freeze({
  object: 'list',
  data: [{
    id: 'group/coding',
    name: 'Coding Group',
    max_input_tokens: 1_048_576,
    max_output_tokens: 1_000_000,
    reasoning_levels: ['high'],
    modalities: { input: ['text', 'image'] },
  }],
})

/** Magpie codex route whose endpoint values differ from the static catalog. */
export const magpieCodexRoute = freeze({
  object: 'list',
  data: [{
    id: 'codex/gpt-6-astra',
    display_name: 'GPT 6 Astra',
    max_input_tokens: 272_000,
    max_output_tokens: 128_000,
    reasoning_levels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    modalities: { input: ['text', 'image'] },
  }],
})

/** Kimi coding endpoint row with no output limit and an unregistered exact id. */
export const kimiK31Pro = freeze({
  object: 'list',
  data: [{
    id: 'kimi-coding/k3.1-pro',
    display_name: 'Kimi K3.1 Pro',
    max_input_tokens: 1_048_576,
    reasoning_levels: ['low', 'high', 'max'],
    modalities: { input: ['text', 'image', 'video'] },
  }],
})

/** OpenAI models list shape where the entry carries no optional metadata. */
export const openAiGpt61Sol = freeze({
  object: 'list',
  data: [{
    id: 'gpt-6.1-sol',
    object: 'model',
    created: 1_790_000_000,
    owned_by: 'openai',
  }],
})

/** Zhipu Chat models list shape where the entry carries no optional metadata. */
export const zhipuChatGlm53 = freeze({
  object: 'list',
  data: [{
    id: 'glm-5.3',
    object: 'model',
    created: 1_790_000_000,
    owned_by: 'zhipu',
  }],
})

/**
 * Zhipu Responses models[] shape.
 * Source: documented compatible-response example checked 2026-11-05.
 */
export const zhipuResponsesGlm53 = freeze({
  models: [{
    slug: 'glm-5.3',
    display_name: 'GLM-5.3',
    max_input_tokens: 200_000,
    input_modalities: ['text'],
  }],
})

/**
 * Anthropic models list shape.
 * Source: documented response format, not a live official capture.
 */
export const anthropicOpus55 = freeze({
  data: [{
    type: 'model',
    id: 'claude-opus-5-5',
    display_name: 'Claude Opus 5.5',
    created_at: '2026-09-22T00:00:00Z',
  }],
  first_id: 'claude-opus-5-5',
  has_more: false,
  last_id: 'claude-opus-5-5',
})

/** Wrenyard gateway /models row for HY4 using the published metadata fields. */
export const gatewayHy4 = freeze({
  object: 'list',
  data: [{
    id: 'tencent/hy4',
    object: 'model',
    display_name: 'HY4',
    context_window: 1_048_576,
    max_tokens: 65_536,
    reasoning_levels: ['none', 'high'],
    modalities: { input: ['text', 'image'] },
  }],
})

/** OpenAI dated model id with no exact registered identity. */
export const openAiDatedGpt55 = freeze({
  object: 'list',
  data: [{
    id: 'gpt-5.5-2026-04-23',
    object: 'model',
    created: 1_777_000_000,
    owned_by: 'openai',
  }],
})
