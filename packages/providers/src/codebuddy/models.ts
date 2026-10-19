import { codeBuddyRouteFailure } from './route-errors.ts';
import type { ClientDefinition, ModelDefinition, ProviderDefinition, ReasoningEffort } from '../base/index.ts';
import { resolveProviderModel, REASONING_LOW_HIGH_MAX, type CanonicalModelOverrides } from '../base/model-defaults.ts';
import { models, isMainstreamModelId } from '@wrenyard/models';
import {
  codeBuddyCanonicalModelId,
  productCreditsAreFree,
  type CodeBuddyProductModelEntry,
} from './product.ts';

/**
 * Product-file ids whose WY identity is a genuine rename rather than a
 * wire-suffix or numeric-separator variant of a registered id. Direct registry
 * lookup remains the membership test; similar names are never inferred.
 */
const CODEBUDDY_PRODUCT_MODEL_IDS: Readonly<Record<string, string>> = {
  'hy3': 'hunyuan-hy3',
  'hy3-ioa': 'hunyuan-hy3',
  'hy4-preview': 'hunyuan-hy4-preview',
  'hy4-preview-ioa': 'hunyuan-hy4-preview',
  'MiniMax-M3': 'minimax-m3',
  'MiniMax-M3.1-Flash-Preview': 'minimax-m3.1-flash-preview',
  'MiniMax-M2.7': 'minimax-m2.7',
  // DeepSeek V4 ships as `deepseek-v4-<tier>` in the plain/internal product
  // files and as `deepseek-v4-<tier>-ioa` in the iOA one; both channel forms
  // collapse onto the two unified registry identities.
  'deepseek-v4-flash': 'deepseek-v4.1-flash',
  'deepseek-v4-flash-ioa': 'deepseek-v4.1-flash',
  'deepseek-v4-pro-ioa': 'deepseek-v4-pro',
};

const ONE_MILLION_TOKENS = 1_000_000;
const CLAUDE_TIERS = ['haiku', 'sonnet', 'opus'] as const;

/**
 * Retired Claude gen-5 identities are withheld from selectable offerings. Their
 * observed spellings keep resolving to the exact identity and are never
 * aliased forward onto the 5.5 generation.
 */
const RETIRED_CLAUDE_FIVE_MODEL_IDS: ReadonlySet<string> = new Set(['claude-opus-5', 'claude-sonnet-5']);

/**
 * Selectable CodeBuddy offerings must be mainstream; the retired Claude gen-5
 * identities are exempted from offering even though `claude-opus-5` remains in
 * the global mainstream list.
 */
function isSelectableCodeBuddyModelId(canonicalId: string): boolean {
  return isMainstreamModelId(canonicalId) && !RETIRED_CLAUDE_FIVE_MODEL_IDS.has(canonicalId);
}

/** Unify numeric version separators; only separators between digits are touched. */
const normalizeNumericSeparators = (id: string): string => id.replace(/(?<=\d)\.(?=\d)/gu, '-');

/**
 * Normalized spelling of every registered canonical id. A product id matches a
 * registered model through numeric-separator equivalence alone (`claude-opus-5.5`
 * equals `claude-opus-5-5`), while the registered spelling is what comes back, so
 * dotted registered ids stay intact.
 */
const REGISTERED_BY_NORMALIZED_ID: ReadonlyMap<string, string> = new Map(
  models.list().map((entry): [string, string] => [normalizeNumericSeparators(entry.id), entry.id]),
);

/**
 * Historical observed wire spellings that keep canonicalizing onto the offering
 * they name. Inbound only: an entry here is never an outbound wire id, so a
 * spelling retired by the selected product file can never be routed to again.
 * Everything sent upstream is defined by the current product entries alone
 * (see buildCodeBuddyOfferings).
 */
const CODEBUDDY_HISTORICAL_ALIASES: Readonly<Record<string, string>> = {
  'deepseek-v4.1-flash-ioa': 'deepseek-v4.1-flash',
  'deepseek-v4-pro-ioa': 'deepseek-v4-pro',
  'hy4-preview-ioa': 'hunyuan-hy4-preview',
  'hy3-ioa': 'hunyuan-hy3',
  'minimax-m3-ioa': 'minimax-m3',
};

