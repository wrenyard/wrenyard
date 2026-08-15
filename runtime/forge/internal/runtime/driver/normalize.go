package driver

import (
	"bytes"
	"encoding/json"
	"fmt"
	"hash/fnv"
	"io"
	"math"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/protocol"
)

const (
	inputSummaryMaxBytes = 512
	outputTailMaxBytes   = 2 * 1024
)

// Trusted agent-turn TPS contract. Every comparable client family emits
// exactly one turn_usage for one agent turn carrying these three additive
// fields: token_scope and duration_scope declare the statistical universe
// (one agent turn), and tps_contract pins the formula that Foreman applies to
// the current-invocation token counts and the current agent-turn wall duration.
const (
	tokenScopeAgentTurn    = "agent_turn"
	durationScopeAgentTurn = "agent_turn"
	tpsContractAgentTurnV1 = "agent_turn_v1"
)

// trustedContractFields is the full additive field set the agent_turn_v1
// contract owns. Removing every one of them is how a turn_usage fails closed
// so untrusted usage can never feed the TPS formula.
var trustedContractFields = []string{"token_scope", "duration_scope", "tps_contract"}

// applyTrustedAgentTurnContract attaches the explicit agent_turn_v1 TPS
// contract scope fields to a turn_usage data map. It is the single shared
// helper used identically by the Claude result, native Codex turn.completed,
// the CodeBuddy canonical turn_usage, and the valid successful Grok canonical
// usage.
func applyTrustedAgentTurnContract(data map[string]any) {
	data["token_scope"] = tokenScopeAgentTurn
	data["duration_scope"] = durationScopeAgentTurn
	data["tps_contract"] = tpsContractAgentTurnV1
}

// removeTrustFields deletes every trusted agent_turn_v1 contract field from a
// turn_usage event so untrusted or unvetted usage preserves its metadata
// without any statistical claim.
func removeTrustFields(event *protocol.Event) {
	if event == nil || event.Type != "turn_usage" || event.Data == nil {
		return
	}
	clearTrustedAgentTurnContract(event.Data)
}

// clearTrustedAgentTurnContract removes the full versioned trust claim from a
// usage data map while preserving its raw token and duration metadata.
func clearTrustedAgentTurnContract(data map[string]any) {
	for _, key := range trustedContractFields {
		delete(data, key)
	}
}

// completeUsageTokens returns input/output token counts only when both native
// usage fields are present, integral, and nonnegative.
func completeUsageTokens(usage map[string]any) (int, int, bool) {
	input, okIn := nonnegativeInt(usage["input_tokens"])
	output, okOut := nonnegativeInt(usage["output_tokens"])
	if !okIn || !okOut {
		return 0, 0, false
	}
	return input, output, true
}

// nonnegativeInt returns a nonnegative whole integer from any JSON-numeric
// representation, rejecting negative, fractional, or non-numeric values.
func nonnegativeInt(raw any) (int, bool) {
	switch v := raw.(type) {
	case int:
		if v >= 0 {
			return v, true
		}
	case int64:
		if v >= 0 {
			return int(v), true
		}
	case float64:
		if v >= 0 && v == float64(int(v)) {
			return int(v), true
		}
	case json.Number:
		if n, err := v.Int64(); err == nil && n >= 0 {
			return int(n), true
		}
	}
	return 0, false
}

// addUsageTokens adds two nonnegative token counts with overflow-safe
// addition so a hostile transcript can never wrap a sum into a small value.
func addUsageTokens(a, b int) (int, bool) {
	if b > math.MaxInt-a {
		return 0, false
	}
	return a + b, true
}

type TranscriptTee struct {
	clientFamily string
	log          io.Writer
	eventHandler func(protocol.Event)

	mu            sync.Mutex
	buf           []byte
	grokStream    grokStreamTracker
	grokFinalized bool
	grokValidity  GrokStreamValidity

	// grokUsage is the buffered last/best usage candidate for the native Grok
	// stream. Grok streaming-json emits early native usage records, per-response
	// usage, then one final end aggregate; the Tee emits exactly one canonical
	// turn_usage at finalization so TOKEN accounting is never doubled. The
	// candidate is last-wins so a valid stream's canonical record is the final
	// end aggregate without summing cumulative records.
	grokUsage map[string]any
	// grokRunFinished buffers the normalized terminal events until finalization
	// so the single canonical turn_usage is emitted before the terminal event.
	grokRunFinished []protocol.Event
	// grokMessage buffers native text deltas until the response boundary. Grok
	// streaming-json emits one `text` record per token/subword; forwarding each
	// record as a normalized message makes transcript consumers render one card
	// per fragment. Native usage/tool/terminal records provide deterministic
	// boundaries, so the exact text (including leading whitespace) can be
	// reconstructed without client-specific word heuristics.
	grokMessage strings.Builder
	// grokTurnStarted marks the monotonic interval start at the first observed
	// native Grok record so a valid successful stream can carry a trustworthy
	// measured agent_turn duration to finalization.
	grokTurnStarted time.Time

	// now is the monotonic-capable clock used to measure native Codex agent
	// turn intervals. It is injectable so tests can drive deterministic time.
	now func() time.Time
	// codexTurnStarted and codexTurnState track the pending native Codex
	// turn.started boundary so a matching turn.completed can emit a trusted
	// agent-turn duration when Codex omits duration_ms. The explicit state
	// keeps idle, active, and poisoned sequences distinct so measurement can
	// never be re-enabled inside a malformed sequence.
	codexTurnStarted time.Time
	codexTurnState   codexTurnTimingState

	// codebuddyUsageInput/Output sum the current child invocation's native
	// assistant.message.usage tokens. CodeBuddy's result.usage is cumulative
	// and resets after compaction, and the runner's result usage is cumulative
	// on resume; only assistant message usage scoped to this invocation is a
	// truthful token source.
	codebuddyUsageInput    int
	codebuddyUsageOutput   int
	codebuddyUsageSeen     bool
	codebuddyUsageInvalid  bool
	codebuddyUsageOverflow bool
	// codebuddyCanonical guards the at-most-one canonical turn_usage emission
	// for a terminal result; a later duplicate terminal never emits a second.
	codebuddyCanonical bool
	// codebuddyTerminalOK and codebuddyTerminalMs hold the last observed
	// terminal result's success and validated positive native duration so the
	// canonical turn_usage can replace the terminal cumulative token totals.
	codebuddyTerminalOK   bool
	codebuddyTerminalMs   int
	codebuddyTerminalSeen bool

	// opencode usage aggregation: OpenCode emits one step_finish per model
	// step, so per-step turn_usage records are summed across the current child
	// invocation and exactly one aggregated turn_usage is emitted at
	// finalization. opencodeTurnStarted marks the first observed native record
	// so a positive whole-millisecond measured wall duration can establish the
	// agent_turn_v1 contract when the summed tokens are complete.
	opencodeUsageInput     int
	opencodeUsageOutput    int
	opencodeUsageReasoning int
	opencodeUsageTotal     int
	opencodeUsageSeen      bool
	opencodeUsageInvalid   bool
	opencodeUsageOverflow  bool
	opencodeTurnStarted    time.Time
	opencodeFinalized      bool
}

// codexTurnTimingState is the explicit lifecycle of a native Codex
// turn.started..turn.completed measurement. idle means no boundary is pending;
// active means a single trusted turn.started is being measured; poisoned means
// a duplicate/out-of-order start was observed and the whole sequence is
// untrusted until a terminal turn.completed or turn.failed resets to idle.
type codexTurnTimingState int

const (
	codexTurnTimingIdle codexTurnTimingState = iota
	codexTurnTimingActive
	codexTurnTimingPoisoned
)

// GrokAttemptTrust is the single trust classification consumed by execution.
// Native stream parsing produces the first four values; execution promotes any
// child/process/start error to GrokTrustChildProcessError before deciding
// whether durable session state may be replaced.
type GrokAttemptTrust string

const (
	GrokTrustCompleteSuccess       GrokAttemptTrust = "trustworthy_complete_success"
	GrokTrustCompleteNativeFailure GrokAttemptTrust = "trustworthy_complete_native_failure"
	GrokTrustCancelled             GrokAttemptTrust = "cancelled"
	GrokTrustInvalidOrIncomplete   GrokAttemptTrust = "malformed_truncated_incomplete_duplicate_or_non_final"
	GrokTrustChildProcessError     GrokAttemptTrust = "child_process_or_start_error"
)

// GrokStreamValidity is the finalized native-stream trust result. Checked is
// true only for a finalized Grok streaming-json transcript.
type GrokStreamValidity struct {
	Checked bool
	Trust   GrokAttemptTrust
}

func (v GrokStreamValidity) IsValid() bool {
	return v.Checked && v.Trust == GrokTrustCompleteSuccess
}

