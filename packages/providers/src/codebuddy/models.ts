import { codeBuddyRouteFailure } from './route-errors.ts';
import type { ClientDefinition, ModelDefinition, ProviderDefinition, ReasoningEffort } from '../base/index.ts';
import { resolveProviderModel, REASONING_LOW_HIGH_MAX, type CanonicalModelOverrides } from '../base/model-defaults.ts';
import { models } from '@wrenyard/models';
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
 * row matching a registered model uses this map; an unregistered endpoint row
 * declares no ladder at all.
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
  'hunyuan-hy4-preview': ['none', 'high'],
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
 * aliases stay intact. Membership is therefore the full registry, not only the
 * mainstream list: a model the endpoint offers may be registered without being
 * mainstream. Product ids are canonicalized by stripping the `-ioa` and `-1m`
 * wire suffixes (in either order) before the numeric-separator comparison.
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
 * Map a product id onto the registered model it names, or ignore it. A
 * `/v3/config` cli row that resolves adopts that model's registered identity,
 * so its registry metadata and aliases are retained; a row that names no
 * registered model is not offered.
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
 * Canonical registry ids and historical upstream spellings resolve onto the
 * endpoint row that publishes the model they name, so a stored default selection
 * (the registered `defaultModel`) and model-only statistics keep resolving after
 * the public offering id became the endpoint's raw id. The target of a canonical
 * identity is deterministic: the exact offered canonical row when one exists,
 * otherwise the first endpoint row in endpoint order. An alias is emitted only
 * when its key is not itself an offered id (an offered endpoint id is never
 * rewritten) and its target is an offered id (an alias never points at a model
 * the account does not offer), so a retired identity is never resurrected.
 */
function historicalAliasesFor(offerings: readonly ModelDefinition[]): Record<string, string> {
  const offeringIds = new Set(offerings.map((entry) => entry.id));
  // Canonical registry identity -> the offered endpoint row that publishes it.
  const offeredByCanonical = new Map<string, string>();
  for (const entry of offerings) {
    const canonicalId = entry.canonicalModel?.id;
    if (canonicalId === undefined) continue;
    // An exact offered canonical row wins; otherwise the first row in endpoint
    // order keeps the mapping.
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
  // The registered canonical id itself resolves onto its offered endpoint row.
  for (const canonicalId of offeredByCanonical.keys()) addAlias(canonicalId, canonicalId);
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
  // Membership is endpoint-driven: exactly one offering per `/v3/config` cli
  // row, in the endpoint's own order. The row supplies the public id and display
  // name; a row that names a registered model additionally adopts that model's
  // canonical identity and complete registry metadata, still published under the
  // endpoint's own name. A row that names no registered model is offered too,
  // carrying only what the endpoint declares — its intelligence, price, speed
  // and reasoning ladder stay unknown rather than being invented. No row is
  // dropped and no rows are merged.
  const offerings: ModelDefinition[] = [];
  const upstreamByCanonical: Record<string, string> = {};
  const seen = new Set<string>();
  for (const entry of productEntries) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    const canonicalId = resolveCodeBuddyProductModelId(entry.id);
    const registered = canonicalId === undefined ? undefined : models.get(canonicalId);
    const displayName = entry.name ?? registered?.displayName ?? entry.id;
    let definition: ModelDefinition;
    if (canonicalId !== undefined && registered !== undefined) {
      definition = {
        ...resolveProviderModel({
          canonical: canonicalId,
          overrides: {
            ...productMetadataOverrides(entry, registered.defaults.contextWindow),
            ...claudeMetadataOverrides(canonicalId),
            reasoningEfforts: codeBuddyReasoningEfforts(canonicalId),
          },
        }),
        // The displayed identity is the endpoint's own id and name; the
        // registered identity stays available as `canonicalModel`.
        id: entry.id,
        displayName,
      };
    } else {
      definition = resolveProviderModel({
        id: entry.id,
        displayName,
        ...(entry.maxOutputTokens === undefined ? {} : { maxOutputTokens: entry.maxOutputTokens }),
        ...(entry.supportsImages === true ? { capabilities: ['text', 'image'] } : {}),
      });
    }
    // The endpoint's per-model credit multiplier is carried verbatim onto the
    // offering; a row that declares none (e.g. echo) omits the field entirely.
    // It is a display-only multiplier, never a balance or USD price.
    const offering: ModelDefinition = entry.credits === undefined
      ? definition
      : { ...definition, credits: entry.credits };
    offerings.push(productCreditsAreFree(entry.credits) ? { ...offering, free: true } : offering);
    // The endpoint row's id is the outbound wire spelling, so wire dispatch stays
    // exact even when the public offering adopts a registered identity.
    upstreamByCanonical[entry.id] = entry.id;
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
    protocols: [{ protocol: 'openai_chat', endpoint: 'https://copilot.tencent.com/v2/chat/completions', authScheme: 'bearer' }],
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