/**
 * Listed CodeBuddy routes accept the disable switch, even where the upstream
 * still thinks. Other strengths retain their documented/probed ladders. Only a
 * row matching a registered model uses this map.
 */
const CODEBUDDY_REASONING_EFFORTS: Readonly<Record<string, readonly ReasoningEffort[]>> = {
  'claude-opus-5-5': ['none', ...REASONING_LOW_HIGH_MAX],
  'gpt-6-astra': ['none', ...REASONING_LOW_HIGH_MAX],
  'glm-5.3': ['none', ...REASONING_LOW_HIGH_MAX],
  'glm-5.3-flash': ['none', ...REASONING_LOW_HIGH_MAX],
  'kimi-k3': ['none', ...REASONING_LOW_HIGH_MAX],
  'deepseek-v4.1-flash': ['none', 'high'],
  'deepseek-v4-pro': ['none', 'high'],
  'hunyuan-hy3': ['none', 'high'],
  // Disabling thinking has no effect on HY4 here: it still reasons for most of
  // its output, so only the level it actually runs at is offered.
  'hunyuan-hy4-preview': ['high'],
};

const codeBuddyReasoningEfforts = (modelId: string): readonly ReasoningEffort[] =>
  CODEBUDDY_REASONING_EFFORTS[modelId] ?? ['high'];

const effortLadder = (levels: readonly ReasoningEffort[]): Readonly<Record<string, { effort: string }>> =>
  Object.fromEntries(levels.map((level) => [level, { effort: level }]));

export const codeBuddyClient: ClientDefinition = {
  id: 'codebuddy',
  nativeProvider: 'codebuddy',
  unsupportedGatewayProviders: ['opencode-go'],
  gatewayProtocols: ['openai_chat'],
  taskCapable: true,
};

/**
 * Exact canonical ids and genuine aliases precede normalized matching; the
 * result is always an existing registered model, so its registry metadata and
 * aliases stay intact. Resolution deliberately covers the whole registry, not
 * only the mainstream list, so an observed id keeps its own identity; the
 * mainstream gate is applied separately when the selectable offerings are
 * built. Product ids are canonicalized by stripping the `-ioa` and `-1m` wire
 * suffixes (in either order) before the numeric-separator comparison.
 */
function lookupUnifiedModelId(productId: string): string | undefined {
  if (models.get(productId)) return productId;
  const stripped = codeBuddyCanonicalModelId(productId);
  const aliased = CODEBUDDY_PRODUCT_MODEL_IDS[productId] ?? CODEBUDDY_PRODUCT_MODEL_IDS[stripped];
  if (aliased !== undefined && models.get(aliased)) return aliased;
  if (models.get(stripped)) return stripped;
  return REGISTERED_BY_NORMALIZED_ID.get(normalizeNumericSeparators(stripped));
}

/**
 * Map a product id onto the registered model it names, or return undefined for
 * an unknown registry identity. A `/v3/config` cli row that resolves adopts that
 * model's registered identity, so its registry metadata and aliases are
 * retained. Resolution is identity-only: parsing and identity resolution stay
 * untouched by selection policy. The mainstream plus retired-Claude gate is
 * applied separately when the selectable offerings are built.
 */
export function resolveCodeBuddyProductModelId(productId: string): string | undefined {
  return lookupUnifiedModelId(productId);
}

/**
 * Claude family metadata for a registered Claude model, derived from the
 * registry's own family plus the tier token in the id — never a per-version
 * map.
 */
function claudeMetadataOverrides(modelId: string): CanonicalModelOverrides {
  if (models.get(modelId)?.family !== 'claude') return {};
  const tier = CLAUDE_TIERS.find((candidate) => modelId.startsWith(`claude-${candidate}-`));
  return { family: 'claude', ...(tier === undefined ? {} : { claudeTier: tier }) };
}