func (v GrokStreamValidity) IsTrustworthyFailure() bool {
	return v.Checked && v.Trust == GrokTrustCompleteNativeFailure
}

type grokStreamTracker struct {
	records          int
	terminals        int
	terminalTrust    GrokAttemptTrust
	terminalPosition int
	malformed        bool
}

func NewTranscriptTeeWithEventHandler(clientFamily string, log io.Writer, eventHandler func(protocol.Event)) *TranscriptTee {
	return &TranscriptTee{
		clientFamily: clientFamily,
		log:          log,
		eventHandler: eventHandler,
		now:          time.Now,
	}
}

func (t *TranscriptTee) Write(p []byte) (int, error) {
	t.mu.Lock()
	defer t.mu.Unlock()

	if len(p) == 0 {
		return 0, nil
	}
	if _, err := t.log.Write(p); err != nil {
		return 0, err
	}

	t.buf = append(t.buf, p...)
	for {
		idx := bytes.IndexByte(t.buf, '\n')
		if idx < 0 {
			break
		}
		line := t.buf[:idx]
		if len(line) > 0 && line[len(line)-1] == '\r' {
			line = line[:len(line)-1]
		}
		t.processLine(line)
		t.buf = t.buf[idx+1:]
	}
	return len(p), nil
}

// FinalizeGrokStream consumes a complete final JSON record even when it has no
// trailing newline, then returns the native Grok stream validity result. A
// nonempty partial final record is observed as malformed. Other client
// families retain their existing transcript behavior.
func (t *TranscriptTee) FinalizeGrokStream() GrokStreamValidity {
	t.mu.Lock()
	defer t.mu.Unlock()

	if t.clientFamily != "grok" {
		return GrokStreamValidity{}
	}
	if t.grokFinalized {
		return t.grokValidity
	}
	if len(bytes.TrimSpace(t.buf)) > 0 {
		line := t.buf
		if len(line) > 0 && line[len(line)-1] == '\r' {
			line = line[:len(line)-1]
		}
		t.processLine(line)
	}
	t.buf = nil
	t.grokFinalized = true
	t.grokValidity = t.grokStream.result()
	t.flushGrokMessage()
	t.emitCanonicalGrokUsage()
	for _, event := range t.grokRunFinished {
		if t.eventHandler != nil {
			t.eventHandler(event)
		}
	}
	t.grokRunFinished = nil
	return t.grokValidity
}

func (t *TranscriptTee) processLine(line []byte) {
	grokType := ""
	if t.clientFamily == "grok" {
		before := t.grokStream.records
		t.grokStream.observe(line)
		if before == 0 && t.grokStream.records > 0 && t.grokTurnStarted.IsZero() {
			t.grokTurnStarted = t.now()
		}
		grokType = grokNativeRecordType(line)
		if grokType != "" && !isGrokTextChunkType(grokType) {
			t.flushGrokMessage()
		}
	}
	if t.clientFamily == "opencode" && t.opencodeTurnStarted.IsZero() && len(bytes.TrimSpace(line)) > 0 {
		t.opencodeTurnStarted = t.now()
	}
	normalized := normalizeTranscriptLine(t.clientFamily, line)
	if t.clientFamily == "codex" {
		t.observeCodexTurn(line, normalized)
	}
	if t.clientFamily == "codebuddy" {
		t.observeCodeBuddyInvocation(line)
	}
	for _, event := range normalized {
		if event.Type == "" {
			continue
		}
		if t.clientFamily == "grok" {
			switch event.Type {
			case "message":
				if isGrokTextChunkType(grokType) {
					if text, ok := event.Data["text"].(string); ok {
						t.grokMessage.WriteString(text)
					}
					continue
				}
			case "turn_usage":
				// Buffer usage at the Tee layer: exactly one canonical record is
				// emitted at finalization.
				t.observeGrokUsage(line, event)
				continue
			case protocol.EventRunFinished:
				t.grokRunFinished = append(t.grokRunFinished, protocol.Event{Type: event.Type, Data: copyMap(event.Data)})
				continue
			}
		}
		if t.clientFamily == "opencode" && event.Type == "turn_usage" {
			// Aggregate per-step usage: exactly one canonical turn_usage is
			// emitted at finalization with the summed tokens and measured
			// invocation wall duration.
			t.observeOpenCodeUsage(event)
			continue
		}
		if t.clientFamily == "codebuddy" && event.Type == "turn_usage" {
			t.codeBuddyTurnUsage(&event)
		}
		if t.eventHandler != nil {
			t.eventHandler(event)
		}
	}
}

func grokNativeRecordType(line []byte) string {
	var event map[string]any
	if err := json.Unmarshal(line, &event); err != nil {
		return ""
	}
	typ, _ := getString(event, "type")
	return strings.ToLower(strings.TrimSpace(typ))
}

func isGrokTextChunkType(typ string) bool {
	switch typ {
	case "text", "text_delta", "output_text":
		return true
	default:
		return false
	}
}

func (t *TranscriptTee) flushGrokMessage() {
	if t.grokMessage.Len() == 0 {
		return
	}
	text := t.grokMessage.String()
	t.grokMessage.Reset()
	if t.eventHandler != nil {
		t.eventHandler(protocol.Event{
			Type: "message",
			Data: map[string]any{"role": "assistant", "text": text},
		})
	}
}

// observeGrokUsage captures the last/best native usage candidate for the Grok
// stream. An explicit positive native duration_ms on the record is carried
// forward so the canonical emission preserves it instead of replacing it with
// a measured interval.
func (t *TranscriptTee) observeGrokUsage(line []byte, event protocol.Event) {
	if event.Data == nil {
		return
	}
	data := copyMap(event.Data)
	if duration, ok := grokNativeDuration(line); ok {
		data["duration_ms"] = duration
	}
	t.grokUsage = data
}

// emitCanonicalGrokUsage emits the single turn_usage record for a finalized
// Grok stream. On a structurally valid successful stream the final end
// aggregate is canonical and claims the full agent_turn_v1 contract: an
// explicit valid positive native duration_ms is preserved and scoped
// agent_turn, otherwise a positive whole-millisecond monotonic interval from
// the first native record to finalization is attached. Invalid, failed, or
// sub-millisecond streams never fabricate a positive duration or any trust
// field; their best available usage stays unscoped.
func (t *TranscriptTee) emitCanonicalGrokUsage() {
	if t.grokUsage == nil || t.eventHandler == nil {
		return
	}
	data := copyMap(t.grokUsage)
	_, _, completeTokens := completeUsageTokens(data)
	if t.grokValidity.IsValid() {
		if duration, ok := positiveIntDuration(data["duration_ms"]); ok {
			data["duration_ms"] = duration
			if completeTokens {
				applyTrustedAgentTurnContract(data)
			} else {
				clearTrustedAgentTurnContract(data)
			}
		} else {
			delete(data, "duration_ms")
			if !t.grokTurnStarted.IsZero() {
				if elapsed := int(t.now().Sub(t.grokTurnStarted).Milliseconds()); elapsed > 0 {
					data["duration_ms"] = elapsed
					if completeTokens {
						applyTrustedAgentTurnContract(data)
					} else {
						clearTrustedAgentTurnContract(data)
					}
				}
			}
		}
	} else {
		// No trusted duration: drop every trust field. An explicit native
		// duration captured on the candidate is preserved untouched, but no
		// measured or invented value is ever added.
		clearTrustedAgentTurnContract(data)
	}
	// The canonical turn_usage must always carry a nonnegative duration_ms so
	// it passes the structural schema even when no positive interval exists.
	ensureDurationMs(data)
	t.eventHandler(protocol.Event{Type: "turn_usage", Data: data})
}

// ensureDurationMs normalizes data["duration_ms"] to a nonnegative int,
// defaulting to 0 when it is absent, fractional, negative, or non-numeric.
func ensureDurationMs(data map[string]any) {
	switch v := data["duration_ms"].(type) {
	case int:
		if v >= 0 {
			return
		}
	case int64:
		if v >= 0 {
			data["duration_ms"] = int(v)
			return
		}
	case float64:
		if v >= 0 && v == float64(int(v)) {
			data["duration_ms"] = int(v)
			return
		}
	case json.Number:
		if n, err := v.Int64(); err == nil && n >= 0 {
			data["duration_ms"] = int(n)
			return
		}
	}
	data["duration_ms"] = 0
}

// grokNativeDuration extracts an explicit positive native duration_ms from a
// raw Grok record. Grok 1.0.0 does not emit duration; this keeps the canonical
// usage forward-compatible if a future Grok begins providing it.
func grokNativeDuration(line []byte) (int, bool) {
	var event map[string]any
	if err := json.Unmarshal(line, &event); err != nil {
		return 0, false
	}
	return positiveIntDuration(event["duration_ms"])
}

