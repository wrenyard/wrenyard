# Main Reasoning Retry and Circuit Contract

> Created: 2026-10-15
> Status: designed

## Purpose

This specification defines the one contract that relates the session transport's
same-route retry for main reasoning to the Gateway's local circuit breaking. It
replaces the previously deferred "retry/backoff/circuit policy" statement and
settles a design-level gap: a main reasoning call spent its whole retry budget on
Gateway admission refusals during a route cooldown, so a single upstream timeout
turned into four useless attempts and the user saw repeated failed turns.

The contract covers only the `reason` role (main reasoning). Auxiliary roles
keep their existing no-retry, cross-route failover policy and are out of scope.

## Definitions

- **Turn**: one accepted user send. Exactly one user turn exists per accepted
  send, regardless of how many upstream requests that turn makes. A turn is the
  unit the user sees and can interrupt; it never multiplies with model attempts.
- **Logical main model call**: one `ModelTransport.complete` invocation for the
  `reason` role. Its retry loop and its bounded recovery budget are per this one
  call, not per turn and not per upstream request.
- **Upstream attempt**: one real HTTP request that reached (or tried to reach)
  the supplier. Only an upstream attempt consumes the retry count.
- **Admission refusal**: the local Gateway circuit declining a request before any
  upstream traffic. It is not an upstream attempt and not an upstream failure.

## Contract

### (a) One accepted send is one turn

One accepted user send creates exactly one turn. Internal retries, recovery
waits and admission refusals happen inside that turn's main model call and never
create additional turns or dispatches. The turn's append-only ledger and its
completed task results are retained across the whole call.

### (b) Retry budget for genuine upstream failures

The transport is the sole retry owner. A genuine retryable upstream failure — a
connection error, timeout, pre-output stream break, or HTTP 408/409/429/5xx —
retries with the existing exponential backoff: after the initial request, up to
four retries (`2s × 2^(n−1)` → 2, 4, 8, 16 seconds), each multiplied by a
0.75–1.0 jitter. So one logical main model call issues at most five real
upstream requests for genuine upstream failures. When such a failure carried a
valid `Retry-After` hint and the upstream retry count is then exhausted, the
terminal failure still carries that hint's absolute `retryAt`, so the caller
keeps the recovery instant instead of losing it.

### (c) Admission refusal is a distinct, non-upstream outcome

A Gateway-local circuit admission refusal is its own outcome, separate from any
upstream failure:

- It never consumes the upstream retry count. Repeated refusals do not spend the
  four upstream retries.
- It never marks or extends a route cooldown. The Gateway's admission path
  records no fault, calls neither `mark`/`markAttemptFault` nor `success`, and
  leaves the circuit's `until`/`nextProbeAt` unchanged.
- It is surfaced to the transport as a structured, machine-readable marker, not
  matched from response text.

The Gateway remains the atomic admission authority for races; the session's own
route-health read is an optimization, never the decision.

### (d) Retry-After is respected at any length

A valid `Retry-After` hint is honoured whether it is expressed in seconds, as an
HTTP date, or as milliseconds, and whether it is shorter or longer than 60
seconds. The transport keeps the hint as an absolute not-before instant and
never retries before it. Hints above 60 seconds are no longer discarded.

A syntactically numeric hint that overflows, or a very large finite one, is
normalized to a finite, representable instant that stays conservatively beyond
any recovery budget: it is never collapsed to a 1-second hint, never dropped to
the exponential-backoff path, and never an invalid `Date`/`RangeError`. A
missing or non-numeric hint still yields no hint and keeps the ordinary backoff.

### (e) Bounded, abortable recovery waiting

A recovery wait — for an admission refusal or an adopted not-before hint — is
bounded and abortable:

- The session's route-health read is re-checked **before every actual attempt** —
  the initial one and each one that follows a wait — inside this same loop and
  the same budget, so a route that entered or extended its cooldown between
  attempts is waited out here rather than probed early and refused.
- The maximum cumulative recovery wait is **5 minutes per logical main model
  call**. Repeated admission refusals draw on the same budget and never reset it.
- When the advertised wait would exceed the remaining bound, the call stops and
  returns **one explicit recoverable failure carrying `retryAt`**; it never
  probes early and never burns the rest of the budget on refusals.
- A missing, invalid or already-past hint yields a safe, bounded minimum delay,
  so the caller never spins.
- A cancellation aborts any wait immediately, and is checked both before the
  route-health read and before the request is issued.

### (f) No replay after output or cancellation

Once output has started (text, reasoning or a tool-call fragment), no retry,
recovery wait or replay occurs. A cancellation likewise forbids any further
attempt. This matches the historical transport rule "已输出不重放".

### (g) No alternate-model substitution for main reasoning

Main reasoning always keeps the model the user selected. The contract never
substitutes another model to route around a cooldown. Auxiliary roles keep their
existing `noRetry` flag and their bounded cross-route failover under the existing
auxiliary policy; this specification does not change them.

### (h) Manual continue during a waiting recovery

A continue after a prior terminal failure may create exactly one user turn that
waits. While that turn is waiting in bounded recovery, repeated same
continuations create no extra turns or dispatches (see the dedup guard below).
Independent concurrent turns are unaffected.

### (i) Deliberate deviation: one local-only admission metadata channel

This contract intentionally introduces a narrow, Gateway-local, structured
admission-metadata channel. That deviates from two statements in the historical
transport design:

- the earlier "no private response header / no Gateway private metadata"
  statement, and
- the earlier "adopt a Retry-After hint only when it is at or below 60 seconds"
  statement.

