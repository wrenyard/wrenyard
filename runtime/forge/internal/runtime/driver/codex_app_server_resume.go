package driver

import (
	"fmt"
	"strings"
)

// Resume usage accounting for Codex 0.148 app-server.
//
// A resumed thread (thread/resume) is NOT streamed with experimentalRawEvents:
// the peer never emits rawResponse/completed, so the fresh-run usage path has
// nothing to accumulate. Instead the server emits thread/tokenUsage/updated,
// which carries the thread's cumulative `total` and the most recent response's
// `last` breakdown:
//
//	{"tokenUsage":{"total":{"inputTokens":..,"cachedInputTokens":..,"outputTokens":..},
//	               "last":{ same fields }}}
//
// On resume the server replays the status of the PREVIOUS turn once, so the
// first notification of that shape belongs to an already-finished turn (its
// turnId is the old turn) and only establishes the baseline. A notification for
// the ACTIVE turn is then measured against that baseline.
//
// The turn's usage is therefore the DELTA of `total` against the baseline, and
// that delta must equal the notification's own `last` breakdown. Only when both
// agree is the increment defensible; otherwise nothing is accounted and the
// open sampling window is reset rather than paired with a partial figure. The
// TPS sample uses the same tokenizer_v1 measurement as the fresh path: the
// fixed-tokenizer count of the response's observed generation over the window
// from its first to its last non-empty delta, with the notification's exact
// `last` figures reserved for official usage only. A second speed metric is
// deliberately not introduced.

// codexResumeTotals is one thread token-usage breakdown. The field names match
// the native camelCase payload.
type codexResumeTotals struct {
	Input  int64
	Cached int64
	Output int64
	Total  int64
}

// codexResumeUsageState is the per-bridge resume accounting window.
type codexResumeUsageState struct {
	// armed is set by a resumed thread/resume handshake. Nothing is accounted
	// while it is false, so a fresh run is untouched.
	armed bool

	// haveBaseline records that the first observed thread total was captured as
	// this turn's starting point.
	haveBaseline bool
	baseline     codexResumeTotals
}

// newCodexResumeUsageState starts a disabled window; armResumeUsage enables it
// only for a resumed thread.
func newCodexResumeUsageState() codexResumeUsageState {
	return codexResumeUsageState{}
}

// armResumeUsage enables resume accounting and records the active turn id.
func (b *codexAppServerBridge) armResumeUsage() {
	b.resumeUsage.armed = true
	b.resumeUsage.haveBaseline = false
	b.resumeUsage.baseline = codexResumeTotals{}
}

// handleTokenUsageUpdated translates one thread/tokenUsage/updated
// notification. It is a no-op unless the run is an armed resume.
func (b *codexAppServerBridge) handleTokenUsageUpdated(params map[string]any) {
	if !b.resumeUsage.armed {
		return
	}
	// The notification must clearly belong to the resumed thread. A foreign
	// thread never enters the window at all.
	if !b.withinResumeThread(params) {
		return
	}
	if b.turnID != "" && !b.withinResumeTurn(params) {
		return
	}
	totals, ok := codexResumeTotalsFrom(params)
	if !ok {
		// An unusable total can not be reconciled against `last`; drop the
		// window's timing defensively rather than pairing a partial figure.
		b.resumeUsage.haveBaseline = false
		b.finishResponse()
		return
	}

	if !b.resumeUsage.haveBaseline {
		// The first notification of a resume replays the PREVIOUS turn: it only
		// establishes the baseline and is never accounted or sampled. An
		// active-turn notification arriving with no baseline to measure from
		// has no defensible increment either, so its total becomes the
		// baseline rather than counting the whole turn from zero.
		b.resumeUsage.baseline = totals
		b.resumeUsage.haveBaseline = true
		b.responseWindow = codexDeltaWindow{}
		return
	}

	if b.resumeUsageSeenTotalSatisfied(totals) {
		return
	}
	if !b.withinResumeTurn(params) {
		return
	}

	last, ok := codexResumeLastFrom(params)
	if !ok {
		// A missing or malformed `last` leaves the increment unjustified.
		b.resumeUsage.haveBaseline = false
		b.finishResponse()
		return
	}

	expected := subtractResumeTotals(totals, b.resumeUsage.baseline)
	if !expected.equal(last) {
		// Missing/mismatched totals: a partial increment must never be
		// combined with the whole turn's tokens, so account nothing, omit the
		// sample, and reset the window.
		b.resumeUsage.haveBaseline = false
		b.finishResponse()
		return
	}

	b.resumeResponseUsage(last)
	b.recordResumeSample()
	b.finishResponse()

	// The baseline advances past the response just counted, so the next
	// notification is measured from here.
	b.resumeUsage.baseline = totals
	b.resumeUsageSeenTotal = &totals
}

// withinResumeThread reports whether a usage notification belongs to the active
// thread. The thread identity is mandatory.
func (b *codexAppServerBridge) withinResumeThread(params map[string]any) bool {
	thread := codexThreadIdentity(params)
	return thread != "" && b.threadID != "" && thread == b.threadID
}

