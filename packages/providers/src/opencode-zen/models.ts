import {
  defineProvider,
  model,
  openAI,
  anthropic,
  resolveProviderModel,
  REASONING_LOW_HIGH_MAX,
} from '../base/model-defaults.ts';
import type { ProviderModel } from '../base/model-defaults.ts';
import type {
  ModelDefinition,
  ProviderReasoningEffortMappings,
  ProviderRequestHookContext,
  ReasoningEffort,
  UpstreamRouteErrorInput,
  UpstreamRouteFailure,
} from '../base/contracts.ts';

/**
 * The OpenCode service requires the stable OpenCode User-Agent and forwards the
 * client's session header. Only a well-formed single-line token is forwarded,
 * so it cannot smuggle extra header lines into the upstream request.
 */
function forwardOpenCodeSession(context: ProviderRequestHookContext): void {
  context.headers.set('user-agent', 'wrenyard');
  const value = context.requestHeaders['x-opencode-session'];
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) return;
  if (value.includes('\r') || value.includes('\n')) return;
  context.headers.set('x-opencode-session', value);
}

/** One free Zen offering: its live limits and its route-owned effort ladder.
 * An absent ladder means the route only exposes the provider default. */
interface FreeSeed {
  readonly id: string;
  /** Registered canonical identity that supplies display metadata. */
  readonly canonical: string;
  readonly context: number;
  readonly output: number;
  readonly efforts?: readonly ReasoningEffort[];
}

/**
 * Seeds for the live free set. These are only a fallback for a daemon that
 * cannot reach the public catalog: the live reader replaces them as soon as a
 * refresh succeeds. The live catalog decides free status and availability for
 * registered models only; unregistered upstream rows are retained for
 * diagnostics and are never callable, and registration is owned by the unified
 * registry. Limits and ladders were checked against the live catalog.
 */
const FREE_SEEDS: readonly FreeSeed[] = [
  { id: 'deepseek-v4.1-flash-free', canonical: 'deepseek-v4.1-flash-free', context: 200_000, output: 32_000, efforts: ['low', 'high', 'max'] },
  { id: 'big-pickle', canonical: 'big-pickle', context: 200_000, output: 32_000 },
];

/**
 * Zen free rows are usable only through the genuine OpenCode client transport,
 * so they never appear in the client-agnostic gateway directory. A ladder-less
 * route is materialized as the provider-default sentinel, which keeps the
 * request field off the wire instead of inventing an effort.
 */
function freeRow(seed: FreeSeed): ModelDefinition {
  return {
    ...resolveProviderModel(model(seed.id, seed.context, seed.output, seed.canonical)),
    free: true,
    supportedClients: ['opencode'],
    reasoningEfforts: seed.efforts ?? ['default'],
  };
}

/** Explicit per-level effort mappings for a ladder, or a model-only default. */
function freeMapping(efforts: readonly ReasoningEffort[] | undefined, id: string) {
  return efforts && efforts.length > 0
    ? { opencode: Object.fromEntries(efforts.map((level) => [level, { effort: level }])) }
    : { opencode: { default: { model: id } } };
}

const FREE_MAPPINGS: ProviderReasoningEffortMappings = Object.fromEntries(
  FREE_SEEDS.map((seed) => [seed.id, freeMapping(seed.efforts, seed.id)]),
);

const PAID_DECLARATIONS = [
  // Paid Zen pool, priced by the registered catalog metadata.
  model('glm-5.3', 1_048_576, 32_768, 'glm-5.3', REASONING_LOW_HIGH_MAX),
  model('kimi-k3', 1_048_576, 32_768, 'kimi-k3', REASONING_LOW_HIGH_MAX),
  // Zen serves Sol through Responses. The native OpenCode client owns that
  // transport; the existing Chat Completions gateway cannot serve this model.
  { canonical: 'gpt-6.1-sol', overrides: { supportedClients: ['opencode'], reasoningEfforts: ['high'] } },
  // The official Zen Argon endpoint uses @ai-sdk/google, so this model is
  // reachable only through the native OpenCode client and is never published
  // through the OpenAI or Anthropic gateway.
  { canonical: 'gemini-4-argon', overrides: { supportedClients: ['opencode'], reasoningEfforts: ['low', 'medium', 'high'] } },
] satisfies readonly ProviderModel[];

/**
 * The names a free-profile rejection can take upstream. The free tier is
 * available only from within the OpenCode client, and a promotion that ends
 * returns the same family of codes, so both identities are read together.
 */