The deviation is deliberately narrow: the metadata channel is local-only (it is
never forwarded upstream and is never an echoed upstream header), it carries only
a refusal discriminant, the circuit phase, the route fault kind and the absolute
earliest probe instant, and it exists solely so a caller can tell a local
admission refusal apart from a real upstream fault without parsing text. It
deviates from the historical workspace transport design
`2026-10-10-session-model-transport` (“会话模型传输层：统一调用协议与重试”),
which lives in the workspace specifications rather than in this repository and is
therefore referenced here by id and title, not by a repository-relative link.

## Implementation mapping

- Shared wire boundary: `packages/providers/src/base/gateway-wire.ts` owns the
  `x-wrenyard-admission` header name and the `GatewayAdmissionRefusal` type plus
  its parser.
- Gateway: `packages/features/gateway/src/pipeline.ts` attaches the structured
  refusal (with the absolute earliest probe instant) on the blocked-admission
  path; it still records no fault and does not touch the cooldown.
- Transport contracts: `packages/features/session/src/transport/protocol.ts`
  adds the failure-source distinction, the `wait` event and the main-reasoning
  route-health `preflight` hook.
- Error normalization: `packages/features/session/src/transport/errors.ts`
  preserves the admission distinction and the `retryAt`, accepts `Retry-After`
  of any length as an absolute not-before, floors invalid/past hints, caps an
  overflowing or very large hint at a finite instant that stays beyond budget
  (never a 1-second hint, never an invalid `Date`/`RangeError`), and populates
  `retryAt` from a genuine upstream hint even without an admission marker — the
  admission marker keeps precedence with its separate `source: 'admission'`.
- Retry loop: `packages/features/session/src/transport/retry.ts` keeps the
  upstream retry count and jitter, re-reads route health before every actual
  attempt, and carries the bounded 5-minute abortable recovery wait in the one
  budget with no second nested retry owner.
- Session entry: `packages/features/session/src/transport/index.ts` emits the
  typed `wait`/`retry` events and carries the distinction through the final
  failure.
- Main reasoning runner: `packages/features/session/src/model/request.ts` reads
  route health before real attempts, suspends/re-arms the 180-second reason idle
  deadline around a bounded wait, and populates `retryAt` on a terminal
  bounded-wait failure.
- Live waiting status: `packages/features/session/src/ledger/events.ts` adds the
  additive, observational `turn.waiting` event, kept out of the model context;
  `packages/features/session/src/turn/turn.ts` records it and exposes/clears the
  engine's live waiting marker. The Desktop `TurnActivity`, rendered by
  `SessionPage` from the session feed, shows the Chinese waiting copy with the
  exact local `HH:MM:SS` probe time and keeps the interrupt control available.
  It clears on the next actual attempt, on completion and on cancel, with no
  local timer.
- Duplicate continuation: `packages/features/session/src/turn/engine.ts` guards a
  repeated identical continue of the same selected model while a turn is waiting,
  backed by a narrow pending-send latch that also covers two rapid identical
  sends before the recovery marker exists; the Desktop `Composer` adds a
  synchronous submit latch released on every exit path.

Code, comments, logs and this specification stay English. User-facing UI copy
stays Chinese.

## Acceptance scenarios

1. **Timeout → cooldown → successful probe in the same call/turn.** An upstream
   timeout faults the route; the next attempt is refused locally; the transport
   waits out the cooldown and probes once it is due, all inside one turn.
2. **Automatic cooldown wait.** With no user action, the main call waits out a
   route cooldown and recovers without failing the turn.
3. **Manual cooldown wait.** A user continue during a cooldown creates one turn
   that waits and shows the waiting status with the next probe time.
4. **Repeated clicks dedup.** Two continue clicks (or a double click) while a
   turn is waiting create no second turn or dispatch.
5. **Half-open success and failure.** A probe admitted at the cooldown's end
   either restores the route (success) or re-faults it (failure) without
   multiplying turns.
6. **Cancellation while waiting and while probing.** Cancelling during a bounded
   wait or during a probe aborts immediately, with no further attempt and no
   synthetic fault.
7. **No alternate route.** Main reasoning never switches to another model to
   avoid a cooldown.
8. **Hints above 60 seconds, above the budget, and overflowing.** A `Retry-After`
   longer than 60 seconds is honoured; one longer than the remaining recovery
   budget ends the call with a recoverable failure carrying `retryAt` and no
   early probe; a numeric hint that overflows, or an absurdly large finite one,
   normalizes to that same beyond-budget outcome instead of a 1-second wait or a
   `RangeError`.
9. **Bounded repeated refusals.** Repeated admission refusals share one 5-minute
   budget and never reset it or consume upstream retries.
10. **No replay after output.** A failure after output has started is never
    retried, waited out or replayed.
11. **Completed task context retained.** Completed action/task results survive a
    recovery wait and are not repeated or dropped.

## Evidence boundary

- The ledger of the reported session (`b6b41816-d8a0-40ed-a135-d5a47650bad0` on
  device `SHENYIXU-PC2`) is on a remote machine and is **not available locally**;
  this specification does not reconstruct it.
- The provided screenshots only confirm an **HTTP 503 with a timeout circuit
  open** at **2026-10-15T10:17:03.612Z**. They do **not** prove that admission
  refusals extend the cooldown — the source shows a refusal records no fault and
  does not change the cooldown, so the observed escalation is not attributed to
  refusals here.
- The JSON-output failure and the search permission limitation mentioned in the
  same report are unrelated to this root cause and are excluded.
