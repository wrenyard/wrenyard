/**
 * Generated static model-provider catalog sourced from models.dev.
 *
 * This module is DATA ONLY: it is a checked-in snapshot of the supported
 * provider/model fields, not a runtime fetch. The generic wiring in
 * `models-dev.ts` consumes it to build ProviderDefinitions; nothing here
 * performs I/O.
 *
 * Scope: only the 15 mainstream providers added by this change are retained
 * (google, mistral, groq, togetherai, fireworks-ai, cerebras, deepinfra,
 * cohere, perplexity, nvidia, huggingface, nebius, vercel, sambanova, xai).
 * The models.dev `xai` row is published under Wrenyard's canonical SpaceXAI
 * naming as provider id `spacex-ai-api` (see models-dev.ts); the existing
 * native `spacex-ai` builtin is untouched. Model selection is intentionally
 * limited to at most 5 current text/chat models per provider, preferring
 * flagship/coding models and avoiding deprecated entries. The bulk upstream
 * snapshot is not vendored.
 *
 * Every retained model carries three identities:
 *   - `id`           the exact upstream wire model id, preserved verbatim for
 *                    the route's request.
 *   - `canonicalId`  the Wrenyard canonical registry identity (registered in
 *                    `@wrenyard/models`).
 *   - `displayName`  the canonical SSOT display name (hyphen-free), equal to
 *                    `builtinModelDisplayName(canonicalId)`.
 *
 * Provenance: these 15 providers do NOT come from one snapshot, so a single ETag or SHA-256
 * must not be applied to the whole module. The 14 rows other than `xai` were taken from one
 * fetch; the single `xai` row was taken from a separate, later fetch.
 *
 *   - 14 rows other than `xai`
 *       Source:             https://models.dev/api.json?type=all
 *       Fetched:            2026-10-14T22:21:34Z
 *       ETag:               f3dbe7fd1f33c2ee78ea1606bf7f1958
 *       SHA-256:            f3dbe7fd1f33c2ee78ea1606bf7f1958a54e81b09a1a5285a153d526bce63bb9
 *       Upstream catalogue: 229 providers / 8856 models
 *
 *   - the single `xai` row (published as public provider id `spacex-ai-api`)
 *       Source:    https://models.dev/api.json?type=all
 *       Retrieved: 2026-10-14T22:31:57Z
 *       ETag:      cd7b7ad90ac853c9a9d71d68f1632812
 *       SHA-256:   unknown (not recorded for this fetch)
 *
 *   - pricing classification fetch (separate provenance; used ONLY to classify
 *     the retained rows as flat vs tiered, NOT as the source of the retained
 *     ids/names/limits, which come from Fetch A / Fetch B above)
 *       Source:    https://models.dev/api.json?type=all
 *       Fetched:   2026-10-14T23:30:30Z
 *       ETag:      a35d85820f102ac0a3236690edc0251f
 *       SHA-256:   a35d85820f102ac0a3236690edc0251f1c3ce655d31ac2483ba8b727068b78a8
 *       Method:    read-only GET; only the already-selected 15 providers /
 *                  67 model pairs were read
 *
 * Included:  15 providers / 67 text models (source `xai` row: 13 models, 1 kept)
 *
 * Pricing classification: a `pricing` tuple is published below ONLY when the
 * source gives one scalar (FLAT) cached/input/output rate and all three
 * components are present. A row whose source rate is TIERED (a different price
 * above a token threshold, carried as `cost.tiers` / `cost.context_over_200k`)
 * or otherwise conditional publishes NO tuple, because the flat
 * `[cached, input, output]` runtime shape cannot express tiers without being
 * misleading. Four retained rows are tiered and therefore publish no tuple:
 *
 *   1. `google` `gemini-3.1-pro-preview`
 *        tier above 200000 tokens: cache_read 0.4 / input 4 / output 18
 *        vs base cache_read 0.2 / input 2 / output 12
 *   2. `vercel` `google/gemini-3.1-pro-preview`
 *        tier above 200001 tokens: cache_read 0.4 / input 4 / output 18
 *        vs base cache_read 0.2 / input 2 / output 12
 *   3. `vercel` `openai/gpt-5.6-sol`
 *        tier at 272000 tokens: cache_read 0.8 / input 8 / output 30
 *        vs base cache_read 0.4 / input 4 / output 20
 *   4. `xai` `grok-4.7`
 *        tier above 200000 tokens: cache_read 1 / input 4 / output 12
 *        vs base cache_read 0.5 / input 2 / output 6
 *
 * Rows whose source omits `cache_read`, `input` or `output` likewise publish no
 * tuple rather than a partial one.
 *
 * Only source-exact ids/names, numeric context/output limits, source
 * input-modality capabilities and fully-sourced flat [cached, input, output]
 * pricing are carried. Non-generation-only helpers (embedding, reranking,
 * audio/image-only) are not part of the retained mainstream selection.
 */