function upstreamErrorParts(body: unknown): { identity: string; message: string } {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return { identity: '', message: '' };
  const root = body as Record<string, unknown>;
  const error = root.error !== null && typeof root.error === 'object' && !Array.isArray(root.error)
    ? root.error as Record<string, unknown>
    : root;
  const text = (value: unknown): string => typeof value === 'string' ? value : '';
  return {
    identity: `${text(error.type)} ${text(error.code)}`,
    message: `${text(error.message)} ${text(root.message)}`.trim(),
  };
}

export const definition = defineProvider({
  id: 'opencode-zen', displayName: 'OpenCode Zen', credentialResolver: 'managed',
  nativeClients: ['opencode'], defaultModel: 'kimi-k3',
  // Supplier hook: the OpenCode identity and session-header forwarding.
  beforeRequest: forwardOpenCodeSession,
  models: [...FREE_SEEDS.map(freeRow), ...PAID_DECLARATIONS],
  // Real measured evidence for the exact free route, threaded through the shared
  // explicit-free gate: the canonical default speed is 95 too, and this
  // provider-scoped override states the same floored value as a routing fact.
  modelSpeedOverrides: {
    // measured 95.58 TPS (median of 3 sequential samples), 2026-10-15, floored to 95
    'deepseek-v4.1-flash-free': 95,
  },
  // Provenance of the override above: initial measured TPS and when/how it was
  // measured. Never replaces the integer override.
  modelSpeedMeasurements: {
    'deepseek-v4.1-flash-free': {
      initialTps: 95.58,
      // Minute precision: the measurement window was
      // 2026-10-15 17:00–17:02 UTC, not a second-exact
      // instant, so the end time is spelled to the minute.
      measuredAt: '2026-10-15T17:02:00Z',
      method: 'native OpenCode client 1.19.0, 3 sequential samples, median estimate from output tokens over part timestamp windows (not token-level instrumentation)',
    },
  },
  reasoningEffortMappings: {
    ...FREE_MAPPINGS,
    ...Object.fromEntries(PAID_DECLARATIONS.flatMap((declaration) => {
      const id = typeof declaration === 'string'
        ? declaration
        : 'canonical' in declaration ? declaration.canonical : declaration.id;
      const levels = typeof declaration === 'string'
        ? undefined
        : 'canonical' in declaration ? declaration.overrides?.reasoningEfforts : declaration.reasoningEfforts;
      return levels === undefined ? [] : [[id, { opencode: Object.fromEntries(levels.map((level) => [level, { effort: level }])) }]];
    })),
  },
  /**
   * A free-tier 403 denies access to the whole free pool the caller was using,
   * so it narrows to that pool: every free Zen route cools down while the paid
   * balance pool and the provider stay usable. It is an access denial, not an
   * authentication failure. A model that disappeared from the live catalog
   * stays a fault of this exact route.
   */
  classifyUpstreamError({ status, body }: UpstreamRouteErrorInput): UpstreamRouteFailure | undefined {
    const { identity, message } = upstreamErrorParts(body);
    if (status === 403 && (/\bFreeTierError\b/i.test(identity) || /free[_ ]?tier|free promotion/i.test(message))) {
      return { state: 'access_denied', scope: 'pool', quotaPoolId: 'opencode-zen/free' };
    }
    const modelGone = /model not found|unknown model|(?:do(?:es)? not|don't) have access to (?:the )?model/i.test(message);
    if (modelGone || (status === 404 && /not found|unknown model|access to the model/i.test(message))) {
      return { state: 'model_unavailable', scope: 'route' };
    }
    return undefined;
  },
  protocols: [
    openAI('https://opencode.ai/zen/v1/chat/completions'),
    anthropic('https://opencode.ai/zen/v1/messages'),
  ],
  convertReasoningEffort: (_modelId, effort, protocol) => {
      if (protocol === 'openai_responses') return { reasoning: { effort } };
      if (protocol === 'anthropic_messages') return { output_config: { effort } };
      return { reasoning_effort: effort };
    },
  description: 'OpenCode Zen 免费与付费模型。',
  setupHint: '免费模型走原生 OpenCode 客户端，无需 API Key；其中 DeepSeek 免费路由适用零数据保留、不用于训练的条款，其余免费模型的数据使用条款以各自上游为准。付费 OpenCode Zen 模型需要 OpenCode Zen 托管凭据（API Key）。免费额度有限且未公开。',
});

/** Paid rows only; the live adapter republishes them next to the live free set. */
export const paidModels: readonly ModelDefinition[] =
  definition.models.filter((entry) => entry.free !== true);

/** Paid effort mappings only, so live publication never drops them. */
export const paidReasoningEffortMappings: ProviderReasoningEffortMappings = Object.fromEntries(
  Object.entries(definition.reasoningEffortMappings ?? {})
    .filter(([id]) => paidModels.some((entry) => entry.id === id)),
);
