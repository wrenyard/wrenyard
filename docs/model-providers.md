# Supported providers

Wrenyard ships with 38 built-in model providers. Activate the ones you use in
**Settings › 供应商 (Providers)**; every activated provider's models become
available to the session model picker and to automatic task routing. The
model catalogue changes with releases, so the app is the authoritative list of
models; this page lists the providers and how each one authenticates.

## Subscription and native-client providers

These reuse the login of an official client or account. Sign in with that
client once; Wrenyard reads and refreshes the credential through it and never
asks for the password.

| Provider | Id | Credential | Quota shown |
| --- | --- | --- | --- |
| Claude (Claude Code plan) | `claude-coding` | Claude Code login | yes |
| ChatGPT | `chatgpt` | Codex ChatGPT login | yes |
| Cursor | `cursor` | Cursor agent login | yes |
| CodeBuddy | `codebuddy` | CodeBuddy login | yes |
| SpaceXAI (Grok CLI) | `spacex-ai` | Grok login | — |
| Super Grok | `super-grok` | Grok login | yes |
| Devin | `devin` | Devin login | yes |

ChatGPT subscription models run over the Responses protocol through the local
gateway. Routes with a verified upstream fast tier (for example ChatGPT
subscription models) offer **Fast** in the model picker.

## API-key providers with quota or balance

These take an API key in the provider's 配置 dialog. Where the provider exposes
it, the app shows the plan window or account balance.

| Provider | Id |
| --- | --- |
| Anthropic | `anthropic` |
| OpenAI | `openai` |
| DeepSeek | `deepseek` |
| Kimi Coding | `kimi-coding` |
| Moonshot | `moonshot` |
| Zhipu | `zhipu` |
| Zhipu Coding | `zhipu-coding` |
| MiniMax | `minimax` |
| MiniMax Coding Plan | `minimax-coding` |
| Qwen Model Studio | `qwen` |
| Qwen Coding Plan | `qwen-coding` |
| Volcengine Ark | `volcengine` |
| Tencent Cloud TokenHub | `tokenhub` |
| OpenRouter | `openrouter` |
| OpenCode Zen | `opencode-zen` |
| OpenCode Go | `opencode-go` |

OpenCode Zen and OpenRouter include free models. Free models are marked in the
picker and form their own quota pool, so automatic routing can prefer them
without spending paid quota.

### DeepSeek API models

`deepseek-v4.1-flash` is the canonical identity for the rolling
DeepSeek-V4.1-Flash-1017 release. That release is not a new API ID: the route
keeps the provider-owned upstream binding `deepseek-flash`. The route supports
1,048,576 context tokens and up to 393,216 output tokens per request (hard
ceilings, not a default output budget).

Prices are per million tokens in USD. Peak rates are $0.006 for cache-hit
input, $0.30 for cache-miss input and $1.20 for output; off-peak rates are half
of that ($0.003 / $0.15 / $0.60). Peak runs 01:00–04:00 and 06:00–10:00 UTC,
Monday to Friday, excluding Chinese public holidays; weekends and Chinese
public holidays are off-peak all day.

The route exposes `none`, `low`, `medium`, `high`, `xhigh` and `max` reasoning
effort. `medium` and `xhigh` both map to the upstream `high` effort, and `none`
disables thinking. Thinking is enabled by default at `high`.

DeepSeek V4 Pro remains a separate model.

- Release: https://api-docs.deepseek.com/news/news261017/
- Model limits: https://api-docs.deepseek.com/api/list-models/
- Pricing: https://api-docs.deepseek.com/quick_start/pricing/
- Thinking mode and effort: https://api-docs.deepseek.com/guides/thinking_mode/

## Other API-key providers

These OpenAI-compatible providers take an API key and serve a curated set of
current text models (at most five each). They report no quota.

| Provider | Id |
| --- | --- |
| Google | `google` |
| Mistral | `mistral` |
| Groq | `groq` |
| Together AI | `togetherai` |
| Fireworks AI | `fireworks-ai` |
| Cerebras | `cerebras` |
| Deep Infra | `deepinfra` |
| Cohere | `cohere` |
| Perplexity | `perplexity` |
| Nvidia | `nvidia` |
| Hugging Face | `huggingface` |
| Nebius Token Factory | `nebius` |
| Vercel AI Gateway | `vercel` |
| SambaNova | `sambanova` |
| SpaceXAI API | `spacex-ai-api` |

Providers that need per-account endpoints or a token exchange (Azure, Amazon
Bedrock, Google Vertex, Cloudflare and similar) are not built in.

## What the app shows for each model

- **Context window and output limit** when the provider publishes them;
  unknown values stay unknown rather than estimated.
- **Price** only when the provider publishes one flat rate per token class; a
  tiered or incomplete price is not shown.
- **Speed** from measured generation samples; a model without samples has no
  speed figure.
- **Reasoning effort** levels the route supports. A route without its own
  levels runs at the provider's default.

## Quota

Quota windows (for example a 5-hour and a 7-day window) show the share used, a
pace marker comparing your use with an even rate, and the time until reset.
The status bar shows the tightest window, and routing avoids routes that are
rate-limited, out of quota or failing until they recover.
