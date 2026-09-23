import type { ClientDefinition, ModelDefinition, ProviderDefinition, ThinkingLevel } from '../base/index.ts';
import { resolveProviderModel, type CanonicalModelOverrides } from '../base/model-defaults.ts';
import { MAINSTREAM_MODEL_IDS, isMainstreamModelId, models } from '@wrenyard/models';
import {
  codeBuddyCanonicalModelId,
  codeBuddyHasLongContextVariant,
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
 * Normalized spelling of every mainstream canonical id. A product id matches a
 * canonical model through numeric-separator equivalence alone (`claude-opus-5.5`
 * equals `claude-opus-5-5`), while the canonical spelling is what comes back, so
 * dotted `gpt-5.6` and `deepseek-v4.1` canonical ids stay intact.
 */
const MAINSTREAM_BY_NORMALIZED_ID: ReadonlyMap<string, string> = new Map(
  MAINSTREAM_MODEL_IDS.map((id): [string, string] => [normalizeNumericSeparators(id), id]),
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

const effortLadder = (levels: readonly ThinkingLevel[]): Readonly<Record<string, { effort: string }>> =>
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
 * result is always an existing mainstream registry model. Product ids are
 * canonicalized by stripping the `-ioa` and `-1m` wire suffixes (in either
 * order) before the numeric-separator comparison.
 */
function lookupUnifiedModelId(productId: string): string | undefined {
  if (isMainstreamModelId(productId)) return productId;
  const stripped = codeBuddyCanonicalModelId(productId);
  const aliased = CODEBUDDY_PRODUCT_MODEL_IDS[productId] ?? CODEBUDDY_PRODUCT_MODEL_IDS[stripped];
  if (aliased !== undefined && isMainstreamModelId(aliased)) return aliased;
  if (isMainstreamModelId(stripped)) return stripped;
  return MAINSTREAM_BY_NORMALIZED_ID.get(normalizeNumericSeparators(stripped));
}

/** Map a product-file id onto a mainstream unified model, or ignore it. */
export function resolveCodeBuddyProductModelId(productId: string): string | undefined {
  const modelId = lookupUnifiedModelId(productId);
  if (!modelId || !isMainstreamModelId(modelId)) return undefined;
  return modelId;
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
  canonicalContextWindow: number | undefined,
): CanonicalModelOverrides {
  const overrides: CanonicalModelOverrides = {};
  if (entry.maxOutputTokens) overrides.maxOutputTokens = entry.maxOutputTokens;
  if (entry.supportsImages === true) overrides.capabilities = ['text', 'image'];
  if (canonicalContextWindow !== undefined && canonicalContextWindow >= ONE_MILLION_TOKENS) overrides.supports1MContext = true;
  return overrides;
}

/**
 * Historical upstream spellings canonicalize onto the offering they name, so
 * model-only statistics keep attributing an observed id after the product file
 * has moved on to a new wire id. Only a spelling whose target offering is
 * actually offered becomes an alias, so a retired identity is never resurrected
 * by the alias map alone.
 */
function historicalAliasesFor(offerings: readonly ModelDefinition[]): Record<string, string> {
  const offeringIds = new Set(offerings.map((entry) => entry.id));
  const aliases: Record<string, string> = {};
  for (const [observed, canonicalId] of Object.entries({ ...CODEBUDDY_PRODUCT_MODEL_IDS, ...CODEBUDDY_HISTORICAL_ALIASES })) {
    if (observed === canonicalId) continue;
    if (!offeringIds.has(canonicalId) || offeringIds.has(observed)) continue;
    aliases[observed] = canonicalId;
  }
  return aliases;
}

function thinkingMappingsFor(offerings: readonly ModelDefinition[]): NonNullable<ProviderDefinition['thinkingMappings']> {
  const mappings: Record<string, { codebuddy: ReturnType<typeof effortLadder> }> = {};
  for (const entry of offerings) {
    if (!entry.thinkingLevels?.length) continue;
    mappings[entry.id] = { codebuddy: effortLadder(entry.thinkingLevels) };
  }
  return mappings;
}

/**
 * Every discovered wire spelling of an offered canonical model becomes an
 * inbound alias, including the variants the selected product row did not supply
 * (the selected wire id stays the outbound spelling in `upstreamByCanonical`).
 */
function discoveredAliasesFor(
  variantsByCanonical: ReadonlyMap<string, ReadonlySet<string>>,
  offeringIds: ReadonlySet<string>,
): Record<string, string> {
  const aliases: Record<string, string> = {};
  for (const [canonicalId, variants] of variantsByCanonical) {
    if (!offeringIds.has(canonicalId)) continue;
    for (const observed of variants) {
      if (observed === canonicalId || offeringIds.has(observed)) continue;
      aliases[observed] = canonicalId;
    }
  }
  return aliases;
}

function buildCodeBuddyOfferings(productEntries: readonly CodeBuddyProductModelEntry[]): {
  models: ModelDefinition[];
  upstreamByCanonical: Record<string, string>;
  variantsByCanonical: ReadonlyMap<string, ReadonlySet<string>>;
} {
  // Membership is product-driven: an entry exists only when a product-file row
  // resolves onto the unified registry. When a canonical model is named by both
  // an ordinary row and an explicit long-context (`-1m`) variant, the actually
  // discovered variant supplies the outbound wire spelling and the ordinary row
  // is the fallback; every discovered variant is kept as an inbound alias.
  const selectedEntries = new Map<string, CodeBuddyProductModelEntry>();
  const variantsByCanonical = new Map<string, Set<string>>();
  for (const entry of productEntries) {
    const modelId = resolveCodeBuddyProductModelId(entry.id);
    if (!modelId) continue;
    const variants = variantsByCanonical.get(modelId) ?? new Set<string>();
    variants.add(entry.id);
    variantsByCanonical.set(modelId, variants);
    const current = selectedEntries.get(modelId);
    if (current === undefined || (codeBuddyHasLongContextVariant(entry.id) && !codeBuddyHasLongContextVariant(current.id))) {
      selectedEntries.set(modelId, entry);
    }
  }

  const byOfferingId = new Map<string, ModelDefinition>();
  // Outbound wire ids come from the selected product entries alone — a mapping
  // exists exactly when the current product file names the row, including rows
  // whose id already is the offering id. Nothing is seeded, so no channel
  // spelling survives the product that declared it and no environment can be
  // routed to another environment's spelling.
  const upstreamByCanonical: Record<string, string> = {};
  for (const [modelId, entry] of selectedEntries) {
    const overrides: CanonicalModelOverrides = {
      ...productMetadataOverrides(entry, models.get(modelId)?.defaults.contextWindow),
      ...claudeMetadataOverrides(modelId),
    };
    const resolved = resolveProviderModel({ canonical: modelId, overrides });
    byOfferingId.set(
      modelId,
      productCreditsAreFree(entry.credits) ? { ...resolved, free: true } : resolved,
    );
    // The product-file id is the wire spelling — including the identity rows,
    // where the offering is already spelled the way the product names it.
    upstreamByCanonical[modelId] = entry.id;
  }

  return { models: [...byOfferingId.values()], upstreamByCanonical, variantsByCanonical };
}

export function createCodeBuddyModels(entries: readonly CodeBuddyProductModelEntry[]) {
  const built = buildCodeBuddyOfferings(entries);
  const upstreamModels: Readonly<Record<string, string>> = Object.freeze(built.upstreamByCanonical);
  const offeringIds: ReadonlySet<string> = new Set(built.models.map((entry) => entry.id));
  const definition: Omit<ProviderDefinition, 'models'> & { models: readonly ModelDefinition[] } = {
    id: 'codebuddy',
    displayName: 'CodeBuddy',
    description: 'CodeBuddy 提供的 DeepSeek、混元与 Kimi 模型。',
    setupHint: '请在 CodeBuddy 客户端完成登录，返回啾啾工坊后刷新状态。',
    credentialResolver: 'codebuddy',
    nativeClients: ['codebuddy'],
    defaultModel: 'hunyuan-hy4-preview',
    useClientBinary: true,
    models: built.models,
    // Aliases only target currently offered models, including when the product
    // snapshot is absent. Outbound wire ids come from the selected product.
    modelAliases: {
      ...historicalAliasesFor(built.models),
      ...discoveredAliasesFor(built.variantsByCanonical, offeringIds),
    },
    thinkingMappings: thinkingMappingsFor(built.models),
    protocols: [{ protocol: 'openai_chat', endpoint: 'https://copilot.tencent.com/v2/chat/completions', authScheme: 'bearer' }],
  };

  return { definition, upstreamModels };
}

export type CodeBuddyModels = ReturnType<typeof createCodeBuddyModels>;