/**
 * The product entry's own verified metadata, carried onto the adopted registry
 * model: the output window the client declares and the image input the row
 * declares. The context window is inherited from the canonical registry model,
 * and long-context support follows that canonical window — not the product row.
 */
function productMetadataOverrides(
  entry: CodeBuddyProductModelEntry,
  canonicalContextWindow: number,
): CanonicalModelOverrides {
  const overrides: CanonicalModelOverrides = {};
  if (entry.maxOutputTokens) overrides.maxOutputTokens = entry.maxOutputTokens;
  if (entry.supportsImages === true) overrides.capabilities = ['text', 'image'];
  if (canonicalContextWindow >= ONE_MILLION_TOKENS) overrides.supports1MContext = true;
  return overrides;
}

/**
 * Migration-only alias map for stored selections, default selections and
 * model-only statistics written against the previous public spellings. The
 * public offering is now the registered identity, so every offered id is
 * already canonical. An alias is emitted only when its key is not itself an
 * offered id (an offered id is never rewritten) and its target is an offered
 * id, so an unavailable identity is never resurrected. These aliases are not a
 * new public request surface for the bare-ID Gateway contract.
 */
function historicalAliasesFor(offerings: readonly ModelDefinition[]): Record<string, string> {
  const offeringIds = new Set(offerings.map((entry) => entry.id));
  const offeredByCanonical = new Map<string, string>();
  for (const entry of offerings) {
    const canonicalId = entry.canonicalModel?.id;
    if (canonicalId === undefined) continue;
    if (entry.id === canonicalId || !offeredByCanonical.has(canonicalId)) {
      offeredByCanonical.set(canonicalId, entry.id);
    }
  }
  const aliases: Record<string, string> = {};
  const addAlias = (key: string, canonicalId: string): void => {
    if (offeringIds.has(key)) return;
    const target = offeredByCanonical.get(canonicalId);
    if (target === undefined || target === key) return;
    aliases[key] = target;
  };
  // Product-file rewrites and historical wire spellings keep canonicalizing.
  for (const [observed, canonicalId] of Object.entries({ ...CODEBUDDY_PRODUCT_MODEL_IDS, ...CODEBUDDY_HISTORICAL_ALIASES })) {
    addAlias(observed, canonicalId);
  }
  return aliases;
}

function reasoningEffortMappingsFor(offerings: readonly ModelDefinition[]): NonNullable<ProviderDefinition['reasoningEffortMappings']> {
  const mappings: Record<string, { codebuddy: ReturnType<typeof effortLadder> }> = {};
  for (const entry of offerings) {
    // A route with no ladder — an endpoint row naming no registered model —
    // materializes no effort level; no ladder is inferred for it.
    const ladder = entry.reasoningEfforts;
    if (ladder.length === 0) continue;
    // Native settings serialize effort, not the Gateway's verified disable switch.
    const nativeEfforts = ladder.filter(effort => effort !== 'none');
    mappings[entry.id] = { codebuddy: effortLadder(nativeEfforts) };
  }
  return mappings;
}

