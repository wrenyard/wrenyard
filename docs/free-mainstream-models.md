# Free mainstream models: research and acceptance note (2026-10-15)

Research date: **2026-10-15**. All sources below were retrieved on that date.
This note records selection decisions, exact identifiers, and the intended
confirmation procedure. It is a research note: the curation research ran no
inference, and published catalog availability is not the same as a successful
generation.

## Scope

Curate currently available **free** offerings into the mainstream model list so
they become selectable in the model picker with truthful metadata. The picker
curation landed first; the shared explicit-free routing integration for Tasks
and auxiliary selection is documented in the section below (this supersedes the
earlier "wholly deferred" statement).

## Selected OpenRouter rows

| Wire ID (exact) | Canonical ID | Display name | Modalities | Context | Max output |
| --- | --- | --- | --- | --- | --- |
| `nvidia/nemotron-3-ultra-550b-a55b:free` | `nemotron-3-ultra` | Nemotron 3 Ultra | text | 1,000,000 | 65,536 |
| `nvidia/nemotron-3.5-lightning:free` | `nemotron-3.5-lightning` | Nemotron 3.5 Lightning | text | 1,000,000 | 65,536 |
| `nvidia/nemotron-3-super-120b-a12b:free` | `nemotron-3-super-120b-a12b` | Nemotron 3 Super | text | 262,144 | 235,929 |

The wire IDs and canonical mappings are unchanged; this change only sets the
reasoning ladder for these three routes to the provider-default sentinel and
corrects their identity metadata.

### Pricing

Published prompt (input) and completion (output) rates are **$0 per million
tokens** for all three rows. **Cache prices are unpublished** (unknown, not
zero).

The gateway `ModelPricing` value is an all-or-nothing `[cached, input, output]`
tuple: it cannot carry a partial price set. Because the cached component is
unpublished, we leave pricing **absent** for these rows rather than fabricate a
cached `0` or widen the shared schema. `free: true` is justified **only** by
the explicitly published free token rates, not by the unknown cache price.

### Capabilities

Tools and reasoning are supported on all three rows. `nvidia/nemotron-3-ultra-550b-a55b:free`
and `nvidia/nemotron-3.5-lightning:free` list **no structured-output
parameter**, while `nvidia/nemotron-3-super-120b-a12b:free` supports structured
outputs.

### Metadata corrections

Copied intelligence, speed, and pricing defaults that the published source did
not support were **removed** from these three identities rather than replaced
with invented alternatives. The source confirms reasoning support but not a
specific effort ladder, so these routes use the provider-default sentinel; the
converter omits any upstream reasoning effort for that sentinel instead of
inventing a ladder.

### Sources

- Catalog: <https://openrouter.ai/api/v1/models>
- Model pages:
  - <https://openrouter.ai/nvidia/nemotron-3-ultra-550b-a55b:free>
  - <https://openrouter.ai/nvidia/nemotron-3.5-lightning:free>
  - <https://openrouter.ai/nvidia/nemotron-3-super-120b-a12b:free>

### Popularity (platform adoption, not quality)

Free-model token usage over the last 7 days, from
<https://openrouter.ai/collections/free-models>:

- rank 1: Nemotron 3 Ultra — 7.81T tokens
- rank 2: Nemotron 3.5 Lightning — 1.27T tokens
- rank 5: Nemotron 3 Super — 757B tokens

These numbers measure platform usage, not model quality.

### Free-tier conditions

From <https://openrouter.ai/docs/api_reference/limits> and
<https://openrouter.ai/blog/tutorials/how-to-get-the-lowest-cost-llm-inference-on-openrouter/>:

- An account / API key is required.
- The free pool shares **20 requests/minute** and **50 requests/day**.
- A cumulative credit purchase of **>= $10** raises the daily allowance to
  **1000 requests/day**.
- Failed requests may still count against the quota.
- Upstream limits vary, and there is **no guaranteed permanence**.

### Exclusions

- **Laguna rank 3** was excluded because it expires **2026-10-31**, too near
  term to add as a stable mainstream row.
- **Dots rank 4** was excluded because of conflicting retirement notices.

## OpenCode Zen (research only, deferred)

Research only — **not implemented** in this change.

Sources: <https://opencode.ai/zen/v1/models> and
<https://opencode.ai/docs/zen/> list:

- `space-bunny-free`
- `longcat-2.5-preview-free`

(exact wire IDs; the `opencode/` prefix is client configuration only, not part
of the API ID.)

Both are limited-time offers that are free on input, output, and cache-read;
**cache-write is not published**. Quota, end dates, and zero-balance
eligibility are **unknown**. Account/API key and billing setup are documented,
and zero-retention / no-training is claimed.

### models.dev metadata

- <https://raw.githubusercontent.com/anomalyco/models.dev/dev/providers/opencode/models/space-bunny-free.toml>
  — context 1,048,576 / input limit 524,288 / max output 524,288; text, image,
  video; tools and reasoning.
- <https://raw.githubusercontent.com/anomalyco/models.dev/dev/providers/opencode/models/longcat-2.5-preview-free.toml>,
  inheriting
  <https://raw.githubusercontent.com/anomalyco/models.dev/dev/models/meituan/longcat-2.5-preview.toml>
  — context 1,000,000 / output 131,072; text, image; tools and reasoning.

