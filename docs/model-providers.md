# models.dev mainstream provider catalog

Wrenyard added the mainstream model providers it was missing using the existing
generic pattern. Scope is deliberately narrow: **15 added providers / 67 models**;
every other upstream row is **not added** (categorised below), and the upstream
catalogue is **not vendored** (no bulk dump).

## Verification (passed)

In the managed worktree `wy-provs` (branch `wrenyard/wy-provs`, HEAD
`dbffd69692ccba4186d561bd01e8471f3771bf96`, unchanged), isolated from the production
daemon, config and credentials:

- `pnpm --filter @wrenyard/providers test` — **7 tests, 7 pass, 0 fail** (exit 0);
  `pnpm lint` — exit 0; `git diff --check` — exit 0.
- Isolated daemon `provider.list` — **37 total = 22 baseline + 15 added**, 67 new
  models (1–5 each); every new provider is `authMode: api-key`, `configured: false`,
  unavailable until a key is stored. A dummy non-secret key for `groq` flipped
  **only** `groq` to `configured: true`; removing it reverted that.
- Canonical identities resolve with hyphen-free SSOT display names, no new route is
  labelled `Free`, the four tiered rows publish no pricing tuple, no new row inherits
  speed/intelligence/pricing, and all 67 routes resolve a reasoning ladder and reach
  the mock transport with an output cap ≤ remaining room.
- Actual failures verbatim (pre-existing at HEAD `dbffd696`, unrelated): `pnpm
  --filter @wrenyard/auto-routing test` — **137 tests, 115 pass, 22 fail** (exit 1):
  `test/auto-routing.test.ts` 18, `test/constrained-dispatcher.test.ts` 4; that suite
  and `packages/providers/src/base/catalog.ts` are unmodified by this diff.
- Boundaries: **no live paid APIs and no real keys** (isolated dummy key only, then
  deleted); **no Desktop UI verification**; **no tests changed**; no **merge, push or
  install**.

## Source used and fetch provenance

`todos.dev` documents provider *setup* but publishes no catalogue
(`https://todos.dev/docs/providers` lists setup examples only), so the source is the
**models.dev public API** `https://models.dev/api.json?type=all`. The 15 retained
providers do **not** come from one snapshot, so one ETag or SHA-256 must not label
the whole set:

| | Fetch A — 14 rows other than `xai` | Fetch B — `xai` (public `spacex-ai-api`) |
| --- | --- | --- |
| fetched (UTC) | `2026-10-14T22:21:34Z` | `2026-10-14T22:31:57Z` |
| ETag | `f3dbe7fd1f33c2ee78ea1606bf7f1958` | `cd7b7ad90ac853c9a9d71d68f1632812` |
| SHA-256 | `f3dbe7fd1f33c2ee78ea1606bf7f1958a54e81b09a1a5285a153d526bce63bb9` | not recorded (not invented) |
| upstream size | 229 providers / 8856 models | `xai`: 13 models, 1 kept |

The flat-vs-tiered **pricing classification** used its own separate read-only fetch,
independent of the id/name/limit provenance above: same URL, fetched
`2026-10-14T23:30:30Z`, ETag `a35d85820f102ac0a3236690edc0251f`, SHA-256
`a35d85820f102ac0a3236690edc0251f1c3ce655d31ac2483ba8b727068b78a8`, scope = the 67
retained model pairs only.

## Baseline: 22 pre-existing builtin provider IDs

Already registered in `packages/providers/src/builtins.ts` (Desktop consumes the same registry; no parallel UI registry exists):

`anthropic`, `chatgpt`, `claude-coding`, `codebuddy`, `cursor`, `deepseek`, `kimi-coding`, `minimax`, `minimax-coding`, `moonshot`, `openai`, `opencode-go`, `opencode-zen`, `openrouter`, `qwen`, `qwen-coding`, `spacex-ai`, `super-grok`, `tokenhub`, `volcengine`, `zhipu`, `zhipu-coding`