// withinResumeTurn reports whether a usage notification belongs to the active
// thread AND turn. Missing and foreign turn identities are rejected.
func (b *codexAppServerBridge) withinResumeTurn(params map[string]any) bool {
	if b.turnID == "" {
		return false
	}
	turn := codexTurnIdentity(params)
	return turn != "" && turn == b.turnID
}

// resumeUsageSeenTotalSatisfied reports whether a total was already accounted,
// so a retransmitted notification is ignored instead of double counted.
func (b *codexAppServerBridge) resumeUsageSeenTotalSatisfied(totals codexResumeTotals) bool {
	return b.resumeUsageSeenTotal != nil && *b.resumeUsageSeenTotal == totals
}

// resumeResponseUsage adds one notification's exact `last` breakdown to the
// current turn's usage window. Only numeric nonnegative fields were accepted by
// the caller, so this never fabricates a token count.
func (b *codexAppServerBridge) resumeResponseUsage(last codexResumeTotals) {
	b.responseInputTokens += last.Input
	b.responseOutputTokens += last.Output
	b.responseCachedTokens += last.Cached
	b.responseUsageObserved = true
}

// recordResumeSample closes the current response's observed generation into
// one tokenizer_v1 sample through the same helper the fresh path uses, so a
// resumed response and a fresh response make identical claims. The response id
// is a stable synthetic id so a resumed response can never collide with a real
// upstream response id.
func (b *codexAppServerBridge) recordResumeSample() {
	b.recordResponseSample(codexResumeResponseID(b.threadID, b.turnID, b.responseSeq+1))
}

// codexResumeResponseID builds the stable synthetic response id of one resumed
// response: thread, turn, and the 1-based sequence of the response within the
// turn.
func codexResumeResponseID(threadID, turnID string, sequence int) string {
	return fmt.Sprintf("%s/%s/%d", strings.TrimSpace(threadID), strings.TrimSpace(turnID), sequence)
}

// codexResumeTotalsFrom reads the cumulative thread breakdown from a usage
// notification. Every field must be present and numeric nonnegative.
func codexResumeTotalsFrom(params map[string]any) (codexResumeTotals, bool) {
	usage, _ := params["tokenUsage"].(map[string]any)
	if usage == nil {
		return codexResumeTotals{}, false
	}
	total, _ := usage["total"].(map[string]any)
	return codexResumeBreakdown(total)
}

// codexResumeLastFrom reads the most recent response breakdown, which must also
// be present and numeric nonnegative.
func codexResumeLastFrom(params map[string]any) (codexResumeTotals, bool) {
	usage, _ := params["tokenUsage"].(map[string]any)
	if usage == nil {
		return codexResumeTotals{}, false
	}
	last, _ := usage["last"].(map[string]any)
	return codexResumeBreakdown(last)
}

// codexResumeBreakdown reads one input/cached/output/integer breakdown. A
// missing, non-numeric, or negative field makes the whole breakdown unusable.
func codexResumeBreakdown(source map[string]any) (codexResumeTotals, bool) {
	if source == nil {
		return codexResumeTotals{}, false
	}
	input, ok := resumeTokenField(source, "inputTokens", "input_tokens")
	if !ok {
		return codexResumeTotals{}, false
	}
	cached, ok := resumeTokenField(source, "cachedInputTokens", "cached_input_tokens")
	if !ok {
		return codexResumeTotals{}, false
	}
	output, ok := resumeTokenField(source, "outputTokens", "output_tokens")
	if !ok {
		return codexResumeTotals{}, false
	}
	total, ok := resumeTokenField(source, "totalTokens", "total_tokens")
	if !ok {
		return codexResumeTotals{}, false
	}
	return codexResumeTotals{Input: input, Cached: cached, Output: output, Total: total}, true
}

// resumeTokenField reads one numeric nonnegative integer field. An absent,
// non-numeric, or negative entry is reported as unusable.
func resumeTokenField(source map[string]any, keys ...string) (int64, bool) {
	for _, key := range keys {
		raw, present := source[key]
		if !present {
			continue
		}
		return safeResponseOutputTokens(raw)
	}
	return 0, false
}

// subtractResumeTotals returns the per-field increment. The caller has already
// established that the totals are nonnegative; a negative increment is still
// treated as a mismatch by equal, so a non-monotonic total is never counted.
func subtractResumeTotals(after, before codexResumeTotals) codexResumeTotals {
	return codexResumeTotals{
		Input:  after.Input - before.Input,
		Cached: after.Cached - before.Cached,
		Output: after.Output - before.Output,
		Total:  after.Total - before.Total,
	}
}

// equal reports whether two breakdowns are identical field by field.
func (t codexResumeTotals) equal(other codexResumeTotals) bool {
	return t.Input == other.Input && t.Cached == other.Cached && t.Output == other.Output && t.Total == other.Total
}
