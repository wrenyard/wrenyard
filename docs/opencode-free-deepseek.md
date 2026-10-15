# OpenCode Free DeepSeek V4.1 Flash

> Scope: **native Task channel only.** This page records one explicitly free
> OpenCode route. It is not a chat-picker or auxiliary-selection integration.

## Identity

The free route is a **distinct model identity**, not an alias of the paid one:

| | canonical id | notes |
| --- | --- | --- |
| paid | `deepseek-v4.1-flash` | 1M context; unrelated limits |
| free | `deepseek-v4.1-flash-free` | 200,000 context / 32,000 max output |

- Wrenyard route: `opencode-zen/deepseek-v4.1-flash-free:oc`
- Native OpenCode selector: `opencode/deepseek-v4.1-flash-free`
- Provider: `opencode-zen`; native client: `opencode` (`supportedClients: ['opencode']`).

The `:oc` suffix is the **public client key**; the run-syntax parser's
`PUBLIC_CLIENT_KEYS` maps `oc` to the internal `opencode` client, so `:oc` is
the canonical spelling and `:opencode` is rejected as an unknown client key.

Invocation-settings example pinning the exact free route:

```json
{"mode":"explicit","explicit_runtime":{"kind":"target","target":"opencode-zen/deepseek-v4.1-flash-free:oc"}}
```

Because the two identities have different limits, both legitimately coexist
under the same provider. There is **no alias, fallback, or substitution**
between them: pinning the exact free model never silently routes to the paid one.

## Metadata

- `contextWindow`: 200000, `maxOutputTokens`: 32000 — taken from the OpenCode
  catalog / native CLI catalog verified 2026-10-15. Do **not** substitute the
  paid or upstream DeepSeek 1M limit.
- `free: true` — an **explicit** classification. Free status is never inferred
  from a price of zero; every consumer branches on the flag.
- `pricing`: `[0, 0, 0]`. Declared for completeness only; the free decision
  comes from the flag.
- Quota binding: the shared OpenCode Zen **free pool** (`opencode-zen/free`).
  It is never bound to the Zen balance pool.
- Speed: **measured 95 TPS.** The canonical `speed` value is the floored
  initial measured median of **95.58 output TPS**, measured 2026-10-15
  17:00–17:02 UTC with native OpenCode client 1.19.0, default reasoning and zero
  credentials. It is never inherited from the paid model's 201. Method and
  limitations are recorded in the measurements section below.

## Terms and limits

Official catalog: <https://opencode.ai/v2/docs/console/models/>.

- The free offer is **limited-time**; provider terms state **zero retention**
  and **no model training**.
- Expiry date and numeric quotas are **unpublished** — treat any quota as
  unknown rather than unlimited.

## Native measurements (2026-10-15)

Successful legitimate native runs on the exact free route with native OpenCode
client **1.19.0**, default reasoning and **zero credentials**, in an isolated
`env -i` environment (fresh HOME/XDG config/data/state/cache), at UTC
2026-10-15 17:00–17:02:

- **3 sequential samples succeeded** and **2 small concurrent samples
  succeeded**; emitted cost was **0** on all.
- Output tokens 217 / 207 / 240 divided by the CLI aggregated text `part.time`
  end-start windows 1.972 / 2.170 / 2.511 s => **110.04 / 95.39 / 95.58 TPS**,
  median **95.58**. The canonical `speed` value (**95**) is this floored initial
  measured median, with the date and method described here.

Method and limitations:

- **True first-token TTFT is unavailable**: the CLI emits a single aggregated
  text event without per-token deltas. The `step_start`→`text.start` deltas
  376 / 151 / 521 ms are proxies that also contain reasoning and are **NOT
  TTFT**.
- The startup/total durations 9.018 / 8.042 / 11.797 s are **NOT generation
  duration**.
- The two concurrent tiny calls passed with **no observed throttle**, but the
  CLI exposes **no HTTP rate-limit / `Retry-After` headers** and **quotas
  remain unknown**. The absence of a 429 is **not** proof of unlimited quota.
- Direct API requests to the documented inference endpoints still return
  **HTTP 403 `FreeTierError`**: the free tier is usable only from within the
  OpenCode client, which is why this route stays native-only.

## Credentials

**No API key is required for this free native route.** Legitimately isolated
native OpenCode **1.19.0** calls to the exact free route
`opencode/deepseek-v4.1-flash-free` succeeded with **no credentials at all**
(5/5: 3 sequential + 2 concurrent), so the route is admitted without any
Wrenyard-managed key.

How that admission is expressed: every surface branches **explicitly** on the
model's free classification through one shared predicate
(`isCredentialFreeNativeRoute` in `@wrenyard/providers`). It admits a route only
when the provider is `opencode-zen`, that provider declares the `opencode`
native client, the exact model exists with `free === true`, the route client is
`opencode` and the route mode is `native` (and `supportedClients`, when
declared, contains `opencode`). A price of zero and a `-free` id suffix are
**never** used as evidence of free status.

- The free native `opencode-zen` row reports configured/available **without a
  key**, because the credential-free native classification is evaluated before
  any credential lookup.
- **Paid OpenCode Zen / Go models and every gateway-mode route still require
  credentials** and keep failing closed without one. This change relaxes no
  runtime credential or Gateway check globally.
- `providerLive` and `quota` stay **unknown** for the free route: live upstream
  health and any numeric quota are genuinely unmeasured and are not fabricated.