// positiveIntDuration returns a whole positive millisecond value from any
// JSON-numeric representation, rejecting zero, negative, fractional, or
// non-numeric values.
func positiveIntDuration(raw any) (int, bool) {
	switch v := raw.(type) {
	case int:
		if v > 0 {
			return v, true
		}
	case int64:
		if v > 0 {
			return int(v), true
		}
	case float64:
		if v > 0 && v == float64(int(v)) {
			return int(v), true
		}
	case json.Number:
		if n, err := v.Int64(); err == nil && n > 0 {
			return int(n), true
		}
	}
	return 0, false
}

func copyMap(m map[string]any) map[string]any {
	out := make(map[string]any, len(m))
	for k, v := range m {
		out[k] = v
	}
	return out
}

// observeCodeBuddyInvocation tracks the current child invocation's native
// assistant.message.usage records and the terminal result's success/duration
// so a successful terminal turn_usage can be replaced by truthful
// current-invocation sums instead of the cumulative result.usage.
func (t *TranscriptTee) observeCodeBuddyInvocation(line []byte) {
	var event map[string]any
	if err := json.Unmarshal(line, &event); err != nil || event == nil {
		t.codebuddyUsageInvalid = true
		return
	}
	typ, _ := getString(event, "type")
	switch typ {
	case "assistant":
		if t.codebuddyUsageOverflow {
			return
		}
		input, output, present, valid := codeBuddyAssistantUsage(event)
		if !present {
			return
		}
		if !valid {
			t.codebuddyUsageInvalid = true
			return
		}
		sumInput, inOK := addUsageTokens(t.codebuddyUsageInput, input)
		sumOutput, outOK := addUsageTokens(t.codebuddyUsageOutput, output)
		if !inOK || !outOK {
			t.codebuddyUsageOverflow = true
			t.codebuddyUsageInvalid = true
			return
		}
		t.codebuddyUsageInput = sumInput
		t.codebuddyUsageOutput = sumOutput
		t.codebuddyUsageSeen = true
	case "result":
		if t.codebuddyTerminalSeen {
			t.codebuddyUsageInvalid = true
			t.codebuddyTerminalOK = false
			return
		}
		t.codebuddyTerminalSeen = true
		isError, hasIsError := getBool(event, "is_error")
		t.codebuddyTerminalOK = !((hasIsError && isError) || hasNormalizedFailureField(event))
		if ms, ok := positiveIntDuration(event["duration_ms"]); ok {
			t.codebuddyTerminalMs = ms
		} else {
			t.codebuddyTerminalMs = 0
		}
	}
}

// codeBuddyAssistantUsage extracts complete nonnegative input/output token
// counts from a native CodeBuddy assistant.message.usage record. Any missing,
// negative, fractional, or non-numeric field makes the record incomplete.
func codeBuddyAssistantUsage(event map[string]any) (input, output int, present, valid bool) {
	msg, ok := event["message"].(map[string]any)
	if !ok {
		return 0, 0, false, false
	}
	rawUsage, present := msg["usage"]
	if !present {
		return 0, 0, false, false
	}
	usage, ok := rawUsage.(map[string]any)
	if !ok {
		return 0, 0, true, false
	}
	input, output, valid = completeUsageTokens(usage)
	return input, output, true, valid
}

// codeBuddyTurnUsage decides the single turn_usage for a terminal result line.
// On a successful terminal result with at least one complete current-invocation
// usage record and a positive validated native duration, it replaces the
// delegated terminal cumulative tokens with the current-invocation sums and
// claims the full agent_turn_v1 contract. Every other path (missing/incomplete
// usage, error result, invalid or absent duration, overflow, duplicate
// terminal, malformed data) preserves the terminal cumulative metadata but
// removes all trust fields so untrusted usage can never feed TPS.
func (t *TranscriptTee) codeBuddyTurnUsage(event *protocol.Event) {
	if event == nil || event.Data == nil {
		return
	}
	if t.codebuddyUsageSeen && !t.codebuddyUsageInvalid && !t.codebuddyUsageOverflow && t.codebuddyTerminalSeen && t.codebuddyTerminalOK && t.codebuddyTerminalMs > 0 && !t.codebuddyCanonical {
		data := map[string]any{
			"input_tokens":  t.codebuddyUsageInput,
			"output_tokens": t.codebuddyUsageOutput,
			"duration_ms":   t.codebuddyTerminalMs,
		}
		applyTrustedAgentTurnContract(data)
		event.Data = data
		t.codebuddyCanonical = true
		return
	}
	removeTrustFields(event)
}

// observeOpenCodeUsage sums the input/output (and additive reasoning/total)
// tokens from one native step_finish record into the current invocation
// aggregate. Overflow-safe addition prevents a hostile transcript from wrapping
// a sum; incomplete or fractional records mark the invocation invalid.
func (t *TranscriptTee) observeOpenCodeUsage(event protocol.Event) {
	if event.Data == nil {
		return
	}
	t.opencodeUsageSeen = true
	input, okIn := nonnegativeInt(event.Data["input_tokens"])
	output, okOut := nonnegativeInt(event.Data["output_tokens"])
	if !okIn || !okOut {
		t.opencodeUsageInvalid = true
		return
	}
	sumInput, inOK := addUsageTokens(t.opencodeUsageInput, input)
	sumOutput, outOK := addUsageTokens(t.opencodeUsageOutput, output)
	if !inOK || !outOK {
		t.opencodeUsageOverflow = true
		t.opencodeUsageInvalid = true
		return
	}
	t.opencodeUsageInput = sumInput
	t.opencodeUsageOutput = sumOutput
	if reasoning, ok := nonnegativeInt(event.Data["reasoning_output_tokens"]); ok {
		if sum, ok := addUsageTokens(t.opencodeUsageReasoning, reasoning); ok {
			t.opencodeUsageReasoning = sum
		}
	}
	if total, ok := nonnegativeInt(event.Data["total_tokens"]); ok {
		if sum, ok := addUsageTokens(t.opencodeUsageTotal, total); ok {
			t.opencodeUsageTotal = sum
		}
	}
}

// FinalizeOpenCodeStream emits the single aggregated turn_usage for the
// current child invocation once the native stream has ended. It is a no-op for
// non-opencode families and idempotent within one invocation. A final JSON
// record without a trailing newline is consumed before the usage is emitted.
// The agent_turn_v1 trust contract is attached only when complete non-negative
// token sums and a positive whole-millisecond measured wall duration are both
// established; otherwise the usage data is emitted with duration_ms=0 and no
// trust field.
func (t *TranscriptTee) FinalizeOpenCodeStream() {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.clientFamily != "opencode" || t.opencodeFinalized {
		return
	}
	if len(bytes.TrimSpace(t.buf)) > 0 {
		line := t.buf
		if len(line) > 0 && line[len(line)-1] == '\r' {
			line = line[:len(line)-1]
		}
		t.processLine(line)
	}
	t.buf = nil
	t.opencodeFinalized = true
	t.emitCanonicalOpenCodeUsage()
}

func (t *TranscriptTee) emitCanonicalOpenCodeUsage() {
	if !t.opencodeUsageSeen || t.eventHandler == nil {
		return
	}
	data := map[string]any{
		"input_tokens":  t.opencodeUsageInput,
		"output_tokens": t.opencodeUsageOutput,
	}
	if t.opencodeUsageReasoning > 0 {
		data["reasoning_output_tokens"] = t.opencodeUsageReasoning
	}
	if t.opencodeUsageTotal > 0 {
		data["total_tokens"] = t.opencodeUsageTotal
	}
	// duration_ms is always present: a positive whole-millisecond measured
	// invocation wall interval establishes the agent_turn_v1 contract; every
	// other case (invalid/overflow tokens, no start boundary, sub-millisecond
	// interval) carries duration_ms=0 with no trust field.
	data["duration_ms"] = 0
	if !t.opencodeUsageInvalid && !t.opencodeUsageOverflow && !t.opencodeTurnStarted.IsZero() {
		if elapsed := int(t.now().Sub(t.opencodeTurnStarted).Milliseconds()); elapsed > 0 {
			data["duration_ms"] = elapsed
			applyTrustedAgentTurnContract(data)
		}
	}
	t.eventHandler(protocol.Event{Type: "turn_usage", Data: data})
}