Note: the models.dev cache-write value of `0` for Space Bunny conflicts with the
Zen `-` (unpublished). The conflict is **only about cache-write**: that single
price cannot be described as verified free. This does **not** make the whole
model unverified — Space Bunny's published free **input/output** rates stand, and
the model must not be described as not free. No official popularity data exists
for these Zen IDs.

### Why deferred

Existing Zen free offerings require the native OpenCode transport
(`supportedClients: ['opencode']`), and the gateway/session picker excludes
client-only routes. Adding these native-only IDs alone would **not** make them
selectable — they would simply **remain excluded** from the picker — and
transport restrictions must **not** be weakened or bypassed. These Zen
candidates are therefore recorded here but deferred rather than published.

## Shared explicit-free routing integration

### Coordinator-rejection revision (2026-10-16)

The earlier revision **`709401e6`** was **not accepted** by the coordinator. Its
own real checks showed the change made automatic selection **worse** in practice:
the live Task **explicitly pinned** `nex-agi/nex-n2.5-mini:free` through the
`opencode` client and hung with no output; automatic discovery also admitted that
unsafe offering. The auxiliary selector picked `thinkingmachines/inkling-small:free`
and received an HTTP 403. Neither route is a
mainstream-list model and neither had passed a real call. This revision replaces
that behavior with the required explicit-free automatic-eligibility policy below.

**Required explicit-free policy (now the rule).** A `free: true` offering may be
auto-selected for **Tasks** or **auxiliary calls** **only** when **all** of the
following hold:

1. it is in the **mainstream list**;
2. it has **real measured TPS recorded in code with provenance**;
3. it meets the existing **intelligence / capability / context** requirements; and
4. it is **not blocked by route health**.

**Every other free offering stays chat-picker-only or hidden under the existing
picker policy and is never auto-selected.**
The single shared gate (`explicitFreeAutoEligibility`, detailed in the next
subsection) applies to **every** `free: true` offering — including the
**CodeBuddy** and **OpenCode Zen** free offerings — and any free offering
**without recorded measurement provenance** is excluded.

**The prior Nex free Task was an explicit pin, not an automatic selection.** That
real read-only Task resolved to `openrouter/nex-agi/nex-n2.5-mini:free` only
because it was **explicitly pinned** (`auto_routing: null`); automatic routing did
not choose it, and the route is also **not** a mainstream-list model. On
coordinator review the earlier blanket OpenRouter client rejection was **reverted**
(see the OpenRouter client decision below): the prior Task failure was
**model-specific** — the specific free model `nex-agi/nex-n2.5-mini:free`, which
the four-condition free gate now excludes by itself — and it gives **no** evidence
that the OpenRouter-via-`opencode` client combination itself is broken.

**No new live generation was needed for that revision.** The earlier real
chat/TPS measurements and the live circuit-recovery observation below remain
**historical evidence** and are not superseded by this revision. At that point no
free route satisfied the gate above, so there was nothing newly generatable to
verify live; the measured OpenCode Zen free DeepSeek route recorded later (see the
measured-route subsection below) is the first free route that does — for
**Tasks**.

### Explicit-free policy

A model is free only when it is **explicitly typed free** (`free: true`). Every
consumer that references free offerings branches on that explicit free flag/kind
(`if`/`else` on the free kind), and **no** consumer infers free status from a
numeric price of `0`. Registry/catalog price `0` is **allowed but not required**:
an explicit free route may declare a `0` price, a non-zero reference, or no price
at all. A **paid** route whose price is unknown is never treated as free or as
zero, and no TPS or intelligence value is invented — speed metadata is recorded
only after real measurement.

### Explicit-free automatic-eligibility policy

Free status also **gates automatic selection**, and the gate is explicit. A free
offering may be auto-selected for Tasks **or** auxiliary calls **only** when all
of the following hold:

1. it is in the **mainstream list** (`isMainstreamModelId` over its canonical
   identity, `canonicalModel.id ?? id`);
2. it has **real measured TPS recorded in code** — a
   `modelSpeedMeasurements` entry (initial measured TPS plus when and how it was
   measured) **and** the matching integer `modelSpeedOverrides` value it is the
   evidence for — and the existing intelligence/capability/context requirements
   are met;
3. it is **not blocked by route health** (see the route-circuit paragraph below).

**Every other free offering stays chat-picker-only or hidden under the existing
picker policy and is never auto-selected.**
Non-free routes pass this gate unchanged. The single shared decision is
`explicitFreeAutoEligibility(provider, model)` in
`packages/providers/src/base/catalog.ts`; it branches on the explicit
`free === true` flag first and returns the specific exclusion reason
(`free_not_mainstream`, `free_missing_measured_tps`). It duplicates **no**
allowlist of wire names: mainstream membership and recorded provenance are the
only inputs. Inherited catalog defaults and local 31-day samples are **not**
measured provenance.

`modelSpeedMeasurements` is a new optional provider-scoped field declared next to
`modelSpeedOverrides`. Registration validates every entry: the key must be an
**exact** declared model id, `initialTps` must be finite and positive,
`measuredAt` must parse to a valid date, `method` must be a non-empty string, and
a matching `modelSpeedOverrides` entry must exist for the same id. It records
provenance only and **never replaces** the integer override, which stays the
routing fact.