function buildCodeBuddyOfferings(productEntries: readonly CodeBuddyProductModelEntry[]): {
  models: ModelDefinition[];
  upstreamByCanonical: Record<string, string>;
} {
  // Every actual `/v3/config` cli row whose id resolves onto a selectable
  // registered identity is an offering, in endpoint order. The mainstream plus
  // retired-Claude gate applies here, at offering-build time: rows whose
  // canonical id fails it are skipped, while parsing and identity resolution
  // stay untouched.
  //
  // An entry adopts the registered identity as its public id; its raw endpoint
  // id becomes the private `upstreamId` wire binding. Two distinct endpoint
  // rows that resolve onto the same registered identity cannot both be
  // published — there is no way to distinguish them without a synthetic
  // identity — so that identity is withheld rather than resolved by row order.
  const resolved: { canonicalId: string; entry: CodeBuddyProductModelEntry }[] = [];
  const counts = new Map<string, number>();
  const seen = new Set<string>();
  for (const entry of productEntries) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    const canonicalId = resolveCodeBuddyProductModelId(entry.id);
    if (canonicalId === undefined || models.get(canonicalId) === undefined || !isSelectableCodeBuddyModelId(canonicalId)) continue;
    resolved.push({ canonicalId, entry });
    counts.set(canonicalId, (counts.get(canonicalId) ?? 0) + 1);
  }
  const offerings: ModelDefinition[] = [];
  const upstreamByCanonical: Record<string, string> = {};
  for (const { canonicalId, entry } of resolved) {
    // An identity claimed by more than one endpoint row has no unambiguous
    // outbound wire id, so it is withheld as a whole.
    if (counts.get(canonicalId) !== 1) continue;
    const registered = models.get(canonicalId);
    if (registered === undefined) continue;
    const definition: ModelDefinition = {
      ...resolveProviderModel({
        canonical: canonicalId,
        overrides: {
          upstreamId: entry.id,
          ...productMetadataOverrides(entry, registered.defaults.contextWindow),
          ...claudeMetadataOverrides(canonicalId),
          reasoningEfforts: codeBuddyReasoningEfforts(canonicalId),
        },
      }),
    };
    // The endpoint's per-model credit multiplier is carried verbatim onto the
    // offering; a row that declares none omits the field entirely. It is a
    // display-only multiplier, never a balance or USD price.
    const offering: ModelDefinition = entry.credits === undefined
      ? definition
      : { ...definition, credits: entry.credits };
    offerings.push(productCreditsAreFree(entry.credits) ? { ...offering, free: true } : offering);
    upstreamByCanonical[canonicalId] = entry.id;
  }
  return { models: offerings, upstreamByCanonical };
}

export function createCodeBuddyModels(entries: readonly CodeBuddyProductModelEntry[]) {
  const built = buildCodeBuddyOfferings(entries);
  const upstreamModels: Readonly<Record<string, string>> = Object.freeze(built.upstreamByCanonical);
  // The declared ladder of each offering that has one, keyed by the offering's
  // own id. A route with no ladder has no level to materialize.
  const effortLadders: Readonly<Record<string, readonly ReasoningEffort[]>> = Object.fromEntries(
    built.models.flatMap((entry) => entry.reasoningEfforts.length === 0 ? [] : [[entry.id, entry.reasoningEfforts] as const]),
  );
  const definition: Omit<ProviderDefinition, 'models'> & { models: readonly ModelDefinition[] } = {
    id: 'codebuddy',
    displayName: 'CodeBuddy',
    description: 'CodeBuddy 提供的 DeepSeek、混元与 Kimi 模型。',
    setupHint: '请在 CodeBuddy 客户端完成登录，返回啾啾工坊后刷新状态。',
    credentialResolver: 'codebuddy',
    classifyUpstreamError: codeBuddyRouteFailure,
    nativeClients: ['codebuddy'],
    defaultModel: 'hunyuan-hy4-preview',
    useClientBinary: true,
    models: built.models,
    // Aliases only target currently offered models, and only where they do not
    // collide with an exact offered endpoint id. Outbound wire ids are the
    // endpoint row ids themselves.
    modelAliases: historicalAliasesFor(built.models),
    reasoningEffortMappings: reasoningEffortMappingsFor(built.models),
    protocols: [{
      protocol: 'openai_chat',
      endpoint: 'https://copilot.tencent.com/v2/chat/completions',
      authScheme: 'bearer',
      // Registered identity -> exact endpoint wire id. The mapping is derived
      // from the same private bindings the native and gateway transports use.
      upstreamModels,
    }],
    convertReasoningEffort: (modelId, effort, protocol) => {
      if (effort === 'none') {
        const ladder = effortLadders[modelId];
        if (ladder === undefined || !ladder.includes('none')) {
          throw new Error(`CodeBuddy model ${modelId} cannot disable thinking`);
        }
        return { thinking: { type: 'disabled' } };
      }
      if (protocol === 'openai_responses') return { reasoning: { effort } };
      if (protocol === 'anthropic_messages') return { output_config: { effort } };
      return { reasoning_effort: effort };
    },
  };


  return { definition, upstreamModels };
}

export type CodeBuddyModels = ReturnType<typeof createCodeBuddyModels>;