import type { ModelCapability } from '@wrenyard/models';

/** One source-exact model row: only the fields the upstream snapshot supplies. */
export interface ModelsDevCatalogModel {
  /** Exact upstream wire model id, preserved verbatim for the route request. */
  readonly id: string;
  /** Canonical registry identity this row maps onto. */
  readonly canonicalId: string;
  /** Canonical SSOT display name (hyphen-free), equal to builtinModelDisplayName(canonicalId). */
  readonly displayName: string;
  readonly contextWindow?: number;
  readonly maxOutputTokens?: number;
  readonly capabilities?: readonly ModelCapability[];
  /** FLAT `[cached, input, output]`; present only when all three are sourced and the source is not tiered. */
  readonly pricing?: readonly [number, number, number];
}

/** The generic endpoint shapes the factory understands: one path each. */
export type ModelsDevCatalogProtocol = 'openai_chat' | 'openai_responses' | 'anthropic_messages';

/** One source-exact provider row with its curated model selection. */
export interface ModelsDevCatalogProvider {
  readonly id: string;
  readonly displayName: string;
  readonly sourceId: string;
  readonly sdk: string;
  readonly baseUrl: string;
  readonly protocol: ModelsDevCatalogProtocol;
  readonly authScheme: 'bearer' | 'x-api-key';
  readonly models: readonly ModelsDevCatalogModel[];
}

export interface ModelsDevCatalogSource {
  readonly url: string;
  readonly fetchedAt: string;
  readonly etag: string;
  readonly includedProviderCount: number;
  readonly includedModelCount: number;
}

/**
 * Snapshot metadata for the 14 rows other than `xai` (Fetch A above). The single `xai` row
 * (`spacex-ai-api`) has its own, separate fetch provenance — retrieved 2026-10-14T22:31:57Z,
 * ETag cd7b7ad90ac853c9a9d71d68f1632812, SHA-256 not recorded — and is not covered by these
 * values. The counts below still describe the whole retained set.
 */
export const MODELS_DEV_CATALOG_SOURCE: ModelsDevCatalogSource = {
  url: "https://models.dev/api.json?type=all",
  fetchedAt: "2026-10-14T22:21:34Z",
  etag: "\"f3dbe7fd1f33c2ee78ea1606bf7f1958\"",
  includedProviderCount: 15,
  includedModelCount: 67,
};