## Added providers (15)

All 15 use the generic pattern: `managed` API key, one fixed public HTTPS base URL and one protocol path (trailing slash trimmed). Fourteen are OpenAI chat-completions rows; the models.dev `xai` row is published under Wrenyard's canonical SpaceXAI naming as the public id **`spacex-ai-api`** (the existing native `spacex-ai` builtin is left untouched) and uses `openai_responses` (`https://api.x.ai/v1/responses`, bearer). Total **15 providers / 67 text models**.

| source ID | public provider ID | display name | base URL | protocol | kept models |
| --- | --- | --- | --- | --- | --- |
| `google` | `google` | Google | `https://generativelanguage.googleapis.com/v1beta/openai` | `openai_chat` | 5 |
| `mistral` | `mistral` | Mistral | `https://api.mistral.ai/v1` | `openai_chat` | 5 |
| `groq` | `groq` | Groq | `https://api.groq.com/openai/v1` | `openai_chat` | 5 |
| `togetherai` | `togetherai` | Together AI | `https://api.together.ai/v1` | `openai_chat` | 5 |
| `fireworks-ai` | `fireworks-ai` | Fireworks AI | `https://api.fireworks.ai/inference/v1` | `openai_chat` | 5 |
| `cerebras` | `cerebras` | Cerebras | `https://api.cerebras.ai/v1` | `openai_chat` | 2 |
| `deepinfra` | `deepinfra` | Deep Infra | `https://api.deepinfra.com/v1/openai` | `openai_chat` | 5 |
| `cohere` | `cohere` | Cohere | `https://api.cohere.ai/compatibility/v1` | `openai_chat` | 5 |
| `perplexity` | `perplexity` | Perplexity | `https://api.perplexity.ai` | `openai_chat` | 4 |
| `nvidia` | `nvidia` | Nvidia | `https://integrate.api.nvidia.com/v1` | `openai_chat` | 5 |
| `huggingface` | `huggingface` | Hugging Face | `https://router.huggingface.co/v1` | `openai_chat` | 5 |
| `nebius` | `nebius` | Nebius Token Factory | `https://api.tokenfactory.nebius.com/v1` | `openai_chat` | 5 |
| `vercel` | `vercel` | Vercel AI Gateway | `https://ai-gateway.vercel.sh/v1` | `openai_chat` | 5 |
| `sambanova` | `sambanova` | SambaNova | `https://api.sambanova.ai/v1` | `openai_chat` | 5 |
| `xai` | `spacex-ai-api` | SpaceXAI API | `https://api.x.ai/v1` | `openai_responses` | 1 |

Not a full catalogue dump: each provider keeps **at most 5 current text/chat or coding
models**, preferring tool-capable flagships and avoiding deprecated entries, and
selection never rewrites source identity. A vendor SDK is not treated as bespoke —
Google, Groq, Mistral, Cerebras, Cohere, DeepInfra, Together AI, Perplexity, Vercel and
xAI document an OpenAI-compatible base, and Fireworks AI, Nvidia, Hugging Face, Nebius
and SambaNova declare `@ai-sdk/openai-compatible` (vendor URLs listed at the end).

### Pricing classification: flat vs tiered

- **Flat (published)** — a single `[cached, input, output]` USD/M tuple (one scalar rate per component, all three present).
- **Tiered (not published)** — a rate that changes above a token threshold
  (`cost.tiers` / `cost.context_over_200k`) publishes **no** tuple, since the flat
  runtime shape cannot express tiers. **Four** rows: `google`
  `gemini-3.1-pro-preview` (above 200000: `0.4/4/18` vs `0.2/2/12`), `vercel`
  `google/gemini-3.1-pro-preview` (above 200001: `0.4/4/18` vs `0.2/2/12`), `vercel`
  `openai/gpt-5.6-sol` (at 272000: `0.8/8/30` vs `0.4/4/20`) and `xai` `grok-4.7`
  (above 200000: `1/4/12` vs `0.5/2/6`).