**OpenRouter client decision (reverted on coordinator review).** `opencode` is the
**sole** task-capable client that resolves OpenRouter's protocol and
reasoning-effort mapping; `dsh` is **not** `taskCapable`. An earlier revision added
`openrouter` to `opencode`'s `unsupportedGatewayProviders`
(`packages/providers/src/catalog.ts`), which made **all** OpenRouter Task routes —
paid and free — unavailable fail-closed. That blanket rejection was **reverted on
coordinator review**: the observed OpenRouter Task failure was **model-specific**
(the free model `nex-agi/nex-n2.5-mini:free`, now excluded by the four-condition
free gate) and gives **no** evidence that the client combination itself is broken.
The supported OpenRouter-via-`opencode` combination is therefore **restored**, so
paid or otherwise eligible OpenRouter Task routes resolve and launch as before.
`opencode-zen` and `opencode-go` behavior is unchanged, and no reasoning-effort
mapping was added or removed for any other client. A subsequent **real** Task
through `openrouter/anthropic/claude-sonnet-5.5:oc` reached the Gateway on this
restored path and failed only on upstream paid-pool quota exhaustion (see the
client-recovery acceptance below), so the combination is now **exercised live**
rather than being a policy correction alone.

The following free-type branch points were touched so each free consumer decides
free vs priced explicitly:

- `routingReferencePriceOf` (`packages/providers/src/base/catalog.ts`) tests
  `free === true` **first** and returns `kind: 'free'` for every explicitly free
  route, retaining a declared output reference when one exists, so a free route
  with a declared price keeps its list-price safety cap; only a non-free route
  that declares a price returns `kind: 'priced'`, and every other (paid)
  price-less route returns `undefined`.
- The constrained dispatcher
  (`packages/features/auto-routing/src/constrained-dispatcher.ts`) branches its
  intrinsic price-cap gate and reference-price ordering on that kind:
  free-with-declared-reference is capped and ordered by its reference exactly like
  a priced route; free-without-reference is admitted as an explicit free marker and
  ordered after comparably priced routes; paid-without-reference is rejected.
- The Task dispatch resolver
  (`apps/daemon/lib/core/task/dispatch-resolver.mts`) handles free before priced in
  the pricing diagnostics, `referenceOutputPriceOf`, `toReferencePricing` and
  selected-choice validation. An empty `reference_pricing` (`{}`) means an
  **unknown / unpublished reference** and **never** encodes free; free identity
  comes from the explicit catalog kind/flag and downstream `confirmedFree`
  evidence, and the Task explicit-target unknown-pricing path may also emit `{}`
  without inferring free.
- Auxiliary (Gateway) selection
  (`apps/daemon/lib/daemon/services/auxiliary-routing.mts`) branches its
  eligibility and `reference_pricing` construction on free vs priced; a free route
  without a reference emits an empty `reference_pricing` (`{}`), which denotes only
  an **unknown / unpublished reference** — free identity comes from the explicit
  catalog kind/flag, not from the empty object.
- `toAutomaticCandidateInput` and `effectiveRoutingCap`
  (`apps/daemon/lib/daemon/services/model-routing-inputs.mts`) apply the routing
  zero fallback and build the confirmed-free evidence only when
  `freeSupply.confirmedFree === true`; the cap accepts an absent reference
  truthfully and never yields `NaN`/`Infinity`.
- Price scoring (`packages/features/auto-routing/src/candidate-scorer.ts`) uses the
  confirmed-free supply class for the free score and standard price interpolation
  otherwise; `numeric.ts` no longer describes a non-positive numeric price as proof
  of free.
- The shared decision `explicitFreeAutoEligibility`
  (`packages/providers/src/base/catalog.ts`) is applied to **all three** automatic
  selection paths, so every one of them branches explicitly on the free flag and
  on recorded measurement provenance: the authoritative intrinsic candidate gate
  in the constrained dispatcher
  (`packages/features/auto-routing/src/constrained-dispatcher.ts`), the Task
  dispatch resolver's automatic selection, diagnostics and conservative explicit
  free-target rejection (`apps/daemon/lib/core/task/dispatch-resolver.mts`), and
  auxiliary selection before ranking
  (`apps/daemon/lib/daemon/services/auxiliary-routing.mts`). No parallel
  selection path was created and the existing free/paid price-cap and ordering
  branches stay intact.
- Auxiliary selection additionally excludes an explicit free offering whose route
  is **open**, or **half-open** with `nextProbeAt` still in the future, using the
  existing shared route-status callable; a **due** half-open route stays admitted
  (the Gateway owns the bounded probe lease). Paid routes keep their existing
  retain-for-recovery behavior, and no new circuit store or timer was added.

Already-compliant display/supply branches were left unchanged: the model picker
badge (`facts.free === true`, a missing price is never free), the Composer
free-exhausted label (`entry.free === true`), the session usage cost
(`free: model.free === true`) and the shared `SupplyEvidencePolicy` (explicit
`kind === 'confirmed_free'` evidence test).

Everything else is unchanged: known reference-price caps still apply, and
capability, context, intelligence, speed, credential, and client gates are
untouched. These three Nemotron rows still carry **no** intelligence evidence,
so they remain **ineligible for Task automatic selection and auxiliary
selection** — the free-price change does **not** make them Task-eligible. Real
initial TPS was subsequently measured for these three rows and recorded as
provider speed overrides (see the live acceptance below); **no** intelligence
value was invented, and the Ultra row additionally fails the speed gate on its
measured TPS.

### Measured OpenCode Zen free route threaded through the gate (2026-10-16)