// observeCodexTurn tracks the native Codex turn.started boundary and, on the
// matching turn.completed, attaches a trusted measured agent-turn duration to
// the normalized turn_usage event when Codex omits a valid positive
// duration_ms. The interval is measured only between the native turn.started
// and turn.completed events via the injected monotonic-capable clock; pending
// timing is cleared on turn.completed and turn.failed so measurement never
// crosses native turn boundaries or retries. A duplicate start without an
// intervening terminal boundary poisons the sequence: no later start can
// re-enable measurement until a terminal turn.completed or turn.failed resets
// it to idle. Only a whole positive millisecond interval qualifies; a
// sub-millisecond or backward interval never attaches duration_ms or
// duration_scope. An explicit valid positive native duration_ms is preserved
// instead of being replaced.
func (t *TranscriptTee) observeCodexTurn(line []byte, events []protocol.Event) {
	var raw map[string]any
	if err := json.Unmarshal(line, &raw); err != nil {
		return
	}
	typ, _ := getString(raw, "type")
	switch typ {
	case "turn.started":
		switch t.codexTurnState {
		case codexTurnTimingIdle:
			t.codexTurnStarted = t.now()
			t.codexTurnState = codexTurnTimingActive
		case codexTurnTimingActive:
			// A second start without an intervening completed/failed is an
			// out-of-order boundary: poison the sequence until a terminal
			// boundary resets it, so a third start cannot re-enable
			// measurement on an untrusted sequence.
			t.codexTurnStarted = time.Time{}
			t.codexTurnState = codexTurnTimingPoisoned
		case codexTurnTimingPoisoned:
			// Remain poisoned; further starts are ignored.
		}
	case "turn.completed":
		var elapsed time.Duration
		if t.codexTurnState == codexTurnTimingActive {
			elapsed = t.now().Sub(t.codexTurnStarted)
		}
		t.codexTurnStarted = time.Time{}
		t.codexTurnState = codexTurnTimingIdle
		elapsedMs := int(elapsed.Milliseconds())
		if elapsedMs <= 0 {
			return
		}
		for i := range events {
			event := &events[i]
			if event.Type != "turn_usage" {
				continue
			}
			if duration, ok := event.Data["duration_ms"].(int); ok && duration > 0 {
				continue // preserve the explicit valid positive native duration
			}
			event.Data["duration_ms"] = elapsedMs
			if _, _, ok := completeUsageTokens(event.Data); ok {
				applyTrustedAgentTurnContract(event.Data)
			} else {
				clearTrustedAgentTurnContract(event.Data)
			}
		}
	case "turn.failed":
		t.codexTurnStarted = time.Time{}
		t.codexTurnState = codexTurnTimingIdle
	}
}

func (s *grokStreamTracker) observe(line []byte) {
	line = bytes.TrimSpace(line)
	if len(line) == 0 {
		return
	}
	s.records++

	var event map[string]any
	if err := json.Unmarshal(line, &event); err != nil || event == nil {
		s.malformed = true
		return
	}
	typ, ok := getString(event, "type")
	typ = strings.ToLower(strings.TrimSpace(typ))
	if !ok || typ == "" {
		s.malformed = true
		return
	}

	switch typ {
	case "error", "failed", "failure":
		s.terminals++
		s.terminalTrust = GrokTrustCompleteNativeFailure
		s.terminalPosition = s.records
	case "cancelled", "canceled":
		s.terminals++
		s.terminalTrust = GrokTrustCancelled
		s.terminalPosition = s.records
	case "result", "run_finished", "done", "complete", "completed", "end":
		_, trust, terminal := grokTerminalOutcome(typ, event)
		if !terminal {
			s.malformed = true
			return
		}
		s.terminals++
		s.terminalTrust = trust
		s.terminalPosition = s.records
	}
}

func (s grokStreamTracker) result() GrokStreamValidity {
	trust := GrokTrustInvalidOrIncomplete
	if s.records > 0 && !s.malformed && s.terminals == 1 && s.terminalPosition == s.records {
		trust = s.terminalTrust
	}
	return GrokStreamValidity{Checked: true, Trust: trust}
}

func normalizeTranscriptLine(clientFamily string, line []byte) []protocol.Event {
	switch clientFamily {
	case "codex":
		return codexNormalizer(line)
	case "claude":
		return claudeNormalizer(line)
	case "opencode":
		return opencodeNormalizer(line)
	case "codebuddy":
		return codebuddyNormalizer(line)
	case "grok":
		return grokNormalizer(line)
	case "dsh":
		return dshNormalizer(line)
	default:
		return nil
	}
}

func grokNormalizer(line []byte) []protocol.Event {
	var event map[string]any
	if err := json.Unmarshal(line, &event); err != nil {
		return nil
	}
	return grokNormalizerMap(event)
}

func grokNormalizerMap(event map[string]any) []protocol.Event {
	typ, _ := getString(event, "type")
	typ = strings.ToLower(strings.TrimSpace(typ))
	if typ == "assistant" {
		data, _ := json.Marshal(event)
		return claudeNormalizer(data)
	}
	var out []protocol.Event
	if text := grokStreamText(typ, event); text != "" {
		out = append(out, protocol.Event{Type: "message", Data: map[string]any{"role": "assistant", "text": text}})
	}
	if usage := grokUsage(event); len(usage) > 0 {
		out = append(out, protocol.Event{Type: "turn_usage", Data: usage})
	}

	sessionID := grokSessionID(event)
	switch typ {
	case "tool_call":
		callID, _ := getString(event, "toolCallId")
		if strings.TrimSpace(callID) == "" {
			return out
		}
		name, _ := getString(event, "toolName")
		if strings.TrimSpace(name) == "" {
			name, _ = getString(event, "title")
		}
		if strings.TrimSpace(name) == "" {
			name, _ = getString(event, "kind")
		}
		out = append(out, protocol.Event{
			Type: "tool_call",
			Data: map[string]any{
				"name":          name,
				"input_summary": truncateHead(jsonStringValue(event["rawInput"]), inputSummaryMaxBytes),
				"call_id":       callID,
			},
		})
	case "tool_call_update":
		callID, _ := getString(event, "toolCallId")
		if strings.TrimSpace(callID) == "" {
			return out
		}
		status, _ := getString(event, "status")
		resultStatus, terminal := grokToolResultStatus(status)
		if !terminal {
			return out
		}
		output := jsonStringValue(event["rawOutput"])
		if output == "" {
			output = jsonStringValue(event["content"])
		}
		out = append(out, protocol.Event{
			Type: "tool_result",
			Data: map[string]any{
				"call_id":     callID,
				"status":      resultStatus,
				"output_tail": truncateTail(output, outputTailMaxBytes),
			},
		})
	case "error", "failed", "failure", "cancelled", "canceled":
		data := map[string]any{"status": "failed", "error": grokErrorValue(event)}
		if sessionID != "" {
			data["native_session_id"] = sessionID
		}
		out = append(out, protocol.Event{Type: protocol.EventRunFinished, Data: data})
	case "result", "run_finished", "done", "complete", "completed", "end":
		status, terminal := grokTerminalStatus(typ, event)
		if !terminal {
			return out
		}
		data := map[string]any{"status": status}
		if status == "failed" {
			data["error"] = grokErrorValue(event)
		}
		if sessionID != "" {
			data["native_session_id"] = sessionID
		}
		out = append(out, protocol.Event{Type: protocol.EventRunFinished, Data: data})
	case "message", "text", "text_delta", "output_text":
		// The normalized message above is sufficient.
	}
	return out
}

func grokToolResultStatus(status string) (string, bool) {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "completed", "complete", "done", "success", "succeeded":
		return "ok", true
	case "error", "failed", "failure", "cancelled", "canceled":
		return "error", true
	default:
		return "", false
	}
}

func grokTerminalStatus(typ string, event map[string]any) (string, bool) {
	status, _, terminal := grokTerminalOutcome(typ, event)
	return status, terminal
}

func grokTerminalOutcome(typ string, event map[string]any) (string, GrokAttemptTrust, bool) {
	status := "done"
	trust := GrokTrustCompleteSuccess
	explicitTerminal := false
	if isError, ok := getBool(event, "is_error"); ok && isError {
		status = "failed"
		trust = GrokTrustCompleteNativeFailure
		explicitTerminal = true
	}
	if nativeStatus, ok := getString(event, "status"); ok {
		switch strings.ToLower(strings.TrimSpace(nativeStatus)) {
		case "done", "success", "complete", "completed":
			explicitTerminal = true
		case "error", "failed", "failure", "cancelled", "canceled":
			status = "failed"
			trust = GrokTrustCompleteNativeFailure
			if strings.Contains(strings.ToLower(strings.TrimSpace(nativeStatus)), "cancel") {
				trust = GrokTrustCancelled
			}
			explicitTerminal = true
		default:
			return "", GrokTrustInvalidOrIncomplete, false
		}
	}
	if typ == "end" {
		if stopReason, ok := getString(event, "stopReason"); ok {
			normalized := strings.ToLower(strings.TrimSpace(stopReason))
			switch {
			case normalized == "endturn" || normalized == "end_turn":
				explicitTerminal = true
			case strings.Contains(normalized, "error") || strings.Contains(normalized, "fail") || strings.Contains(normalized, "cancel"):
				status = "failed"
				trust = GrokTrustCompleteNativeFailure
				if strings.Contains(normalized, "cancel") {
					trust = GrokTrustCancelled
				}
				explicitTerminal = true
			default:
				return "", GrokTrustInvalidOrIncomplete, false
			}
		}
		return status, trust, explicitTerminal
	}
	return status, trust, true
}