- **Incomplete (not published)** — a row omitting `cache_read`, `input` or `output` publishes no partial tuple. The pricing fetch classified the 67 pairs as **38 flat, 4 tiered, 25 incomplete/absent**.

## Not added

Only the 15 above are added; the remaining upstream rows fall into three groups.

**1. Already present** (adding would duplicate an existing provider): `anthropic`,
`deepseek`, `openai`, `openrouter`, `volcengine`, `opencode` (→ `opencode-zen`),
`opencode-go`, `tencent-tokenhub` (→ `tokenhub`).

**2. Outside this mainstream batch** — the long tail: regional/plan variants of
already-covered providers (`alibaba*`, `kimi-code-plan-*`, `minimax*`, `moonshotai*`,
`zai*`, `zhipuai*`; **not** asserted to be exact endpoint duplicates, simply left out),
niche aggregator/reseller gateways (`302ai`, `aihubmix`, `aimlapi`, `nano-gpt`,
`llmgateway`, `requesty`, `zenmux`, `siliconflow`, `poe`) and the recent additions
`prime-inference` / `lowrouter`. All remain addable later via the same pattern.

**3. Requires endpoint or auth configuration** — not skipped because the vendor lacks an OpenAI/Anthropic-compatible surface, but because the generic pattern (one fixed public base URL + one managed API key) cannot express them:

| source ID | why the generic pattern cannot express it |
| --- | --- |
| `azure`, `azure-cognitive-services` | resource-name + deployment-specific base |
| `amazon-bedrock` | AWS region + credential-specific endpoint |
| `google-vertex`, `google-vertex-anthropic` | project + location + application-credentials flow |
| `cloudflare-ai-gateway`, `cloudflare-workers-ai` | account/gateway-id specific base |
| `gitlab`, `sap-ai-core`, `watsonx` | gateway/OAuth/IAM token exchange + project/deployment binding |
| `github-copilot` | token exchange / native login flow, not a generic API key |
| `databricks`, `snowflake-cortex`, `neon`, `infomaniak`, `qvac` | account/product-id or bespoke-SDK placeholder |
| `atomic-chat`, `lmstudio`, `lynkr`, `privatemode-ai` | local HTTP server base |

## Metadata policy

Only fields `ProviderDefinition`/`ModelDefinition` can represent are carried; no price,
limit, speed, intelligence tier or reasoning ladder is invented.

- **Kept**: exact upstream wire model id; canonical registry identity and its
  hyphen-free SSOT display name; numeric `contextWindow`/`maxOutputTokens` when sourced;
  input modalities (`text`, plus `image` when sourced); the flat pricing tuple only when
  `cache_read`, `input` and `output` are all sourced and flat. The canonical SSOT names
  `qwen3.8-27b`, `north-mini-code`, `nemotron-3-ultra`, `nemotron-3.5-lightning` and
  `gemma-4-31b-it` had the route-specific ` Free` suffix removed, so a paid source route
  is no longer mislabeled as free (free status stays on the free providers' own route
  declarations and `:free` ids).
- **Not fabricated**: speed, intelligence tier and pricing are never defaulted; the new
  canonical identities are identity-only, and these providers declare
  `skipCanonicalMetadataFallback` so a missing (or tiered) value stays genuinely
  undefined instead of silently regaining a registry value (e.g. `spacex-ai-api`
  `grok-4.7` does not regain `[0.5, 2, 6]`).
- **Provider-default reasoning**: no ladder is declared for any retained row, so each
  provider opts in once via the provider-level `usesProviderDefaultReasoning` setting.
  Ladder-less routes resolve to the singleton `['default']` sentinel: upstream-native
  behaviour, no upstream reasoning field sent (neither `none` nor a fabricated effort),
  `default` out-of-band (never ranking above `max`), and an explicit route ladder kept
  verbatim. `default` means provider default, not "thinking disabled".