export const MODELS_DEV_CATALOG_PROVIDERS: readonly ModelsDevCatalogProvider[] = [
  {
    id: "google",
    displayName: "Google",
    sourceId: "google",
    sdk: "@ai-sdk/google",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    protocol: "openai_chat",
    authScheme: "bearer",
    models: [
      // Google Gemini API pricing Standard <=200k-prompt tier https://ai.google.dev/gemini-api/docs/pricing checked 2026-10-19; the >200k tier doubles and is not representable in the flat tuple.
      { id: "gemini-3.1-pro-preview", canonicalId: "gemini-3.1-pro-preview", displayName: "Gemini 3.1 Pro Preview", contextWindow: 1048576, maxOutputTokens: 65536, capabilities: ["text", "image"], pricing: [0.2, 2, 12] },
      { id: "gemini-3.5-flash", canonicalId: "gemini-3.5-flash", displayName: "Gemini 3.5 Flash", contextWindow: 1048576, maxOutputTokens: 65536, capabilities: ["text", "image"], pricing: [0.15, 1.5, 9] },
      { id: "gemini-3.1-flash-lite", canonicalId: "gemini-3.1-flash-lite", displayName: "Gemini 3.1 Flash Lite", contextWindow: 1048576, maxOutputTokens: 65536, capabilities: ["text", "image"], pricing: [0.025, 0.25, 1.5] },
      { id: "gemini-3.8-flash", canonicalId: "gemini-3.8-flash", displayName: "Gemini 3.8 Flash", contextWindow: 1048576, maxOutputTokens: 65536, capabilities: ["text", "image"], pricing: [0.075, 0.75, 3.75] },
      { id: "gemini-4-argon", canonicalId: "gemini-4-argon", displayName: "Gemini 4 Argon", contextWindow: 1048576, maxOutputTokens: 32768, capabilities: ["text", "image"], pricing: [0.1, 2, 10] },
    ],
  },
  {
    id: "mistral",
    displayName: "Mistral",
    sourceId: "mistral",
    sdk: "@ai-sdk/mistral",
    baseUrl: "https://api.mistral.ai/v1",
    protocol: "openai_chat",
    authScheme: "bearer",
    models: [
      { id: "mistral-large-4", canonicalId: "mistral-large-4", displayName: "Mistral Large 4", contextWindow: 1048576, maxOutputTokens: 262144, capabilities: ["text", "image"], pricing: [0.07, 0.68, 2.09] },
      { id: "mistral-medium-2604", canonicalId: "mistral-medium-3.5", displayName: "Mistral Medium 3.5", contextWindow: 262144, maxOutputTokens: 262144, capabilities: ["text", "image"], pricing: [0.15, 1.5, 7.5] },
      { id: "mistral-small-latest", canonicalId: "mistral-small-latest", displayName: "Mistral Small", contextWindow: 262144, maxOutputTokens: 256000, capabilities: ["text", "image"], pricing: [0.015, 0.15, 0.6] },
      // https://docs.mistral.ai/models/devstral-2-25-12.md checked 2026-10-19; no cached rate published, so cached falls back to the input rate.
      { id: "devstral-latest", canonicalId: "devstral-2", displayName: "Devstral 2", contextWindow: 262144, maxOutputTokens: 262144, capabilities: ["text"], pricing: [0.4, 0.4, 2] },
      { id: "codestral-latest", canonicalId: "codestral-latest", displayName: "Codestral", contextWindow: 256000, maxOutputTokens: 4096, capabilities: ["text"], pricing: [0.03, 0.3, 0.9] },
    ],
  },
  {
    id: "groq",
    displayName: "Groq",
    sourceId: "groq",
    sdk: "@ai-sdk/groq",
    baseUrl: "https://api.groq.com/openai/v1",
    protocol: "openai_chat",
    authScheme: "bearer",
    models: [
      { id: "openai/gpt-oss-120b", canonicalId: "gpt-oss-120b", displayName: "GPT OSS 120B", contextWindow: 131072, maxOutputTokens: 65536, capabilities: ["text"], pricing: [0.075, 0.15, 0.6] },
      { id: "openai/gpt-oss-20b", canonicalId: "gpt-oss-20b", displayName: "GPT OSS 20B", contextWindow: 131072, maxOutputTokens: 65536, capabilities: ["text"], pricing: [0.0375, 0.075, 0.3] },
      { id: "qwen/qwen3.8-27b", canonicalId: "qwen3.8-27b", displayName: "Qwen3.8 27B", contextWindow: 131042, maxOutputTokens: 16384, capabilities: ["text", "image"] },
      { id: "llama-3.3-70b-versatile", canonicalId: "llama-3.3-70b", displayName: "Llama 3.3 70B", contextWindow: 131072, maxOutputTokens: 32768, capabilities: ["text"] },
      { id: "groq/compound", canonicalId: "groq-compound", displayName: "Groq Compound", contextWindow: 131072, maxOutputTokens: 8192, capabilities: ["text"] },
    ],
  },
  {
    id: "togetherai",
    displayName: "Together AI",
    sourceId: "togetherai",
    sdk: "@ai-sdk/togetherai",
    baseUrl: "https://api.together.ai/v1",
    protocol: "openai_chat",
    authScheme: "bearer",
    models: [
      { id: "deepseek-ai/DeepSeek-V4-Pro-0813", canonicalId: "deepseek-v4-pro-0813", displayName: "DeepSeek V4 Pro 0813", contextWindow: 1048576, maxOutputTokens: 384000, capabilities: ["text"], pricing: [0.13, 1.32, 3.96] },
      { id: "deepseek-ai/DeepSeek-V4.1-Flash", canonicalId: "deepseek-v4.1-flash", displayName: "DeepSeek V4.1 Flash", contextWindow: 1048576, maxOutputTokens: 384000, capabilities: ["text", "image"], pricing: [0.006, 0.3, 1.2] },
      { id: "moonshotai/Kimi-K3", canonicalId: "kimi-k3", displayName: "Kimi K3", contextWindow: 1048576, maxOutputTokens: 131072, capabilities: ["text", "image"], pricing: [0.3, 3, 15] },
      { id: "Qwen/Qwen3.7-Max", canonicalId: "qwen3.7-max", displayName: "Qwen3.7 Max", contextWindow: 1000000, maxOutputTokens: 500000, capabilities: ["text"], pricing: [0.125, 1.25, 3.75] },
      { id: "zai-org/GLM-5.3", canonicalId: "glm-5.3", displayName: "GLM 5.3", contextWindow: 1048576, maxOutputTokens: 262144, capabilities: ["text"], pricing: [0.26, 1.4, 4.4] },
    ],
  },
  {
    id: "fireworks-ai",
    displayName: "Fireworks AI",
    sourceId: "fireworks-ai",
    sdk: "@ai-sdk/openai-compatible",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    protocol: "openai_chat",
    authScheme: "bearer",
    models: [
      { id: "accounts/fireworks/models/deepseek-v4p1-flash", canonicalId: "deepseek-v4.1-flash", displayName: "DeepSeek V4.1 Flash", contextWindow: 1000000, maxOutputTokens: 384000, capabilities: ["text", "image"], pricing: [0.006, 0.3, 1.2] },
      { id: "accounts/fireworks/models/kimi-k3", canonicalId: "kimi-k3", displayName: "Kimi K3", contextWindow: 1048576, maxOutputTokens: 131072, capabilities: ["text", "image"], pricing: [0.3, 3, 15] },
      { id: "accounts/fireworks/models/glm-5p3", canonicalId: "glm-5.3", displayName: "GLM 5.3", contextWindow: 1048573, maxOutputTokens: 262144, capabilities: ["text"], pricing: [0.26, 1.4, 4.4] },
      { id: "accounts/fireworks/models/glm-5p3-flash", canonicalId: "glm-5.3-flash", displayName: "GLM 5.3 Flash", contextWindow: 1048573, maxOutputTokens: 131072, capabilities: ["text", "image"], pricing: [0.03, 0.15, 0.5] },
      { id: "accounts/fireworks/models/qwen3p8-max", canonicalId: "qwen3.8-max", displayName: "Qwen3.8 Max", contextWindow: 262144, maxOutputTokens: 131072, capabilities: ["text", "image"], pricing: [0.25, 2, 6] },
    ],
  },
  {
    id: "cerebras",
    displayName: "Cerebras",
    sourceId: "cerebras",
    sdk: "@ai-sdk/cerebras",
    baseUrl: "https://api.cerebras.ai/v1",
    protocol: "openai_chat",
    authScheme: "bearer",
    models: [
      // https://inference-docs.cerebras.ai/models/openai-oss checked 2026-10-19; cached is billed at the standard input rate per https://inference-docs.cerebras.ai/capabilities/prompt-caching.
      { id: "gpt-oss-120b", canonicalId: "gpt-oss-120b", displayName: "GPT OSS 120B", contextWindow: 131072, maxOutputTokens: 40960, capabilities: ["text"], pricing: [0.35, 0.35, 0.75] },
      { id: "qwen-3.8-27b", canonicalId: "qwen3.8-27b", displayName: "Qwen3.8 27B", contextWindow: 131072, maxOutputTokens: 40960, capabilities: ["text", "image"], pricing: [0.99, 0.99, 1.49] },
    ],
  },
  {
    id: "deepinfra",
    displayName: "Deep Infra",
    sourceId: "deepinfra",
    sdk: "@ai-sdk/deepinfra",
    baseUrl: "https://api.deepinfra.com/v1/openai",
    protocol: "openai_chat",
    authScheme: "bearer",
    models: [
      { id: "deepseek-ai/DeepSeek-V4-Pro-0813", canonicalId: "deepseek-v4-pro-0813", displayName: "DeepSeek V4 Pro 0813", contextWindow: 1048576, maxOutputTokens: 384000, capabilities: ["text"], pricing: [0.1, 1.3, 2.6] },
      { id: "deepseek-ai/DeepSeek-V4.1-Flash", canonicalId: "deepseek-v4.1-flash", displayName: "DeepSeek V4.1 Flash", contextWindow: 1048576, maxOutputTokens: 384000, capabilities: ["text", "image"], pricing: [0.006, 0.2, 0.6] },
      { id: "moonshotai/Kimi-K3", canonicalId: "kimi-k3", displayName: "Kimi K3", contextWindow: 1048576, maxOutputTokens: 131072, capabilities: ["text", "image"], pricing: [0.285, 2.85, 14.25] },
      { id: "zai-org/GLM-5.3", canonicalId: "glm-5.3", displayName: "GLM 5.3", contextWindow: 1048576, maxOutputTokens: 131072, capabilities: ["text"], pricing: [0.2, 0.9, 4] },
      { id: "Qwen/Qwen3.8-Max", canonicalId: "qwen3.8-max", displayName: "Qwen3.8 Max", contextWindow: 256000, maxOutputTokens: 131072, capabilities: ["text", "image"], pricing: [0.206, 1.65, 4.951] },
    ],
  },
  {
    id: "cohere",
    displayName: "Cohere",
    sourceId: "cohere",
    sdk: "@ai-sdk/cohere",
    baseUrl: "https://api.cohere.ai/compatibility/v1",
    protocol: "openai_chat",
    authScheme: "bearer",
    models: [
      { id: "command-a-plus-05-2026", canonicalId: "command-a-plus", displayName: "Command A Plus", contextWindow: 128000, maxOutputTokens: 64000, capabilities: ["text", "image"] },
      { id: "command-a-reasoning-08-2025", canonicalId: "command-a-reasoning", displayName: "Command A Reasoning", contextWindow: 256000, maxOutputTokens: 32000, capabilities: ["text"] },
      { id: "command-a-03-2025", canonicalId: "command-a", displayName: "Command A", contextWindow: 256000, maxOutputTokens: 8000, capabilities: ["text"] },
      { id: "north-mini-code-1-0", canonicalId: "north-mini-code", displayName: "North Mini Code", contextWindow: 256000, maxOutputTokens: 64000, capabilities: ["text"] },
      { id: "command-a-vision-07-2025", canonicalId: "command-a-vision", displayName: "Command A Vision", contextWindow: 128000, maxOutputTokens: 8000, capabilities: ["text", "image"] },
    ],
  },
  {
    id: "perplexity",
    displayName: "Perplexity",
    sourceId: "perplexity",
    sdk: "@ai-sdk/perplexity",
    baseUrl: "https://api.perplexity.ai",
    protocol: "openai_chat",
    authScheme: "bearer",
    models: [
      { id: "sonar", canonicalId: "sonar", displayName: "Sonar", contextWindow: 128000, maxOutputTokens: 4096, capabilities: ["text"] },
      { id: "sonar-pro", canonicalId: "sonar-pro", displayName: "Sonar Pro", contextWindow: 200000, maxOutputTokens: 8192, capabilities: ["text", "image"] },
      { id: "sonar-reasoning-pro", canonicalId: "sonar-reasoning-pro", displayName: "Sonar Reasoning Pro", contextWindow: 128000, maxOutputTokens: 4096, capabilities: ["text", "image"] },
      { id: "sonar-deep-research", canonicalId: "sonar-deep-research", displayName: "Sonar Deep Research", contextWindow: 128000, maxOutputTokens: 32768, capabilities: ["text"] },
    ],
  },
  {
    id: "nvidia",
    displayName: "Nvidia",
    sourceId: "nvidia",
    sdk: "@ai-sdk/openai-compatible",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    protocol: "openai_chat",
    authScheme: "bearer",
    models: [
      { id: "nvidia/nemotron-3-ultra-550b-a55b", canonicalId: "nemotron-3-ultra", displayName: "Nemotron 3 Ultra", contextWindow: 1000000, maxOutputTokens: 65536, capabilities: ["text"], pricing: [0.15, 0.5, 2.5] },
      { id: "nvidia/nemotron-3.5-lightning-30b-a3b", canonicalId: "nemotron-3.5-lightning", displayName: "Nemotron 3.5 Lightning", contextWindow: 262144, maxOutputTokens: 262144, capabilities: ["text"] },
      { id: "deepseek-ai/deepseek-v4-pro", canonicalId: "deepseek-v4-pro", displayName: "DeepSeek V4 Pro", contextWindow: 1048576, maxOutputTokens: 393216, capabilities: ["text"], pricing: [0.003625, 0.435, 0.87] },
      { id: "moonshotai/kimi-k3", canonicalId: "kimi-k3", displayName: "Kimi K3", contextWindow: 1048576, maxOutputTokens: 131072, capabilities: ["text", "image"] },
      { id: "z-ai/glm-5.3", canonicalId: "glm-5.3", displayName: "GLM 5.3", contextWindow: 1000000, maxOutputTokens: 131072, capabilities: ["text"] },
    ],
  },
  {
    id: "huggingface",
    displayName: "Hugging Face",
    sourceId: "huggingface",
    sdk: "@ai-sdk/openai-compatible",
    baseUrl: "https://router.huggingface.co/v1",
    protocol: "openai_chat",
    authScheme: "bearer",
    models: [
      { id: "deepseek-ai/DeepSeek-V4-Pro", canonicalId: "deepseek-v4-pro", displayName: "DeepSeek V4 Pro", contextWindow: 1048576, maxOutputTokens: 393216, capabilities: ["text"], pricing: [0.003625, 0.435, 0.87] },
      { id: "moonshotai/Kimi-K3", canonicalId: "kimi-k3", displayName: "Kimi K3", contextWindow: 1000000, maxOutputTokens: 131072, capabilities: ["text", "image"] },
      { id: "zai-org/GLM-5.3", canonicalId: "glm-5.3", displayName: "GLM 5.3", contextWindow: 1048576, maxOutputTokens: 131072, capabilities: ["text"] },
      // HF Inference Providers table https://huggingface.co/inference/models?model=Qwen%2FQwen3.8-2.4T-A95B checked 2026-10-19; no cached column, so cached falls back to the input rate.
      { id: "Qwen/Qwen3.8-2.4T-A95B", canonicalId: "qwen3.8-2.4t-a95b", displayName: "Qwen3.8 2.4T A95B", contextWindow: 262144, maxOutputTokens: 131072, capabilities: ["text"], pricing: [2, 2, 6] },
      { id: "openai/gpt-oss-120b", canonicalId: "gpt-oss-120b", displayName: "GPT OSS 120B", contextWindow: 131072, maxOutputTokens: 32768, capabilities: ["text"] },
    ],
  },
  {
    id: "nebius",
    displayName: "Nebius Token Factory",
    sourceId: "nebius",
    sdk: "@ai-sdk/openai-compatible",
    baseUrl: "https://api.tokenfactory.nebius.com/v1",
    protocol: "openai_chat",
    authScheme: "bearer",
    models: [
      { id: "deepseek-ai/DeepSeek-V4-Pro", canonicalId: "deepseek-v4-pro", displayName: "DeepSeek V4 Pro", contextWindow: 1048576, maxOutputTokens: 1048576, capabilities: ["text"], pricing: [0.15, 1.75, 3.5] },
      { id: "moonshotai/Kimi-K3", canonicalId: "kimi-k3", displayName: "Kimi K3", contextWindow: 1048576, maxOutputTokens: 8000, capabilities: ["text"], pricing: [3, 3, 15] },
      { id: "zai-org/GLM-5.3", canonicalId: "glm-5.3", displayName: "GLM 5.3", contextWindow: 1024000, maxOutputTokens: 1024000, capabilities: ["text"], pricing: [1.4, 1.4, 4.4] },
      { id: "nvidia/Nemotron-3-Ultra-550b-a55b", canonicalId: "nemotron-3-ultra", displayName: "Nemotron 3 Ultra", contextWindow: 1048576, maxOutputTokens: 1048576, capabilities: ["text"], pricing: [1, 1, 3] },
      { id: "Qwen/Qwen3.8-27B", canonicalId: "qwen3.8-27b", displayName: "Qwen3.8 27B", contextWindow: 262144, maxOutputTokens: 262144, capabilities: ["text"], pricing: [0.45, 0.45, 3] },
    ],
  },
  {
    id: "vercel",
    displayName: "Vercel AI Gateway",
    sourceId: "vercel",
    sdk: "@ai-sdk/gateway",
    baseUrl: "https://ai-gateway.vercel.sh/v1",
    protocol: "openai_chat",
    authScheme: "bearer",
    models: [
      { id: "openai/gpt-5.6-sol", canonicalId: "gpt-5.6-sol", displayName: "GPT 5.6 Sol", contextWindow: 1050000, maxOutputTokens: 128000, capabilities: ["text", "image"] },
      { id: "anthropic/claude-opus-5", canonicalId: "claude-opus-5", displayName: "Claude Opus 5", contextWindow: 1000000, maxOutputTokens: 128000, capabilities: ["text", "image"], pricing: [0.5, 5, 25] },
      // https://vercel.com/ai-gateway/models/gemini-3.1-pro-preview checked 2026-10-19; base <=200k tier.
      { id: "google/gemini-3.1-pro-preview", canonicalId: "gemini-3.1-pro-preview", displayName: "Gemini 3.1 Pro Preview", contextWindow: 1000000, maxOutputTokens: 64000, capabilities: ["text", "image"], pricing: [0.2, 2, 12] },
      { id: "moonshotai/kimi-k3", canonicalId: "kimi-k3", displayName: "Kimi K3", contextWindow: 1000000, maxOutputTokens: 131072, capabilities: ["text", "image"], pricing: [0.3, 3, 15] },
      { id: "deepseek/deepseek-v4-pro", canonicalId: "deepseek-v4-pro", displayName: "DeepSeek V4 Pro", contextWindow: 1000000, maxOutputTokens: 384000, capabilities: ["text"], pricing: [0.022, 0.66, 1.98] },
    ],
  },
  {
    id: "sambanova",
    displayName: "SambaNova",
    sourceId: "sambanova",
    sdk: "@ai-sdk/openai-compatible",
    baseUrl: "https://api.sambanova.ai/v1",
    protocol: "openai_chat",
    authScheme: "bearer",
    models: [
      // https://cloud.sambanova.ai/plans/pricing checked 2026-10-19; cached published as N/A, so it falls back to the input rate.
      { id: "DeepSeek-V3.2", canonicalId: "deepseek-v3.2", displayName: "DeepSeek V3.2", contextWindow: 32768, maxOutputTokens: 7168, capabilities: ["text"], pricing: [3, 3, 4.5] },
      { id: "MiniMax-M3", canonicalId: "minimax-m3", displayName: "MiniMax M3", contextWindow: 1048576, maxOutputTokens: 1048576, capabilities: ["text"], pricing: [0.06, 0.6, 2.4] },
      // https://cloud.sambanova.ai/plans/pricing checked 2026-10-19; cached published as N/A, so it falls back to the input rate.
      { id: "gpt-oss-120b", canonicalId: "gpt-oss-120b", displayName: "GPT OSS 120B", contextWindow: 131072, maxOutputTokens: 131072, capabilities: ["text"], pricing: [0.22, 0.22, 0.59] },
      { id: "gemma-4-31B-it", canonicalId: "gemma-4-31b-it", displayName: "Gemma 4 31B", contextWindow: 131072, maxOutputTokens: 131072, capabilities: ["text", "image"] },
      // https://cloud.sambanova.ai/plans/pricing checked 2026-10-19; cached published as N/A, so it falls back to the input rate.
      { id: "Meta-Llama-3.3-70B-Instruct", canonicalId: "llama-3.3-70b", displayName: "Llama 3.3 70B", contextWindow: 131072, maxOutputTokens: 3072, capabilities: ["text"], pricing: [0.6, 0.6, 1.2] },
    ],
  },
  {
    id: "xai",
    displayName: "xAI",
    sourceId: "xai",
    sdk: "@ai-sdk/xai",
    baseUrl: "https://api.x.ai/v1",
    protocol: "openai_responses",
    authScheme: "bearer",
    // The source `xai` row lists 13 models; only the current flagship is kept.
    // Its cost tiers double input/output/cache_read above 200000 tokens, so no
    // flat tuple is published for this row. It is one of four TIERED retained
    // rows (see the module header); unlike this one, the other three keyed flat
    // tuples in an earlier revision and had them removed.
    models: [
      { id: "grok-4.7", canonicalId: "grok-4.7", displayName: "Grok 4.7", contextWindow: 500000, maxOutputTokens: 500000 },
    ],
  },
];