func grokStreamText(typ string, event map[string]any) string {
	// Grok Build 0.2.106 emits token-preserving text chunks as
	// {"type":"text","data":"..."}. Whitespace in data is content.
	if typ == "text" || typ == "text_delta" || typ == "output_text" {
		if text, ok := getString(event, "data"); ok {
			return text
		}
	}
	return grokFinalText(event)
}

func grokFinalText(event map[string]any) string {
	for _, key := range []string{"result", "final_text", "output_text", "text", "content"} {
		if text, ok := getString(event, key); ok {
			return strings.TrimSpace(text)
		}
	}
	if message, ok := event["message"].(map[string]any); ok {
		if text, ok := getString(message, "text"); ok {
			return strings.TrimSpace(text)
		}
		if text, ok := getString(message, "content"); ok {
			return strings.TrimSpace(text)
		}
	}
	return ""
}

func grokUsage(event map[string]any) map[string]any {
	for _, key := range []string{"usage", "token_usage"} {
		if usage, ok := event[key].(map[string]any); ok {
			out := map[string]any{}
			for usageKey, value := range usage {
				out[usageKey] = value
			}
			// Every emitted turn_usage structurally carries duration_ms. Grok
			// 1.0.0 does not report duration; the canonical emission may
			// replace this with a measured interval.
			if _, ok := out["duration_ms"]; !ok {
				out["duration_ms"] = 0
			}
			return out
		}
	}
	return nil
}

func grokSessionID(event map[string]any) string {
	for _, key := range []string{"session_id", "sessionId", "native_session_id", "conversation_id"} {
		if id, ok := getString(event, key); ok {
			return strings.TrimSpace(id)
		}
	}
	for _, container := range []string{"result", "session", "metadata"} {
		if nested, ok := event[container].(map[string]any); ok {
			for _, key := range []string{"session_id", "id", "conversation_id"} {
				if id, ok := getString(nested, key); ok {
					return strings.TrimSpace(id)
				}
			}
		}
	}
	return ""
}

func grokErrorValue(event map[string]any) any {
	for _, key := range []string{"error", "message", "detail", "data", "stopReason"} {
		if value, ok := event[key]; ok {
			if normalized := normalizedErrorValue(value); normalized != nil && normalized != "" {
				return normalized
			}
		}
	}
	return "Grok runtime failed"
}

// codebuddyResetRe matches the anchored Chinese rate-limit reset template
// from CodeBuddy's providerData.error.message. It accepts only the exact
// known literal prefix and suffix, capturing the local timestamp and a
// timezone in UTC±H, UTC±HH, or UTC±HH:MM format.
var codebuddyResetRe = regexp.MustCompile(`^429 您的使用量已超出频率限制，将在 (\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) UTC([+-]\d{1,2}(?::\d{2})?) 重置，您也可以切换其他模型继续使用。(?: \([0-9a-f]{32}/[0-9a-f-]{36}\))?$`)

// codebuddyNormalizer processes CodeBuddy transcript lines. It delegates
// normal assistant content to the claude codec and extracts providerData
// errors from the provider-visible error envelope.
func codebuddyNormalizer(line []byte) []protocol.Event {
	var event map[string]any
	if err := json.Unmarshal(line, &event); err != nil {
		return nil
	}
	typ, _ := getString(event, "type")
	if typ == "assistant" {
		if normalized := normalizeCodeBuddyAssistant(event); len(normalized) > 0 {
			return normalized
		}
	}

	// CodeBuddy's stream protocol is Claude-compatible for ordinary events.
	// Preserve that behavior, then enrich only the verified reset error.
	// Delegated turn_usage events carry no independently established duration
	// or current-invocation provenance, so every agent_turn_v1 trust field the
	// Claude codec might attach is dropped on this delegation boundary.
	events := claudeNormalizer(line)
	for i := range events {
		enrichCodeBuddyResetEvent(&events[i])
		removeTrustFields(&events[i])
	}
	return events
}

func enrichCodeBuddyResetEvent(event *protocol.Event) {
	if event == nil || event.Type != protocol.EventRunFinished || event.Data["status"] != "failed" {
		return
	}
	message := normalizedFailureText(event.Data["error"])
	if recoveryAt, ok := parseCodebuddyRecoveryAt(message); ok {
		event.Data["failure_class"] = "profile_specific_limit"
		event.Data["recovery_at"] = recoveryAt
	}
}

func normalizedFailureText(value any) string {
	switch typed := value.(type) {
	case string:
		return typed
	case map[string]any:
		for _, key := range []string{"message", "error", "detail"} {
			if text, ok := getString(typed, key); ok {
				return text
			}
		}
	}
	return ""
}

func normalizeCodeBuddyAssistant(event map[string]any) []protocol.Event {
	msg, ok := event["message"].(map[string]any)
	if !ok {
		return nil
	}
	providerData, ok := msg["providerData"].(map[string]any)
	if !ok {
		return nil
	}
	providerError, ok := providerData["error"].(map[string]any)
	if !ok {
		return nil
	}

	data := map[string]any{"status": "failed"}
	data["error"] = normalizedErrorValue(providerError)

	if isCodeBuddy429Reset(providerError) {
		data["failure_class"] = "profile_specific_limit"
		if msg, ok := getString(providerError, "message"); ok {
			if recoveryAt, ok := parseCodebuddyRecoveryAt(msg); ok {
				data["recovery_at"] = recoveryAt
			}
		}
	}

	return []protocol.Event{{Type: protocol.EventRunFinished, Data: data}}
}

// isCodeBuddy429Reset returns true when the provider error object carries the
// exact CodeBuddy 429 rate-limit reset signal: numeric status 429, the
// provider's reset error code, isRetryable false, and a message matching the
// anchored Chinese template. Any deviation (different code, wrong message
// shape, extra prefix, malformed timezone) returns false.
func isCodeBuddy429Reset(providerError map[string]any) bool {
	statusRaw, ok := providerError["status"]
	if !ok {
		return false
	}
	statusF, ok := asFloat64(statusRaw)
	if !ok || int(statusF) != 429 {
		return false
	}
	codeRaw, ok := providerError["code"]
	if !ok {
		return false
	}
	codeF, ok := asFloat64(codeRaw)
	if !ok || int(codeF) != 6004 {
		return false
	}
	retryRaw, ok := providerError["isRetryable"]
	if !ok {
		return false
	}
	retryB, ok := retryRaw.(bool)
	if !ok || retryB {
		return false
	}
	msg, ok := getString(providerError, "message")
	if !ok {
		return false
	}
	return codebuddyResetRe.MatchString(msg)
}

// parseCodebuddyRecoveryAt extracts the UTC recovery timestamp from a
// validated Chinese reset message. It validates date/time components and
// timezone offset bounds, returning the result as an RFC 3339 string.
func parseCodebuddyRecoveryAt(msg string) (string, bool) {
	recovered, ok := ParseCodeBuddyResetRecoveryAt(msg)
	if !ok {
		return "", false
	}
	return recovered.Format(time.RFC3339), true
}

// ParseCodeBuddyResetRecoveryAt recognizes only CodeBuddy's verified Chinese
// 429 reset template. It is exported so execution can enrich the normalized
// message-only stream shape emitted by some CodeBuddy CLI versions.
func ParseCodeBuddyResetRecoveryAt(msg string) (time.Time, bool) {
	matches := codebuddyResetRe.FindStringSubmatch(msg)
	if matches == nil {
		return time.Time{}, false
	}

	year, err1 := strconv.Atoi(matches[1])
	month, err2 := strconv.Atoi(matches[2])
	day, err3 := strconv.Atoi(matches[3])
	hour, err4 := strconv.Atoi(matches[4])
	minute, err5 := strconv.Atoi(matches[5])
	second, err6 := strconv.Atoi(matches[6])
	if err1 != nil || err2 != nil || err3 != nil || err4 != nil || err5 != nil || err6 != nil {
		return time.Time{}, false
	}

	// Reject clearly invalid date/time components. The regex already restricts
	// the digit ranges by pattern length; this catches semantic impossibilities.
	if month < 1 || month > 12 || day < 1 || day > 31 || hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59 {
		return time.Time{}, false
	}

	offset, err := parseCodebuddyTZ(matches[7])
	if err != nil {
		return time.Time{}, false
	}

	local := time.Date(year, time.Month(month), day, hour, minute, second, 0, time.UTC)
	if local.Year() != year || int(local.Month()) != month || local.Day() != day {
		return time.Time{}, false
	}
	return local.Add(-offset), true
}