A blanket "no free route is auto-eligible" claim **no longer holds**. The distinct
measured **`opencode-zen/deepseek-v4.1-flash-free`** row (native OpenCode client
1.19.0; 200,000 context / 32,000 output) now carries code-recorded measurement
provenance: a provider-scoped `modelSpeedOverrides` value **`95`** backed by a
matching `modelSpeedMeasurements` entry (`initialTps` **95.58**, measured
**2026-10-15**, with the method — 3 sequential samples, median from output tokens
over part timestamp windows, not token-level instrumentation — recorded beside the
value). Its identity, limits, terms and live Task evidence are in
`docs/opencode-free-deepseek.md`.

Because it satisfies the shared four-condition gate — mainstream identity,
recorded measured provenance, the existing intelligence/capability/context
requirements, and a callable route — it **may now be auto-selected for Tasks**.
Its `supportedClients: ['opencode']` keeps it **native-only**, so **auxiliary
(Gateway) selection still excludes it**; only the native Task channel can admit
it.

The three Nemotron rows still satisfy mainstream membership and measured-TPS
provenance, but they still lack intelligence evidence, so they are excluded
before the free-specific gate can admit them (and Ultra also misses the speed
gate). Every other free offering lacks recorded measurement provenance — or
mainstream membership — and is therefore excluded as well. **No free route is
currently eligible for auxiliary selection**, and the only free route that can be
automatically selected for Tasks is the native-only OpenCode Zen free DeepSeek
row above.

Selection now also observes the shared Gateway route circuit. Task automatic
candidates and explicit execution availability reject an **open** route, or a
**half-open** route whose `nextProbeAt` is still in the future, while a **due**
half-open route stays admitted so the Gateway's own bounded probe can recover
it. The same Gateway route-status callable already used by session and auxiliary
routing is injected into the Task settings service; no second Gateway, circuit
store, or timer is created, native-client routes are never gated on Gateway
faults, and the no-fallback-after-launch behavior is unchanged.

An empty `reference_pricing` (`{}`) **never** encodes free: it only marks an
**unknown / unpublished reference**, and the Task explicit-target unknown-pricing
path can emit the same `{}` without inferring free. Downstream, a route whose
reference price is absent (`{}`) also needs a price to reach ranking. The daemon
supplies a **routing-only numeric zero** *only* when
the **authenticated confirmed-free supply** fact (`availability.freeSupply` with
`confirmedFree === true`) is present for that candidate; the zero exists solely as
authenticated confirmed-free routing evidence for ranking. It is **not** a
published, estimated, catalog, picker, Gateway, or billing price. A price-less
route **without** confirmed-free evidence is still rejected as an unknown price
(no candidate is built), and any declared reference price is preserved verbatim.
When no candidate carries a finite reference price the shared cap keeps its
existing default semantics without producing `Infinity`/`NaN`.

### Historical no-key boundary (superseded 2026-10-15T16:56Z)

While this machine had **no OpenRouter key**, live authenticated inference for
these rows could not be verified here: verification was bounded to an isolated
source daemon plus **dummy placeholder** credentials, which proves catalog and
selector projection and the routing/policy decisions but **not** authenticated
inference. That boundary held for the routing integration described above. It
was superseded on **2026-10-15T16:56Z**, when the user configured a real
OpenRouter key in the installed daemon (`provider.list`: `openrouter
configured=true`); the live acceptance below was then run. Published catalog
availability is still not successful generation, and the routing integration
remains verified by construction for anything those live calls did not cover.

### Routing-integration verification

Only the checks below were actually run for the shared routing integration:

- `pnpm lint` (oxlint plus root `tsc --noEmit` plus desktop `tsc -b`) exited
  **0**.
- The daemon build and the Desktop build exited **0**.
- An isolated source daemon over IPC, launched with a **dummy configured**
  OpenRouter key, selected the existing **metadata-complete** free offerings;
  with **no credentials** those offerings were excluded.
- The existing Gateway route-state checks passed **20/20**.
- Fault / half-open evidence is limited to what was actually recorded: the
  production Task route gate was exercised with **in-memory / mock** evidence,
  alongside the existing 20/20 Gateway route-state tests. The auxiliary suite
  ran **15/16** with a single pre-existing baseline cancellation failure, and
  auto-routing ran **115/137** with 22 pre-existing failures. These suites are
  **not** all green; the failures are baseline and are not caused by this
  change.
- **No full SOURCE-daemon end-to-end generation** was performed for the source
  worktree patch (no chat, real Task, or auxiliary generation through the source
  daemon itself). However, the actual source **production selector + runner** *was*
  run through the **installed Gateway** over a free-only catalog: its upstream free
  call was attempted and **failed with HTTP 403** (see the live acceptance below).
  That earlier diagnostic harness ran before the integer `modelSpeedOverrides` fix,
  so it omitted the integer overrides — an omission confined to that harness, not
  the final revision. This is **not** a completed three-call acceptance: the real
  Task and auxiliary attempts were made but **failed** (execution timeout;
  auxiliary 403 auth followed by a 503 from the open circuit), so live acceptance
  remains **unmet**.

### Post-rejection source verification (updated source daemon 1.0.66)

Verification **`task_336fc035`** ran the **updated source daemon** (**version
1.0.66**) through **real IPC** with a **dummy projection-only** credential. The
dummy credential proves the provider was **configured** while **no upstream
inference** was attempted:

