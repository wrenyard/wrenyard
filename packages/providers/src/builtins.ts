import * as claudeCoding from './claude-coding/index.ts';
import * as anthropic from './anthropic/index.ts';
import * as chatgpt from './chatgpt/index.ts';
import * as cursor from './cursor/index.ts';
import * as kimiCoding from './kimi-coding/index.ts';
import * as minimax from './minimax/index.ts';
import * as minimaxCoding from './minimax-coding/index.ts';
import * as moonshot from './moonshot/index.ts';
import * as openai from './openai/index.ts';
import * as deepseek from './deepseek/index.ts';
import * as qwen from './qwen/index.ts';
import * as qwenCoding from './qwen-coding/index.ts';
import * as spacexAi from './spacex-ai/index.ts';
import * as superGrok from './super-grok/index.ts';
import * as tokenhub from './tokenhub/index.ts';
import * as volcengine from './volcengine/index.ts';
import * as zhipu from './zhipu/index.ts';
import * as zhipuCoding from './zhipu-coding/index.ts';
import * as openrouter from './openrouter/index.ts';
import * as opencodeGo from './opencode-go/index.ts';
import type { Provider, ProviderDefinition } from './base/index.ts';
import type { ProviderQuota } from './base/provider-quota.ts';
import { createCodeBuddy } from './codebuddy/index.ts';
import { createDevin } from './devin/index.ts';
import { createOpenCodeZen } from './opencode-zen/provider.ts';
import { modelsDevProviders } from './models-dev.ts';

// The composition root owns default discovery. Leaf modules perform no I/O on import.
export const codeBuddy = createCodeBuddy();
export const devinProvider = createDevin();
export const opencodeZenProvider = createOpenCodeZen();
export const providerImplementations: ReadonlyMap<string, Provider> = new Map<string, Provider>([
  [codeBuddy.id, codeBuddy],
  [devinProvider.id, devinProvider],
  [opencodeZenProvider.id, opencodeZenProvider],
]);

/** A builtin module owns its provider definition and, when one exists, its quota source. */
type BuiltinModule = { readonly definition: ProviderDefinition; readonly quota?: ProviderQuota };

const builtins: readonly BuiltinModule[] = [
  claudeCoding,
  anthropic,
  codeBuddy,
  chatgpt,
  cursor,
  kimiCoding,
  minimax,
  minimaxCoding,
  moonshot,
  openai,
  deepseek,
  qwen,
  qwenCoding,
  spacexAi,
  superGrok,
  tokenhub,
  volcengine,
  zhipu,
  zhipuCoding,
  opencodeZenProvider,
  openrouter,
  opencodeGo,
  devinProvider,
  // Generic models.dev-derived mainstream providers: the 15 curated rows in
  // models-dev-catalog.generated.ts, managed-API-key definitions only, no
  // quota source. Appended so the existing declarations stay untouched.
  ...modelsDevProviders.map((definition) => ({ definition })),
];

export const builtinDefinitions = builtins.map((provider) => provider.definition);

export const providerQuotas: ReadonlyMap<string, ProviderQuota> = new Map(
  builtins.flatMap((provider) => provider.quota ? [[provider.definition.id, provider.quota] as const] : []),
);