// parseCodebuddyTZ parses a timezone offset string in one of the accepted
// formats: ±H, ±HH, or ±HH:MM. It rejects any other format.
func parseCodebuddyTZ(tz string) (time.Duration, error) {
	if len(tz) < 2 {
		return 0, fmt.Errorf("timezone too short: %q", tz)
	}
	sign := tz[0]
	if sign != '+' && sign != '-' {
		return 0, fmt.Errorf("invalid timezone sign: %c", sign)
	}

	rest := tz[1:]
	var hours, minutes int

	if idx := strings.IndexByte(rest, ':'); idx >= 0 {
		h, err := strconv.Atoi(rest[:idx])
		if err != nil {
			return 0, fmt.Errorf("invalid timezone hours: %q", rest[:idx])
		}
		m, err := strconv.Atoi(rest[idx+1:])
		if err != nil {
			return 0, fmt.Errorf("invalid timezone minutes: %q", rest[idx+1:])
		}
		hours, minutes = h, m
	} else {
		h, err := strconv.Atoi(rest)
		if err != nil {
			return 0, fmt.Errorf("invalid timezone: %q", rest)
		}
		hours = h
	}

	if hours < 0 || hours > 23 || minutes < 0 || minutes > 59 {
		return 0, fmt.Errorf("timezone offset out of range: %s", tz)
	}

	offset := time.Duration(hours)*time.Hour + time.Duration(minutes)*time.Minute
	if sign == '-' {
		offset = -offset
	}
	return offset, nil
}

// asFloat64 coalesces JSON-numeric types to float64 for comparison.
func asFloat64(raw any) (float64, bool) {
	switch v := raw.(type) {
	case float64:
		return v, true
	case int:
		return float64(v), true
	case int64:
		return float64(v), true
	case json.Number:
		f, err := v.Float64()
		return f, err == nil
	default:
		return 0, false
	}
}

func opencodeNormalizer(line []byte) []protocol.Event {
	var event map[string]any
	if err := json.Unmarshal(line, &event); err != nil {
		return nil
	}
	typ, _ := getString(event, "type")
	switch typ {
	case "text":
		text, ok := openCodeEventText(event)
		if !ok {
			return nil
		}
		return []protocol.Event{{
			Type: "message",
			Data: map[string]any{
				"role": "assistant",
				"text": text,
			},
		}}
	case "step_finish":
		part, ok := event["part"].(map[string]any)
		if !ok {
			return nil
		}
		tokens, ok := part["tokens"].(map[string]any)
		if !ok {
			return nil
		}
		data := map[string]any{}
		if input, ok := tokens["input"]; ok {
			data["input_tokens"] = input
		}
		if output, ok := tokens["output"]; ok {
			data["output_tokens"] = output
		}
		if reasoning, ok := tokens["reasoning"]; ok {
			data["reasoning_output_tokens"] = reasoning
		}
		if total, ok := tokens["total"]; ok {
			data["total_tokens"] = total
		}
		if len(data) == 0 {
			return nil
		}
		// Every emitted turn_usage structurally carries duration_ms. A
		// per-step record has no measured full-turn interval; the aggregated
		// canonical emission replaces this with a measured value. duration_ms=0
		// is the truthful non-positive placeholder until then.
		data["duration_ms"] = 0
		return []protocol.Event{{Type: "turn_usage", Data: data}}
	case "tool_use":
		return openCodeToolUseEvents(event)
	case "error":
		return []protocol.Event{normalizedFailureEvent(event)}
	default:
		return nil
	}
}

// openCodeToolUseEvents normalizes an OpenCode tool_use record into the common
// tool lifecycle. A terminal tool part (one carrying completion state and
// output) normalizes to paired tool_call/tool_result from a single native line;
// a non-terminal part yields only the tool_call. Stable call_id comes from the
// part identifier, or a deterministic content-derived fallback when the native
// id is absent.
//
// OpenCode 1.17 run --format json carries the tool lifecycle in a nested
// part.state object (status/input/output/error); earlier flattened shapes put
// those fields directly on the part (state/status as a string, input, output).
// Both shapes normalize identically.
func openCodeToolUseEvents(event map[string]any) []protocol.Event {
	part, ok := event["part"].(map[string]any)
	if !ok {
		return nil
	}
	name := openCodePartToolName(part)
	if strings.TrimSpace(name) == "" {
		return nil
	}
	state := openCodePartStateMap(part)
	input := openCodePartInput(part, state)
	inputSummary := jsonStringValue(input)
	callID := openCodeToolCallID(event, part, name, inputSummary)
	if callID == "" {
		return nil
	}
	sessionID := openCodeTopLevelSessionID(event)
	callData := map[string]any{
		"name":          name,
		"input_summary": truncateHead(inputSummary, inputSummaryMaxBytes),
		"call_id":       callID,
	}
	if sessionID != "" {
		callData["native_session_id"] = sessionID
	}
	callEvent := protocol.Event{Type: "tool_call", Data: callData}

	status, output, terminal := openCodeToolTerminal(part, state)
	if !terminal {
		return []protocol.Event{callEvent}
	}
	resultData := map[string]any{
		"call_id":     callID,
		"status":      status,
		"output_tail": truncateTail(output, outputTailMaxBytes),
	}
	if sessionID != "" {
		resultData["native_session_id"] = sessionID
	}
	return []protocol.Event{callEvent, {Type: "tool_result", Data: resultData}}
}

// openCodePartStateMap returns part.state when it is the nested object shape
// (OpenCode 1.17), or nil for the flattened string-state shape.
func openCodePartStateMap(part map[string]any) map[string]any {
	if state, ok := part["state"].(map[string]any); ok {
		return state
	}
	return nil
}

func openCodePartToolName(part map[string]any) string {
	// OpenCode 1.17 uses part.tool; earlier/verified flattened shapes use name.
	for _, key := range []string{"tool", "name", "toolName", "tool_name"} {
		if name, ok := getString(part, key); ok {
			return name
		}
	}
	return ""
}

func openCodePartInput(part, state map[string]any) any {
	if state != nil {
		if input, ok := state["input"]; ok {
			return input
		}
	}
	if input, ok := part["input"]; ok {
		return input
	}
	if args, ok := part["args"]; ok {
		return args
	}
	return nil
}

// openCodeToolCallID returns the stable tool call identifier from the native
// part id, or a deterministic content-derived fallback so paired events share
// a consistent, unique call_id.
func openCodeToolCallID(event, part map[string]any, name, input string) string {
	for _, container := range []map[string]any{part, event} {
		for _, key := range []string{"id", "toolCallId", "tool_call_id"} {
			if id, ok := getString(container, key); ok {
				return id
			}
		}
	}
	return openCodeDerivedToolID(name, jsonStringValue(input))
}

// openCodeDerivedToolID produces a deterministic stable identifier from the
// tool name and bounded input when the native record omits an explicit id.
func openCodeDerivedToolID(name, input string) string {
	h := fnv.New64a()
	io.WriteString(h, name)
	io.WriteString(h, input)
	return fmt.Sprintf("oc_%x", h.Sum64())
}

// openCodeToolTerminal inspects the (possibly nested) part state/output to
// determine whether the tool lifecycle is terminal, returning the normalized
// status and bounded output string. The nested part.state.status (OpenCode
// 1.17) is preferred; the flattened part.state/part.status strings remain
// accepted for compatibility.
func openCodeToolTerminal(part, state map[string]any) (status, output string, terminal bool) {
	var statusStr string
	if state != nil {
		if s, ok := getString(state, "status"); ok {
			statusStr = s
		}
	}
	if strings.TrimSpace(statusStr) == "" {
		if s, ok := part["state"].(string); ok {
			statusStr = s
		}
	}
	if strings.TrimSpace(statusStr) == "" {
		if s, ok := part["status"].(string); ok {
			statusStr = s
		}
	}
	switch strings.ToLower(strings.TrimSpace(statusStr)) {
	case "completed", "complete", "done", "success", "succeeded", "output-available", "output_available":
		return "ok", openCodePartOutput(part, state), true
	case "error", "failed", "failure", "cancelled", "canceled":
		return "error", openCodePartOutput(part, state), true
	case "pending", "running", "input-available", "input_available":
		return "", "", false
	}
	return "", "", false
}

