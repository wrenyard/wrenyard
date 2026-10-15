# Free mainstream models: research and acceptance note (2026-10-15)

Research date: **2026-10-15**. All sources below were retrieved on that date.
This note records selection decisions, exact identifiers, and the intended
confirmation procedure. It is a research note: **no inference was run**, and
published catalog availability is not the same as a successful generation.

## Scope

Curate currently available **free** offerings into the mainstream model list so
they become selectable in the model picker with truthful metadata. Tasks and
auxiliary-selection integration is **deferred** to a later item.

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