- An **automatic** `explore` Task (**`task_a7e7c5bf`**) failed with **"no eligible
  dispatch plan"** and **`attempt_count: 0`** — rejected before launch.
- An **explicit free** Task (**`task_49fd9afc`**) was **rejected** with
  **`attempt_count: 0`**. At the time the rejection came from the OpenRouter client
  gate, which has since been **reverted**; that non-mainstream free offering stays
  excluded from automatic selection by the four-condition free gate.

Both outcomes are the intended skip behavior: no free route offered by **that**
revision was auto-eligible. This run **predates** the client-gate reversion, so it
is **not** evidence that OpenRouter Task routes remain unresolvable, and it is
**not** a successful OpenRouter Task acceptance.

### Auxiliary selector evidence: production-runner harness (`task_06838850`)

An empty `session.prompt.suggest` result (`{}`) is **not** policy acceptance. The
selector-reaching evidence is **`task_06838850`**, which drove the **production
auxiliary `CallRunner` and auxiliary selector** suggestion invocation (role
`suggestion`) over a real in-memory ledger seeded with a benign completed turn,
behind a **denying/counting transport** and a **denying fetch**:

- `selectorReached: 1` — the shared selector was actually reached.
- Rejection reasons: **free route not auto-eligible (`free_not_mainstream`) = 16**,
  **intelligence unknown = 3**, **free route not auto-eligible
  (`free_missing_measured_tps`) = 1**.
- `transportCalls: 0` and `fetchCalls: 0` — **no** transport request was made.
- **One** failed span was recorded.

This is a **production-runner harness**, **not** a full session IPC success: it
demonstrates that the real selector rejects every free candidate before any
outbound call, not that an auxiliary call completed.

### Final source verification on rebased base `86180835`

After all fixes were in place (integer `modelSpeedOverrides`, explicit-free
branches), the final source revision was verified on the rebased base
**`86180835`**:

- `pnpm lint` / typecheck passed.
- The daemon build and the Desktop build passed.
- `createBuiltinCatalog` registration passed.
- The policy harness passed.
- An isolated source daemon (**version 1.0.66**) passed, with the integer overrides
  **97 / 2 / 33** in effect.

Intelligence remains **unknown** for all three rows, so they stay ineligible for
automatic Task and auxiliary selection.

### Live acceptance on the installed daemon 1.0.65

After the user configured a real OpenRouter key in the **installed** daemon
(version **1.0.65**), three explicit OpenRouter HTTP calls were completed
through the installed daemon's credential-owning path — one per curated free
route — each returning **HTTP 200** with `finish_reason=stop` on a short PONG
prompt, with **no retries**. Real session:
`f42a6c7d-729b-461d-b148-4ff02e12133d`.

Method and source: measured on the **installed daemon 1.0.65** from that real
session; the sampler formula is `TPS = streamTokens / (streamMs / 1000)`. The
samples are **short PONG / short reasoning-inclusive initial observations**, not
sustained text benchmarks. Raw evidence artifact:
`task_dcf72e35/live-acceptance-summary.json`.

| Wire ID | Ledger span | UTC time | TTFT (ms) | streamTokens / streamMs | Exact initial measured TPS | Stored integer (floored) |
| --- | --- | --- | --- | --- | --- | --- |
| `nvidia/nemotron-3.5-lightning:free` | `s1.3` | 2026-10-15T17:03:45.852Z | 1,957 | 44 / 452 | **97.345** | **97** |
| `nvidia/nemotron-3-ultra-550b-a55b:free` | `s2.9` | 2026-10-15T17:04:24.314Z | 9,407 | 24 / 10,186 | **2.356** | **2** |
| `nvidia/nemotron-3-super-120b-a12b:free` | `s3.11` | 2026-10-15T17:04:28.646Z | 2,002 | 62 / 1,842 | **33.659** | **33** |

The **exact initial measured TPS** values are the real observations. The
provider speed overrides (`packages/providers/src/openrouter/models.ts`) store
the **floored integer** of each measured value (`97` / `2` / `33`) because
`Catalog.validateSpeed` requires a positive integer. The exact measured value,
its UTC timestamp, the TTFT, the sampler formula, and the flooring rationale are
retained in the adjacent comments, per the user's rule that speed metadata may
enter code only after real verification. These values do **not** establish
intelligence eligibility.

**Repeat short samples** on the same routes (same short PONG /
reasoning-inclusive method, **not** a sustained benchmark) recorded approximately
**87.8 TPS** for `nvidia/nemotron-3.5-lightning:free` and approximately
**26.6 TPS** for `nvidia/nemotron-3-super-120b-a12b:free`. These are supplementary
repeat observations and do **not** replace the initial values above.
`nvidia/nemotron-3-ultra-550b-a55b:free` subsequently hit an upstream overload at
**2026-10-15T17:21:07Z** that produced **no TPS**; that failed sample must
**not** replace the initial observation.

**Installed upstream acceptance vs. the still-uninstalled wy-frtsk patch:**
these three calls ran on the **installed upstream daemon 1.0.65**, which does
**not** contain the `wy-frtsk` patch — the shared explicit-free routing
integration, the Task Gateway route-circuit gate, and these speed overrides are
still **uninstalled**. The calls therefore demonstrate **installed upstream
acceptance** of the three free routes and their provider path; they do **not**
validate the uninstalled worktree patch.