func openCodePartOutput(part, state map[string]any) string {
	// Nested part.state output/error (OpenCode 1.17) preferred.
	if state != nil {
		for _, key := range []string{"output", "result", "error"} {
			if value, ok := state[key]; ok && value != nil {
				if text := jsonStringValue(value); text != "" {
					return text
				}
			}
		}
	}
	for _, key := range []string{"output", "result", "error"} {
		if value, ok := part[key]; ok && value != nil {
			if text := jsonStringValue(value); text != "" {
				return text
			}
		}
	}
	return ""
}

func openCodeTopLevelSessionID(event map[string]any) string {
	for _, key := range []string{"sessionID", "session_id", "sessionId"} {
		if id, ok := getString(event, key); ok {
			return id
		}
	}
	return ""
}

func codexNormalizer(line []byte) []protocol.Event {
	var event map[string]any
	if err := json.Unmarshal(line, &event); err != nil {
		return nil
	}
	typ, _ := getString(event, "type")
	switch typ {
	case "item.started":
		item, ok := event["item"].(map[string]any)
		if !ok {
			return nil
		}
		if call := codexItemStartedToolCall(item); call != nil {
			return []protocol.Event{*call}
		}
		return nil
	case "item.completed":
		item, ok := event["item"].(map[string]any)
		if !ok {
			return nil
		}
		itemType, _ := getString(item, "type")
		switch itemType {
		case "agent_message":
			text, _ := getString(item, "text")
			if text == "" {
				text, _ = getString(item, "content")
			}
			if text == "" {
				return nil
			}
			return []protocol.Event{{
				Type: "message",
				Data: map[string]any{
					"role": "assistant",
					"text": text,
				},
			}}
		case "file_change":
			// Native Codex emits file_change only as an atomic item.completed
			// record. Normalize it to exactly one tool_call followed by one
			// tool_result so it is never double-counted against a hypothetical
			// item.started.
			return codexFileChangeCompletedEvents(item)
		default:
			if result := codexItemCompletedToolResult(item); result != nil {
				return []protocol.Event{*result}
			}
			return nil
		}
	case "turn.completed":
		if _, failed := event["error"]; failed {
			return []protocol.Event{normalizedFailureEvent(event)}
		}
		usage, _ := event["usage"].(map[string]any)
		durationMs := intValue(event["duration_ms"])
		data := map[string]any{
			"input_tokens":  intValue(usage["input_tokens"]),
			"output_tokens": intValue(usage["output_tokens"]),
			"duration_ms":   durationMs,
		}
		// Codex's turn.completed duration is the client-reported end-to-end
		// agent turn/session wall duration and may include tool and waiting
		// time. It is NOT provider generation time. The trusted agent_turn_v1
		// contract is claimed only for a finite positive value with complete
		// current-turn usage.
		if durationMs > 0 {
			if _, _, ok := completeUsageTokens(usage); ok {
				applyTrustedAgentTurnContract(data)
			}
		}
		return []protocol.Event{{Type: "turn_usage", Data: data}}
	case "turn.failed":
		return []protocol.Event{normalizedFailureEvent(event)}
	default:
		return nil
	}
}

func claudeNormalizer(line []byte) []protocol.Event {
	var event map[string]any
	if err := json.Unmarshal(line, &event); err != nil {
		return nil
	}
	typ, _ := getString(event, "type")
	switch typ {
	case "assistant":
		return normalizeClaudeAssistant(event)
	case "user":
		return normalizeClaudeUser(event)
	case "result":
		usage, _ := event["usage"].(map[string]any)
		durationMs := intValue(event["duration_ms"])
		usageData := map[string]any{
			"input_tokens":  intValue(usage["input_tokens"]),
			"output_tokens": intValue(usage["output_tokens"]),
			"duration_ms":   durationMs,
		}
		isError, hasIsError := getBool(event, "is_error")
		failed := (hasIsError && isError) || hasNormalizedFailureField(event)
		// Claude's result duration is the client-reported end-to-end agent
		// turn/session wall duration and may include tool and waiting time. It
		// is NOT provider generation time. The trusted agent_turn_v1 contract
		// is claimed only for a successful result with a finite positive value
		// and complete current-result usage; an error result never carries
		// trust fields.
		if !failed && durationMs > 0 {
			if _, _, ok := completeUsageTokens(usage); ok {
				applyTrustedAgentTurnContract(usageData)
			}
		}
		events := []protocol.Event{{Type: "turn_usage", Data: usageData}}
		if failed {
			events = append(events, normalizedFailureEvent(event))
		}
		return events
	default:
		return nil
	}
}

func hasNormalizedFailureField(event map[string]any) bool {
	for _, key := range []string{"error", "failure", "failure_class", "recovery_at", "retry_after_seconds"} {
		if value, ok := event[key]; ok && value != nil {
			return true
		}
	}
	return false
}

// normalizedFailureEvent deliberately copies only the normalized failure
// fields consumed by execution. It never forwards an adapter-private event or
// transcript object wholesale.
func normalizedFailureEvent(event map[string]any) protocol.Event {
	data := map[string]any{"status": "failed"}
	for _, key := range []string{"failure_class", "recovery_at", "retry_after_seconds"} {
		if value, ok := event[key]; ok {
			data[key] = value
		}
	}
	for _, key := range []string{"session_id", "thread_id", "native_session_id"} {
		if value, ok := getString(event, key); ok {
			data["native_session_id"] = value
			break
		}
	}
	if failure, ok := event["failure"].(map[string]any); ok {
		data["error"] = normalizedErrorValue(failure)
		if _, hasClass := data["failure_class"]; !hasClass {
			if class, ok := getString(failure, "failure_class"); ok {
				data["failure_class"] = class
			} else if class, ok := getString(failure, "class"); ok {
				data["failure_class"] = class
			}
		}
	} else {
		for _, key := range []string{"error", "message", "result", "detail"} {
			if value, ok := event[key]; ok {
				if normalized := normalizedErrorValue(value); normalized != nil && normalized != "" {
					data["error"] = normalized
					break
				}
			}
		}
	}
	return protocol.Event{Type: protocol.EventRunFinished, Data: data}
}

func normalizedErrorValue(value any) any {
	switch typed := value.(type) {
	case string:
		return typed
	case map[string]any:
		out := map[string]any{}
		for _, key := range []string{"message", "error", "detail", "code", "type", "recovery_at", "retry_after_seconds", "failure_class", "class"} {
			if nested, ok := typed[key]; ok {
				out[key] = nested
			}
		}
		return out
	default:
		return jsonStringValue(value)
	}
}

func normalizeClaudeAssistant(event map[string]any) []protocol.Event {
	message, ok := event["message"].(map[string]any)
	if !ok {
		return nil
	}
	content, ok := message["content"].([]any)
	if !ok {
		return nil
	}

	var out []protocol.Event
	for _, raw := range content {
		block, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		blockType, _ := getString(block, "type")
		switch blockType {
		case "text", "output_text":
			text, _ := getString(block, "text")
			if text == "" {
				continue
			}
			out = append(out, protocol.Event{
				Type: "message",
				Data: map[string]any{
					"role": "assistant",
					"text": text,
				},
			})
		case "tool_use":
			callID, _ := getString(block, "id")
			name, _ := getString(block, "name")
			out = append(out, protocol.Event{
				Type: "tool_call",
				Data: map[string]any{
					"name":          name,
					"input_summary": truncateHead(jsonStringValue(block["input"]), inputSummaryMaxBytes),
					"call_id":       callID,
				},
			})
		}
	}
	return out
}

func normalizeClaudeUser(event map[string]any) []protocol.Event {
	message, ok := event["message"].(map[string]any)
	if !ok {
		return nil
	}
	content, ok := message["content"].([]any)
	if !ok {
		return nil
	}

	var out []protocol.Event
	for _, raw := range content {
		block, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		blockType, _ := getString(block, "type")
		if blockType != "tool_result" {
			continue
		}
		callID, _ := getString(block, "tool_use_id")
		status := "ok"
		if isError, _ := getBool(block, "is_error"); isError {
			status = "error"
		}
		out = append(out, protocol.Event{
			Type: "tool_result",
			Data: map[string]any{
				"call_id":     callID,
				"status":      status,
				"output_tail": truncateTail(claudeToolResultText(block["content"]), outputTailMaxBytes),
			},
		})
	}
	return out
}

func claudeToolResultText(raw any) string {
	switch v := raw.(type) {
	case string:
		return v
	case []any:
		parts := make([]string, 0, len(v))
		for _, item := range v {
			switch item := item.(type) {
			case string:
				parts = append(parts, item)
			case map[string]any:
				if text, ok := getString(item, "text"); ok {
					parts = append(parts, text)
				} else if content, ok := getString(item, "content"); ok {
					parts = append(parts, content)
				} else {
					parts = append(parts, jsonStringValue(item))
				}
			default:
				parts = append(parts, jsonStringValue(item))
			}
		}
		return strings.Join(parts, "")
	default:
		return jsonStringValue(raw)
	}
}

