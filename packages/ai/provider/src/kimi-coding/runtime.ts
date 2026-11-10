/**
 * Kimi Coding canonical-to-wire model ids. The official Kimi Coding route
 * only recognizes the wire id `kimi-for-coding`, so the canonical identity
 * `kimi-k2.8` must be translated before dispatch. Unlike CodeBuddy this is a
 * static, credential-independent translation: the same wire id is correct for
 * every Kimi credential, so no environment classification is involved.
 */
const KIMI_CODING_UPSTREAM_MODELS: Readonly<Record<string, string>> = {
  'kimi-k2.8': 'kimi-for-coding',
};

export function kimiCodingUpstreamWireModel(model: string): string {
  return KIMI_CODING_UPSTREAM_MODELS[model] ?? model;
}