**Routing fact — the managed credential is not forwarded.** The native OpenCode
launcher does **not** forward a Wrenyard-managed credential to the child. It
deliberately leaves the persistent OpenCode credential location (the XDG data
home) untouched and consequently relies on OpenCode's own independent native
auth.

**Supported configuration surface for a paid managed key** (no supported CLI
provider-auth command exists):

> Desktop Settings → 供应商 (Providers) → OpenCode Zen → 激活 / 配置 →
> dialog "配置 API Key" / "更新 API Key" → field "API Key" → 保存 / 更新

**Prohibited:** do **not** advise a dummy/placeholder key, do **not** suggest
reusing the OpenRouter key, and do **not** advise manually editing provider auth
files.

**Execution-time credential guards (source finding).** Beyond the runtime
availability callback — the explicit free-type branch above — and the native
client executable/readiness checks, source review found **no further
execution-time credential guard** on this route: Task admission is
daemon-accepting → client enabled/installed → runtime availability, and the
Gateway credential check applies only to gateway-mode routes. No bypass was
added.

## End-to-end Wrenyard Task (verified)

Through the **real source-equivalent isolated daemon production path**
(`task.run.create` → native OpenCode 1.19.0 → structured-output schema
validation) the exact-pinned free route reached terminal status **`done`**:

- Task `task_6bf70a09`, execution `exec_8c6796d81e66a431e6`
- 2026-10-15T18:37:37.871Z → 18:37:49.731Z (**~11.860 s**)
- Runtime `opencode-zen/deepseek-v4.1-flash-free:oc`, mode `native`
- **No credentials**, **no paid fallback**
- Validated structured output marker **`FREE-ROUTE-E2E-OK`**

The run used an isolated environment — fresh `HOME`/XDG paths plus isolated
Wrenyard `WRENYARD_IPC_PATH` / `WRENYARD_CONFIG_HOME` / `WRENYARD_STATE_HOME`,
with no credentials — and the exact pin shown above. The workspace handoff holds
the full run evidence.

**Usage is partial.** Wrenyard recorded **35 input / 68 output tokens** with
`reference_cost_complete=false`. A zero reference price does **not** prove
complete billing, so no complete-billing claim is made here; the native free
route itself reported cost **0**.

Two adapter fixes were required for this to work:

1. `packages/clients/opencode/src/launch.ts` now sets `stdin: ''`, so the
   execution engine closes the otherwise-unused stdin pipe and the headless
   OpenCode CLI receives EOF instead of hanging at startup.
2. The OpenCode event decoder now tracks a completed `step_finish` with reason
   `stop` **separately** from native error records, and reports success only on a
   clean exit code `0` with no signal — so native errors and incomplete streams
   still fail.

On the final code tree, lint/typechecks, build, providers tests **7/7** and
`git diff --check` all passed.

## Verification: auto-routing suite baseline (pre-existing failures)

Independently confirmed baseline (no re-run of tests or measurements here). The
**same auto-routing suite** was run against both:

- an **unmodified local-main snapshot** at `86180835ed8034754c37fa30b7a1430fcdb5c1dc`, and
- the **feature lineage** at `19d466137fb2df584001e10c0af8300c71c875e6`.

Both runs reported **137 tests / 115 pass / 22 fail**, with **identical
failing-test-name sets**. Source-module resolution was proven to resolve the
suite's modules against the **main snapshot** (real paths inside the snapshot,
not the worktree source), and the **main checkout was left untouched**. The full
failing-name list and comparison are recorded in the workspace handoff.

**The suite is NOT all-green.** These **22 failures are pre-existing on main** —
they are not introduced by this route and are not treated as a regression. The
22 failing test names, verbatim from that artifact:

- a marginal discount only feeds the normalized score; Q advantage can outweigh a small P premium
- all factors and the score stay within [0,1]
- complete full-cycle weekly evidence at 28% remaining with ~84% expected remaining is strained, never unknown
- complete kimi-shaped evidence (rolling 5h 100% + full-cycle 7d 96%) is healthy
- equal arithmetic mean is taken across joint healthy full-cycle constraints
- evaluateCandidate returns fresh independent results per call
- full_cycle legal reset/window math and headroom values
- healthy tiers compute quota metrics and normalized score exactly
- incomplete-strained reference is accepted at any listed price
- original inputs mutated after ranking never change returned results
- positive balance contributes zero 0 alongside a healthy peer
- registerProvider rejects a model missing its required speed default
- registerProvider rejects invalid and duplicate thinking levels and bad mapping references
- registerProvider rejects missing, null, and invalid intelligence atomically
- registration rejects missing or invalid model list prices
- rolling_partial healthy/strained/unknown/blocked bands and H
- strained + missing averages in the zero unknown contribution
- strained + unknown averages in the zero unknown contribution
- three constraints average equally regardless of order
- two healthy constraints average equally: 0.8 and 1.0 mean to 0.9
- unknown 0 contributes nothing without discarding a healthy peer
- valid covered discount applies to routingPrice/P only, never H/tier

This baseline is unchanged by the verified end-to-end Task result above: the 22
failures remain **pre-existing on main** and are not a regression from this
route.

## Explicitly out of scope

- Native **Task** channel only. Chat picker and auxiliary selection are **not**
  extended here (`supportedClients: ['opencode']` keeps the route native-only).
- No paid fallback for an exact free-model pin.
