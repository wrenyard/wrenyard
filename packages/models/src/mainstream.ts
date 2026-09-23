/**
 * Canonical model ids currently open for product use.
 * Older and niche registered identities stay in the model registry; providers
 * may adopt this list, then overlay channel-specific offerings.
 */
export const MAINSTREAM_MODEL_IDS = [
  'deepseek-v4.1-flash',
  'deepseek-v4-pro',
  'hunyuan-hy4-preview',
  'hunyuan-hy3',
  'kimi-k3',
  'kimi-k2.8',
  'gpt-6-astra',
  'gpt-6-sol',
  'gpt-6-luna',
  'gpt-5.6-sol',
  'gpt-5.6-luna',
  'glm-5.3',
  'glm-5.3-flash',
  'minimax-m3',
  'claude-fable-5-1',
  'claude-opus-5',
  'claude-opus-5-5',
  'claude-sonnet-5',
  'claude-haiku-4-5',
  'grok-4.7',
  'grok-4.6',
  'composer-2.5',
  'muse-spark-1.3',
  'gemini-3.8-flash',
  'doubao-seed-2-0-lite',
  'qwen3.8-max',
  'mimo-v2.6-pro',
  'mimo-v2.6-flash',
  'mimo-v2.6-pro-ultraspeed',
] as const;

export type MainstreamModelId = (typeof MAINSTREAM_MODEL_IDS)[number];

const MAINSTREAM_MODEL_ID_SET: ReadonlySet<string> = new Set(MAINSTREAM_MODEL_IDS);

export function isMainstreamModelId(id: string): boolean {
  return MAINSTREAM_MODEL_ID_SET.has(id);
}