- **Quota**: these providers declare **no quota source**, so quota stays
  unsupported/unknown for them — no balance/window/percentage is invented and no quota
  module is added; existing providers' quota behaviour is unchanged.

## Context budget semantics

The declared source output maximum (`maxOutputTokens`) is the model's **capability**,
not a mandatory per-request reservation; the budget check reserves the output the
request asks for.

- Legacy routes: with no per-call cap the source maximum is reserved exactly as before;
  a supplied per-call cap is reserved verbatim (never raised above it).
- A route whose provider declares `skipCanonicalMetadataFallback` resolves its request
  output cap to `min(requested cap or source max, source max when known, contextWindow -
  estimatedInputTokens)`, failing only when no positive room remains.

The resolved cap is a **single** value — what the budget check validates (`request cap +
estimatedInputTokens <= contextWindow`) and what is serialized as the transport's output
field. It bounds only the per-request reservation: no declared limit or reported source
maximum is altered (several rows declare an output max equal to their whole window).

## Reproducible verification

```sh
WT=~/.local/state/wrenyard/worktrees/wy-provs
BASE=$(mktemp -d /tmp/wyprovs-verify-XXXXXX)
mkdir -p "$BASE"/{config,state,home,ipc,workspace}
printf '{"workspace":{"root":"%s/workspace"},"service":{"enabled":true}}' "$BASE" > "$BASE/config/config.json"
# isolated source daemon (sanitized env; production daemon/config untouched)
cd "$WT" && env -i HOME="$BASE/home" PATH="$(dirname "$(command -v node)"):/usr/bin:/bin:/usr/sbin:/sbin" \
  WRENYARD_CONFIG_HOME="$BASE/config" WRENYARD_STATE_HOME="$BASE/state" WRENYARD_IPC_PATH="$BASE/ipc/wrenyard.sock" \
  node --import tsx apps/daemon/lib/main.mts run --config "$BASE/config/config.json" &
# provider.list over IPC via the repo's own client (no task-specific script)
cd "$WT" && WRENYARD_IPC_PATH="$BASE/ipc/wrenyard.sock" node --import tsx --input-type=module -e '
import { WrenyardIpcClient } from "./packages/control/src/index.ts";
const c = new WrenyardIpcClient({ path: process.env.WRENYARD_IPC_PATH });
const { providers } = await c.providerList();
const added = ["google","mistral","groq","togetherai","fireworks-ai","cerebras","deepinfra","cohere","perplexity","nvidia","huggingface","nebius","vercel","sambanova","spacex-ai-api"];
console.log(providers.length, added.filter((id) => providers.some((p) => p.id === id)).length, providers.filter((p) => added.includes(p.id)).reduce((n, p) => n + (p.models?.length ?? 0), 0));
c.close();'
# expected: 37 15 67
cd "$WT" && pnpm --filter @wrenyard/providers test && pnpm lint && git diff --check
```

## Compatibility sources

Vendor OpenAI-compatibility docs: xAI `docs.x.ai/developers/quickstart`; Google `ai.google.dev/gemini-api/docs/openai`; Groq `console.groq.com/docs/openai`; Mistral `docs.mistral.ai/resources/migration-guides`; Cerebras `inference-docs.cerebras.ai/resources/openai`; Cohere `docs.cohere.com/docs/compatibility-api`; DeepInfra `docs.deepinfra.com/chat/overview`; Together AI `docs.together.ai/docs/inference/openai-compatibility`; Perplexity `docs.perplexity.ai/docs/sonar/openai-compatibility`; Vercel `vercel.com/docs/ai-gateway/sdks-and-apis`. SambaNova was the most recent upstream addition (models.dev PR 9249, merged 2026-10-14).