**Actual Task and auxiliary acceptance did not succeed.** The real read-only Task
was created as **`task_cca5cd2f` / `exec_323865105cae074adb`**, **explicitly
pinned** (`auto_routing: null`, so it was **not** an automatic selection) to
provider `openrouter`, model `nex-agi/nex-n2.5-mini:free` (not a mainstream-list
model), client `opencode`/gateway; the
child started at **2026-10-15T17:17:25.889Z** and the execution timed out at
**2026-10-15T17:31:26.007Z** with **no stdout, usage, TPS, or upstream response
evidence**. The pre-existing session suggestion actually used the **non-free
CodeBuddy DeepSeek** route, so it is **not** OpenRouter-free acceptance. For the
auxiliary chain, the **source production selector + runner** (via the installed
Gateway over a free-only catalog) selected `thinkingmachines/inkling-small:free`
and received an **HTTP 403 auth** failure at **2026-10-15T17:39:29Z**; the other
free candidate then returned **503 because the local circuit was open**. All
OpenRouter rows showed **auth_failed/open** until **2026-10-15T18:09:29.979Z**.
There is **no** successful free OpenRouter auxiliary response.

This is **not** a completed three-call acceptance, and the Task and auxiliary
links above stay **failed**. **Live circuit recovery was observed**, however, and
without a daemon restart: after the OpenRouter provider-wide `open` / `auth_failed`
state (due `2026-10-15T18:09:29.979Z`), a **single** post-due request through the
installed **1.0.65** Gateway to `openrouter/nvidia/nemotron-3.5-lightning:free`
at **2026-10-15T18:09:31Z** returned **HTTP 200** with `finish_reason=length`; all
**128** provider completion tokens landed on the **reasoning** channel, so the
visible text was **empty**. The post state at **2026-10-15T18:09:37Z** showed the
fault fields **absent across all 22 OpenRouter rows**, with **no daemon restart**,
**no circuit/credential/config reset**, and **no retries**. This confirms the
Gateway's own bounded half-open probe recovered the route; it is **not** a
successful Task or auxiliary acceptance. The probe's **1231.7 ms** TTFT is
**probe timing only**, not an output-TPS sample. A harness-reported **29.288**
must **not** be recorded as TPS: that ad-hoc harness wrongly equated **123 SSE
deltas** with output tokens and folded the TTFT into `streamMs=4199.7`, so it is
not a comparable token-throughput figure. The sole initial TPS evidence stays the
ledger-based sampled values above (**97.345 / 2.356 / 33.659**, stored as floored
integers **97 / 2 / 33**), unchanged. The earlier **mock** half-open behavior
(the 20/20 Gateway route-state checks) remains **mock** evidence and stays
distinct from this single **live** probe. The Nemotron rows remain ineligible for
automatic Task/auxiliary selection for missing intelligence (and, for Ultra,
insufficient speed).

**No secret or credential file was read** while making these calls: no
credential file, note, or key material was opened, copied, or printed; the
installed daemon owned the credential. The explicit-free policy above is
restated unchanged: free status is decided only by the explicit `free: true`
flag/kind, never by a numeric price of `0`.

### OpenRouter client recovery: real paid-route Task acceptance (source daemon 1.0.66)

After the blanket OpenRouter client rejection was reverted, the restored
OpenRouter Task path was exercised **for real** on the **source daemon 1.0.66**
built from this `wy-frtsk` worktree and rebased onto local main **`e85faa97`**
(the source daemon, **not** the installed 1.0.65). A **read-only `code-review`
Task** (**`task_c43d3e9e`**) was explicitly targeted at
**`openrouter/anthropic/claude-sonnet-5.5:oc`**. It started at
**2026-10-15T19:47:47.362Z** and reached its terminal state at
**2026-10-15T19:47:52.732Z** as **failed** with **exit 1** and **no output and no
usage**. The persisted resolved dispatch recorded the correct **provider / model /
client** (`openrouter` / `anthropic/claude-sonnet-5.5` / `opencode`), and the
**OpenCode client logs confirm the request entered the Gateway stream** — so the
OpenRouter-via-`opencode` client path itself resolved and launched.

The failure was an **upstream paid-pool refusal**, **not** a client-combination
failure. In the same run all **three** paid OpenRouter mainstream routes were
recorded as **`quota_exhausted/open`**, while the **free** routes stayed
**healthy**. The upstream **HTTP 402** response is mapped to **`quota_exhausted`**
in **`route-failure.ts`**. The only defensible conclusion is upstream **paid
quota / credit exhaustion**: this gives **no** evidence that the OpenRouter +
OpenCode client combination is broken, so the earlier blanket fail-close stays
**withdrawn**. Paid routes remain **supported**; their successful calls are
blocked by quota, and they were **not retried**.

**Submission count disclosed honestly.** The validator actually submitted
**three independent Tasks** across **three isolated daemons** —
**`task_e5dabde6`**, **`task_61e1a856`** and **`task_c43d3e9e`** — each with
**only one attempt**. This must **not** be described as a single call.

**Credential handling.** The isolated daemon referenced the existing credential
directory **only** through a temporary `providers` directory **symlink** and read
it **internally**; the operator did **not** open, read, copy or print any key, and
wrote **no** shared configuration.