func codexCommandSummary(raw any) string {
	switch v := raw.(type) {
	case string:
		return v
	case []any:
		parts := make([]string, 0, len(v))
		for _, part := range v {
			parts = append(parts, fmt.Sprint(part))
		}
		return strings.Join(parts, " ")
	default:
		return jsonStringValue(raw)
	}
}

func codexCommandName(command string) string {
	command = strings.TrimSpace(command)
	if command == "" {
		return "command_execution"
	}
	fields := strings.Fields(command)
	if len(fields) == 0 || fields[0] == "" {
		return "command_execution"
	}
	return fields[0]
}

// codexToolItemTypes are the native Codex item types that map to the common
// tool_call/tool_result contract: command_execution, mcp_tool_call,
// web_search, and file_change.
var codexToolItemTypes = map[string]bool{
	"command_execution": true,
	"mcp_tool_call":     true,
	"web_search":        true,
	"file_change":       true,
}

// codexItemStartedToolCall normalizes an item.started lifecycle record for any
// supported native tool type into the common tool_call event. It returns nil
// for non-tool items so the caller can skip them. file_change is excluded: it
// is an atomic item.completed-only record and must never emit from a started
// boundary, so a hypothetical started can never double-count it.
func codexItemStartedToolCall(item map[string]any) *protocol.Event {
	itemType, _ := getString(item, "type")
	if !codexToolItemTypes[itemType] || itemType == "file_change" {
		return nil
	}
	callID, _ := getString(item, "id")
	if strings.TrimSpace(callID) == "" {
		return nil
	}
	name, input := codexToolIdentity(item, itemType)
	return &protocol.Event{
		Type: "tool_call",
		Data: map[string]any{
			"name":          name,
			"input_summary": truncateHead(input, inputSummaryMaxBytes),
			"call_id":       callID,
		},
	}
}

// codexItemCompletedToolResult normalizes an item.completed lifecycle record
// for any supported native tool type into the common tool_result event. It
// returns nil for non-tool items and for file_change, which is normalized
// atomically into a paired tool_call/tool_result by its own handler.
func codexItemCompletedToolResult(item map[string]any) *protocol.Event {
	itemType, _ := getString(item, "type")
	if !codexToolItemTypes[itemType] || itemType == "file_change" {
		return nil
	}
	callID, _ := getString(item, "id")
	if strings.TrimSpace(callID) == "" {
		return nil
	}
	status, output := codexToolOutcome(item, itemType)
	return &protocol.Event{
		Type: "tool_result",
		Data: map[string]any{
			"call_id":     callID,
			"status":      status,
			"output_tail": truncateTail(output, outputTailMaxBytes),
		},
	}
}

// codexFileChangeCompletedEvents normalizes the atomic file_change
// item.completed record into exactly one tool_call followed by one tool_result.
func codexFileChangeCompletedEvents(item map[string]any) []protocol.Event {
	callID, _ := getString(item, "id")
	if strings.TrimSpace(callID) == "" {
		return nil
	}
	name, input := codexToolIdentity(item, "file_change")
	status, output := codexToolOutcome(item, "file_change")
	return []protocol.Event{
		{Type: "tool_call", Data: map[string]any{
			"name":          name,
			"input_summary": truncateHead(input, inputSummaryMaxBytes),
			"call_id":       callID,
		}},
		{Type: "tool_result", Data: map[string]any{
			"call_id":     callID,
			"status":      status,
			"output_tail": truncateTail(output, outputTailMaxBytes),
		}},
	}
}

// codexToolIdentity extracts the common tool name and bounded input summary
// from a native Codex tool item at its started boundary.
func codexToolIdentity(item map[string]any, itemType string) (name, input string) {
	switch itemType {
	case "command_execution":
		command := codexCommandSummary(item["command"])
		return codexCommandName(command), command
	case "mcp_tool_call":
		// Codex 0.144 uses tool; earlier verified shapes used tool_name.
		toolName, _ := getString(item, "tool")
		if strings.TrimSpace(toolName) == "" {
			toolName, _ = getString(item, "tool_name")
		}
		if strings.TrimSpace(toolName) == "" {
			toolName = "mcp_tool_call"
		}
		return toolName, jsonStringValue(item["arguments"])
	case "web_search":
		query, _ := getString(item, "query")
		return "web_search", query
	case "file_change":
		return "file_change", codexFileChangeSummary(item)
	default:
		return itemType, jsonStringValue(item)
	}
}

// codexToolOutcome extracts the normalized status (ok/error) and bounded output
// tail from a native Codex tool item at its completed boundary.
// command_execution status is determined by exit_code (preserving the original
// behavior); mcp_tool_call maps an explicit error to a failed result and
// serializes result safely; every other tool type maps the item status field.
func codexToolOutcome(item map[string]any, itemType string) (status, output string) {
	switch itemType {
	case "command_execution":
		st := "error"
		if intValue(item["exit_code"]) == 0 {
			st = "ok"
		}
		out, _ := getString(item, "aggregated_output")
		return st, out
	case "mcp_tool_call":
		// An explicit non-empty error maps to a failed result whose bounded
		// output tail carries the error text.
		if errText := jsonStringValue(item["error"]); errText != "" {
			return "error", errText
		}
		// Codex 0.144 uses result; earlier verified shapes used output.
		out := jsonStringValue(item["result"])
		if strings.TrimSpace(out) == "" {
			out = jsonStringValue(item["output"])
		}
		return codexItemStatus(item, out), out
	case "web_search":
		out := codexWebSearchSummary(item["results"])
		return codexItemStatus(item, out), out
	case "file_change":
		out := codexFileChangeSummary(item)
		return codexItemStatus(item, out), out
	default:
		return "error", jsonStringValue(item)
	}
}

// codexFileChangeSummary produces a bounded serialized summary of a file_change
// item. Codex 0.144 carries a changes array; earlier verified shapes carried a
// single change and/or path. The serialized form stays within the output byte
// ceiling via the caller's truncation.
func codexFileChangeSummary(item map[string]any) string {
	if changes := jsonStringValue(item["changes"]); changes != "" && changes != "null" {
		return changes
	}
	if change := jsonStringValue(item["change"]); change != "" {
		return change
	}
	if path, ok := getString(item, "path"); ok {
		return path
	}
	return ""
}

// codexItemStatus maps the native item status field to ok/error, defaulting to
// ok when an explicit completed/success status or non-empty output is present.
func codexItemStatus(item map[string]any, output string) string {
	if status, ok := getString(item, "status"); ok {
		switch strings.ToLower(strings.TrimSpace(status)) {
		case "completed", "complete", "success", "succeeded", "done":
			return "ok"
		case "failed", "error", "cancelled", "canceled":
			return "error"
		}
	}
	if strings.TrimSpace(output) != "" {
		return "ok"
	}
	return "error"
}

// codexWebSearchSummary produces a bounded newline-joined summary of web search
// result titles so the tool_result output_tail stays within the byte ceiling.
func codexWebSearchSummary(raw any) string {
	results, ok := raw.([]any)
	if !ok || len(results) == 0 {
		if text, ok := getString(map[string]any{"v": raw}, "v"); ok && text != "" {
			return text
		}
		return jsonStringValue(raw)
	}
	parts := make([]string, 0, len(results))
	for _, entry := range results {
		if m, ok := entry.(map[string]any); ok {
			if title, ok := getString(m, "title"); ok && title != "" {
				parts = append(parts, title)
				continue
			}
		}
		parts = append(parts, jsonStringValue(entry))
	}
	return strings.Join(parts, "\n")
}

func intValue(raw any) int {
	switch v := raw.(type) {
	case int:
		return v
	case int64:
		return int(v)
	case float64:
		return int(v)
	case json.Number:
		n, _ := v.Int64()
		return int(n)
	default:
		return 0
	}
}

func truncateHead(text string, maxBytes int) string {
	if maxBytes <= 0 || len(text) <= maxBytes {
		return text
	}
	return validUTF8Prefix(text, maxBytes)
}

func truncateTail(text string, maxBytes int) string {
	if maxBytes <= 0 || len(text) <= maxBytes {
		return text
	}
	start := len(text) - maxBytes
	for start < len(text) && !utf8.RuneStart(text[start]) {
		start++
	}
	return text[start:]
}

func validUTF8Prefix(text string, maxBytes int) string {
	if maxBytes >= len(text) {
		return text
	}
	end := maxBytes
	for end > 0 && !utf8.ValidString(text[:end]) {
		end--
	}
	return text[:end]
}