This is a real paid-route Task attempt, **not** a full-chain acceptance success:
the four-condition free automatic-eligibility rule, the recorded measured-TPS
provenance, and the separate unauthorized-push record in the handoff document all
remain as documented. **No** full-chain (chat + Task + auxiliary) success is
claimed here.

### Coordinator confirmation with a real key

With a **real** OpenRouter key configured in a provider, the coordinator should
confirm each link end to end:

1. **Chat** — select one of the three rows in the model picker and complete a
   real generation.
2. **Actual Task** — only once intelligence and speed evidence exist for the
   target route, dispatch a real Task and confirm the chosen
   `openrouter/<wire-id>:<client>` target and a successful run.
3. **Auxiliary selection / call** — trigger an auxiliary call and confirm it
   selects and calls the route (or state why it is still excluded for missing
   intelligence/speed).
4. **Exhaustion / failure gating** — drive the free pool to exhaustion or a call
   failure and confirm the route is dropped from further **automatic** dispatch
   (open route, or half-open with a future probe).
5. **Recovery** — after the route recovers (the Gateway's due half-open probe
   succeeds), confirm it is admitted again without a daemon restart.

## Verification (2026-10-15, verified base `d41b15bc4429dea98d98404f0bf32810a3333ea7`)

Results recorded on the final rebased base
`d41b15bc4429dea98d98404f0bf32810a3333ea7` (2026-10-15). The worktree was first
verified on `ba19f228a144dd6dbfc253c6fa18ca7a3b11b904`, then rebased onto the
newer `origin/main` and rechecked here. The single upstream commit in between,
`fix(session): run dispatched tasks in the worktree the intent names`, touches
session dispatch only — not the model registry, the provider catalog, or the
picker projection.

- `pnpm lint` (oxlint + root `tsc --noEmit` + desktop `tsc -b`) exited **0**.
- `pnpm build` exited **0**.
- An isolated source daemon's `provider.list`, its gateway catalog, and the real
  `apps/desktop/src/session/model-entries.ts` picker projection all included the
  three selected rows — `openrouter/nvidia/nemotron-3-ultra-550b-a55b:free`,
  `openrouter/nvidia/nemotron-3.5-lightning:free`, and
  `openrouter/nvidia/nemotron-3-super-120b-a12b:free` — with `free: true`,
  pricing **absent**, the expected canonical id, context/output
  (1,000,000/65,536; 1,000,000/65,536; 262,144/235,929), and
  `reasoningEfforts: ['default']`, with **no projection warnings**.

These checks used **dummy placeholder credentials only**, so they verify
**catalog and selector projection**, not **authenticated inference**. The daemon
reported `available: false` on these rows because the dummy key is not admitted
by the credential resolver; `available: false` is **not** live inference
verification either way, and no inference was run. **No browser/UI verification
was run**, and **no automated test cases were added or changed**. The independent
code-review task **timed out with no approved result**, so no review approval is
claimed.

Retained evidence paths:

- `/tmp/wyfreem-lint.log` and `/tmp/wyfreem-build.log` (earlier base)
- `/tmp/wyfreem-final-lint.log` and `/tmp/wyfreem-final-build.log` (final base)
- `/tmp/wyfreem-final-confirm.log` and the retained temp base
  `/tmp/wyfreem-final-2lPoHr` (final base)
- `/tmp/wyfreem-doc-block.log` (the confirmation script below, run verbatim)
- `/tmp/wyfreem-postrebase-Eehqvz` (retained temp base)

## Confirmation procedure (run inside the `wy-freem` worktree)

Copyable commands scoped to the managed worktree (never the main checkout). The
daemon block below is **one bash script** with `set -e` and an **effective EXIT
trap** that kills and waits on the daemon PID it captured, so it cannot leave a
daemon running — not on normal completion, not when the bounded socket wait
times out, and not when a later query fails. The **explicit own-PID kill/wait**
near the end is kept alongside the trap so that users who paste the blocks
interactively still stop only their own daemon. It uses a fresh temporary base
and an isolated **dummy** OpenRouter key that is **projection-only and must never
be used for inference**; `available: false` from that key is projection evidence,
not inference. The temporary base is left in place for inspection and **no
deletion command is used**. The launch block waits (bounded, 60 s) for the IPC
socket before querying: this exact race was reproduced (querying immediately
failed with `connect ENOENT`), and the wait made the documented commands pass.

```bash
cd ~/.local/state/wrenyard/worktrees/wy-freem
pnpm lint && pnpm build
```

```bash
# One bounded bash script: `set -e` plus an effective EXIT trap, so this block
# cannot leave a daemon running.
set -e
BASE=$(mktemp -d)
mkdir -p "$BASE/config/providers" "$BASE/state" "$BASE/home" "$BASE/ipc" "$BASE/workspace"

cat > "$BASE/config/config.json" <<JSON
{ "service": { "enabled": true }, "workspace": { "root": "$BASE/workspace" } }
JSON

# Isolated dummy managed credential: projection only, never used for inference.
cat > "$BASE/config/providers/auth.json" <<'JSON'
{ "openrouter": { "type": "api", "key": "projection-only-not-a-real-key" } }
JSON

# Use the pinned Node shipped with the worktree's dependencies so the daemon
# never runs on a mismatched system runtime; fall back to PATH.
if [ -x "$PWD/node_modules/.bin/node" ]; then
  NODE_BIN="$PWD/node_modules/.bin/node"
else
  NODE_BIN="$(command -v node)"
fi
NODE_DIR="$(dirname "$NODE_BIN")"

# Launch the isolated source daemon; capture its PID.
env -i HOME="$BASE/home" \
  PATH="$NODE_DIR:/usr/bin:/bin:/usr/sbin:/sbin" \
  WRENYARD_CONFIG_HOME="$BASE/config" \
  WRENYARD_STATE_HOME="$BASE/state" \
  WRENYARD_IPC_PATH="$BASE/ipc/wrenyard.sock" \
  "$NODE_BIN" --import tsx apps/daemon/lib/main.mts run --config "$BASE/config/config.json" \
  > "$BASE/daemon.log" 2>&1 &
DAEMON_PID=$!

# Effective EXIT trap: always stop and wait on *this* procedure's own daemon —
# normal completion, the bounded wait below timing out (`exit 1`), or a later
# query failure. The `|| true` guards are required because on macOS bash 3.2 the
# EXIT trap's last command status becomes the script's exit status, which would
# otherwise report a false failure. It affects only this daemon PID and deletes
# nothing (the temporary base is left in place for inspection).
trap 'kill "$DAEMON_PID" 2>/dev/null || true; wait "$DAEMON_PID" 2>/dev/null || true' EXIT

# Bounded socket-readiness wait before querying. The daemon may not have created
# its socket yet; querying immediately was reproduced to fail with `connect
# ENOENT`. Loop up to 60 s, each iteration checking the daemon is alive AND the
# socket exists.
for _ in $(seq 1 60); do
  if ! kill -0 "$DAEMON_PID" 2>/dev/null; then
    echo "ERROR: daemon $DAEMON_PID exited before creating $BASE/ipc/wrenyard.sock" >&2
    exit 1
  fi
  if [ -S "$BASE/ipc/wrenyard.sock" ]; then
    break
  fi
  sleep 1
done
if [ ! -S "$BASE/ipc/wrenyard.sock" ]; then
  echo "ERROR: daemon socket $BASE/ipc/wrenyard.sock did not appear within 60 s" >&2
  exit 1
fi

# Query provider.list + gateway.connection and project the real picker rows.
# `WrenyardIpcClient.gatewayConnection()` returns
# { openaiChatBaseUrl, openaiResponsesBaseUrl, anthropicBaseUrl, token, models }.
WRENYARD_IPC_PATH="$BASE/ipc/wrenyard.sock" "$NODE_BIN" --import tsx --input-type=module -e '
import { WrenyardIpcClient } from "./packages/control/src/index.ts";
import { toModelEntries } from "./apps/desktop/src/session/model-entries.ts";
import { isMainstreamModelId } from "./packages/models/src/mainstream.ts";

const client = new WrenyardIpcClient({ path: process.env.WRENYARD_IPC_PATH });
const result = await client.providerList();
const connection = await client.gatewayConnection();

const expected = [
  ["openrouter/nvidia/nemotron-3-ultra-550b-a55b:free", "nemotron-3-ultra", 1000000, 65536],
  ["openrouter/nvidia/nemotron-3.5-lightning:free", "nemotron-3.5-lightning", 1000000, 65536],
  ["openrouter/nvidia/nemotron-3-super-120b-a12b:free", "nemotron-3-super-120b-a12b", 262144, 235929],
];

const warnings = [];
const entries = toModelEntries(result, connection.models, (m) => warnings.push(m));
const rows = Object.fromEntries(
  result.providers.flatMap((p) => p.models.map((m) => [p.id + "/" + m.id, m])),
);
const byId = Object.fromEntries(entries.map((e) => [e.publicId, e]));

for (const [id, canonical, context, maxOutput] of expected) {
  const row = rows[id];
  const entry = byId[id];
  if (!row) throw new Error("provider.list missing " + id);
  if (!entry) throw new Error("picker projection missing " + id);
  if (row.free !== true) throw new Error(id + " is not free:true");
  if (Object.prototype.hasOwnProperty.call(row, "pricing")) {
    throw new Error(id + " unexpectedly carries a pricing key");
  }
  if ((row.canonicalId ?? row.id) !== canonical) {
    throw new Error(id + " canonicalId mismatch");
  }
  if (row.contextWindow !== context || row.maxTokens !== maxOutput) {
    throw new Error(id + " context/output mismatch");
  }
  if (JSON.stringify(row.reasoningEfforts) !== JSON.stringify(["default"])) {
    throw new Error(id + " reasoningEfforts mismatch");
  }
  if (!isMainstreamModelId(canonical)) {
    throw new Error(canonical + " is not mainstream");
  }
  console.log(
    id,
    "free=" + row.free,
    "available=" + row.available,
    "pricing=absent",
    "displayName=" + entry.displayName,
    "context=" + entry.contextWindow,
    "maxOutput=" + entry.maxOutputTokens,
    "runtime=" + entry.runtime,
  );
}
console.log("projectionWarnings=" + warnings.length);
client.close();
'

# Explicit own-PID stop/wait for users who paste the blocks interactively; the
# EXIT trap above also covers this when the whole script runs as one file.
kill "$DAEMON_PID" 2>/dev/null || true
wait "$DAEMON_PID" 2>/dev/null || true
```

The coordinator's real UI confirmation requires a provider configured with a
**real** OpenRouter key; the dummy key above proves projection only and must
never be used for inference. Published catalog availability is not successful
inference, and no inference was run for this change.
