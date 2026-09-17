package driver

import (
	"bytes"
	"encoding/json"
	"testing"
	"time"
)

// Resume usage tests. Codex 0.148 thread/resume is streamed WITHOUT
// experimentalRawEvents, so a resumed turn never sees rawResponse/completed:
// usage arrives only through thread/tokenUsage/updated. These tests drive the
// bridge directly with a deterministic clock, with no live model and no RPC
// fake, so the accounting window can be asserted exactly.

const (
	resumeTestThread = "01a0a9d1-4aad-7dd3-8eda-cafa7149a5fc"
	resumeTestOldT   = "01a0a9d2-122d-78a2-895e-eec6a438b9dd"
	resumeTestTurn   = "01a0a9d3-8b0e-7913-9334-7d05f28a12ef"
	resumeTestModel  = "gpt-5.6-luna"
)

// newResumeTestBridge builds a bridge in the state the run sets up for a
// resumed thread: the thread and active turn are known and resume accounting is
// armed. The clock is deterministic and the output buffer is discarded.
func newResumeTestBridge(t *testing.T, clock *time.Time) *codexAppServerBridge {
	t.Helper()
	bridge := newCodexAppServerBridge(codexAppServerAuth{}, codexAppServerInvocation{ResumeID: resumeTestThread})
	bridge.sampler = newResponseTPSSampler(func() time.Time { return *clock })
	bridge.output = &bytes.Buffer{}
	bridge.threadID = resumeTestThread
	bridge.model = resumeTestModel
	bridge.turnID = resumeTestTurn
	bridge.armResumeUsage()
	return bridge
}

// resumeTokenUsage builds a thread/tokenUsage/updated notification for the
// given turn, mirroring the native payload shape exactly.
func resumeTokenUsage(t *testing.T, threadID, turnID string, total, last map[string]any) codexAppServerMessage {
	t.Helper()
	params := map[string]any{
		"threadId": threadID,
		"turnId":   turnID,
		"tokenUsage": map[string]any{
			"total": total,
			"last":  last,
		},
	}
	return codexAppServerMessage{Method: "thread/tokenUsage/updated", Params: mustJSON(t, params)}
}

func resumeUsageBreakdown(input, cached, output, total int) map[string]any {
	return map[string]any{
		"inputTokens": input, "cachedInputTokens": cached,
		"outputTokens": output, "totalTokens": total,
	}
}

// resumeAgentDelta builds the first non-empty agent delta that opens the
// per-response sampling window.
func resumeAgentDelta(t *testing.T, text string) codexAppServerMessage {
	t.Helper()
	params := map[string]any{
		"threadId": resumeTestThread, "turnId": resumeTestTurn, "itemId": "item-1", "delta": text,
	}
	return codexAppServerMessage{Method: "item/agentMessage/delta", Params: mustJSON(t, params)}
}

// resumeTurnCompleted builds the terminal turn/completed notification.
func resumeTurnCompleted(t *testing.T, status string) codexAppServerMessage {
	t.Helper()
	params := map[string]any{
		"threadId": resumeTestThread,
		"turn":     map[string]any{"id": resumeTestTurn, "status": status, "durationMs": 14326},
	}
	return codexAppServerMessage{Method: "turn/completed", Params: mustJSON(t, params)}
}

// resumeUnknownNotification builds a notification with no recognized meaning
// for the usage window (used to keep a delta window open).
func resumeUnknownNotification(t *testing.T, method string, params map[string]any) codexAppServerMessage {
	t.Helper()
	return codexAppServerMessage{Method: method, Params: mustJSON(t, params)}
}

// TestCodexResumeExcludesBaselineOldTurn verifies the replayed previous-turn
// notification only establishes the baseline: its 304/620 cumulative totals
// never reach the current turn's accounting.
func TestCodexResumeExcludesBaselineOldTurn(t *testing.T) {
	clock := time.UnixMilli(1_000_000)
	bridge := newResumeTestBridge(t, &clock)

	// The resume handshake replays the OLD turn's usage: total output 304.
	bridge.turnID = ""
	bridge.handleNotification(resumeTokenUsage(t, resumeTestThread, resumeTestOldT,
		resumeUsageBreakdown(39388, 34048, 304, 39692),
		resumeUsageBreakdown(13211, 12032, 182, 13393)))
	bridge.turnID = resumeTestTurn

	if bridge.responseOutputTokens != 0 || bridge.responseInputTokens != 0 || bridge.responseCachedTokens != 0 {
		t.Fatalf("the old-turn baseline must not be accounted: in=%d out=%d cached=%d",
			bridge.responseInputTokens, bridge.responseOutputTokens, bridge.responseCachedTokens)
	}
	if bridge.responseUsageObserved {
		t.Fatalf("the old-turn baseline must not mark usage observed")
	}
	if len(bridge.sampler.samples) != 0 {
		t.Fatalf("the old-turn baseline must produce no sample: %#v", bridge.sampler.samples)
	}
	if !bridge.resumeUsage.haveBaseline {
		t.Fatalf("the old-turn baseline must be captured: %#v", bridge.resumeUsage)
	}
	want := codexResumeTotals{Input: 39388, Cached: 34048, Output: 304, Total: 39692}
	if bridge.resumeUsage.baseline != want {
		t.Fatalf("baseline = %#v, want %#v", bridge.resumeUsage.baseline, want)
	}
}

// TestCodexResumeDeltaMatchesLast verifies a valid active-turn notification
// accounts the increment (620-304=316 output) rather than the cumulative total,
// and pairs a tokenizer_v1 sample with the cl100k count of the observed
// generation over its first-to-last delta window.
func TestCodexResumeDeltaMatchesLast(t *testing.T) {
	clock := time.UnixMilli(2_000_000)
	bridge := newResumeTestBridge(t, &clock)

	// Baseline: the replayed old turn (output 304).
	bridge.turnID = ""
	bridge.handleNotification(resumeTokenUsage(t, resumeTestThread, resumeTestOldT,
		resumeUsageBreakdown(39388, 34048, 304, 39692),
		resumeUsageBreakdown(13211, 12032, 182, 13393)))
	bridge.turnID = resumeTestTurn

	// Two observed deltas open and close the response window; the
	// notification then arrives to reconcile the billing delta.
	clock = clock.Add(120 * time.Millisecond)
	bridge.handleNotification(resumeAgentDelta(t, "A monotonic clock "))
	clock = clock.Add(140 * time.Millisecond)
	bridge.handleNotification(resumeAgentDelta(t, "keeps the observed window honest"))
	clock = clock.Add(80 * time.Millisecond)
	// Current total output 620, last output 316: delta matches last exactly.
	bridge.handleNotification(resumeTokenUsage(t, resumeTestThread, resumeTestTurn,
		resumeUsageBreakdown(52807, 47104, 620, 53427),
		resumeUsageBreakdown(13419, 13056, 316, 13735)))

	if bridge.responseOutputTokens != 316 {
		t.Fatalf("output tokens = %d, want the delta 316 (not the cumulative 620)", bridge.responseOutputTokens)
	}
	if bridge.responseInputTokens != 13419 || bridge.responseCachedTokens != 13056 {
		t.Fatalf("usage = in=%d cached=%d, want 13419/13056",
			bridge.responseInputTokens, bridge.responseCachedTokens)
	}
	if len(bridge.sampler.samples) != 1 {
		t.Fatalf("want one paired sample, got %#v", bridge.sampler.samples)
	}
	sample := bridge.sampler.samples[0]
	if sample.OutputTokens != 9 {
		t.Fatalf("sample output tokens = %d, want the cl100k count 9 of the observed deltas (not the official 316)", sample.OutputTokens)
	}
	if sample.Model != resumeTestModel {
		t.Fatalf("sample model = %q, want %q", sample.Model, resumeTestModel)
	}
	if sample.FirstTokenAtMS != 2_000_120 || sample.CompletedAtMS != 2_000_260 {
		t.Fatalf("sample timing = %d..%d, want first-to-last delta 2000120..2000260", sample.FirstTokenAtMS, sample.CompletedAtMS)
	}
	if sample.ResponseID != resumeTestThread+"/"+resumeTestTurn+"/1" {
		t.Fatalf("sample response id = %q, want the stable synthetic id", sample.ResponseID)
	}

	// The usage reaches the turn.completed record with the same tokenizer_v1
	// contract the fresh path uses.
	bridge.handleNotification(resumeTurnCompleted(t, "completed"))
	record := lastOutputRecord(t, bridge)
	usage, _ := record["usage"].(map[string]any)
	if usage["output_tokens"] != float64(316) || usage["input_tokens"] != float64(13419) {
		t.Fatalf("resumed turn usage = %v, want 316 output / 13419 input", usage)
	}
	usageEvents := codexNormalizer(mustJSON(t, record))
	if len(usageEvents) != 1 || usageEvents[0].Type != "turn_usage" {
		t.Fatalf("want one normalized turn_usage, got %v", usageEvents)
	}
	samples, _ := usageEvents[0].Data["tps_samples"].([]any)
	if len(samples) != 1 {
		t.Fatalf("normalized usage must carry the paired sample: %v", usageEvents[0].Data)
	}
	if usageEvents[0].Data["tps_sampling_contract"] != responseTPSSamplingContract {
		t.Fatalf("contract = %v, want %s", usageEvents[0].Data["tps_sampling_contract"], responseTPSSamplingContract)
	}
}

// TestCodexResumeTwoResponsesWithToolGap verifies a tool-only response adds its
// usage but no speed sample, and each text response's tokenizer_v1 sample is
// measured over its own first-to-last delta window.
func TestCodexResumeTwoResponsesWithToolGap(t *testing.T) {
	clock := time.UnixMilli(3_000_000)
	bridge := newResumeTestBridge(t, &clock)

	bridge.turnID = ""
	bridge.handleNotification(resumeTokenUsage(t, resumeTestThread, resumeTestOldT,
		resumeUsageBreakdown(1000, 500, 100, 1100),
		resumeUsageBreakdown(1000, 500, 100, 1100)))
	bridge.turnID = resumeTestTurn

	// First response: two observed deltas then usage.
	clock = clock.Add(50 * time.Millisecond)
	bridge.handleNotification(resumeAgentDelta(t, "the first observed "))
	clock = clock.Add(120 * time.Millisecond)
	bridge.handleNotification(resumeAgentDelta(t, "generation of the turn"))
	clock = clock.Add(30 * time.Millisecond)
	bridge.handleNotification(resumeTokenUsage(t, resumeTestThread, resumeTestTurn,
		resumeUsageBreakdown(1100, 520, 140, 1240),
		resumeUsageBreakdown(100, 20, 40, 140)))

	// Tool-only response: NO delta opens a window, but the usage still counts.
	clock = clock.Add(200 * time.Millisecond)
	bridge.handleNotification(resumeUnknownNotification(t, "item/completed", map[string]any{
		"threadId": resumeTestThread, "turnId": resumeTestTurn,
		"item": map[string]any{"id": "cmd-1", "type": "commandExecution", "command": "pwd", "exitCode": 0},
	}))
	clock = clock.Add(100 * time.Millisecond)
	bridge.handleNotification(resumeTokenUsage(t, resumeTestThread, resumeTestTurn,
		resumeUsageBreakdown(1200, 560, 200, 1400),
		resumeUsageBreakdown(100, 40, 60, 160)))

	// Second text response: its own deltas open a fresh window.
	clock = clock.Add(50 * time.Millisecond)
	bridge.handleNotification(resumeAgentDelta(t, "the second observed "))
	clock = clock.Add(130 * time.Millisecond)
	bridge.handleNotification(resumeAgentDelta(t, "generation of the turn"))
	clock = clock.Add(20 * time.Millisecond)
	bridge.handleNotification(resumeTokenUsage(t, resumeTestThread, resumeTestTurn,
		resumeUsageBreakdown(1250, 570, 230, 1480),
		resumeUsageBreakdown(50, 10, 30, 80)))

	if bridge.responseOutputTokens != 40+60+30 {
		t.Fatalf("output tokens = %d, want 130 summed across three responses", bridge.responseOutputTokens)
	}
	if bridge.responseInputTokens != 100+100+50 {
		t.Fatalf("input tokens = %d, want 250", bridge.responseInputTokens)
	}
	if bridge.responseCachedTokens != 20+40+10 {
		t.Fatalf("cached tokens = %d, want 70", bridge.responseCachedTokens)
	}
	if len(bridge.sampler.samples) != 2 {
		t.Fatalf("the tool-only response must produce no sample: got %d", len(bridge.sampler.samples))
	}
	if bridge.sampler.samples[0].OutputTokens != 7 || bridge.sampler.samples[1].OutputTokens != 7 {
		t.Fatalf("sample output tokens = %d/%d, want the cl100k counts 7/7 (not the official 40/30)",
			bridge.sampler.samples[0].OutputTokens, bridge.sampler.samples[1].OutputTokens)
	}
	if bridge.sampler.samples[1].ResponseID != resumeTestThread+"/"+resumeTestTurn+"/3" {
		t.Fatalf("second sample id = %q, want sequence 3", bridge.sampler.samples[1].ResponseID)
	}
	if bridge.sampler.samples[0].FirstTokenAtMS != 3_000_050 || bridge.sampler.samples[0].CompletedAtMS != 3_000_170 {
		t.Fatalf("first sample timing = %d..%d, want first-to-last delta 3000050..3000170",
			bridge.sampler.samples[0].FirstTokenAtMS, bridge.sampler.samples[0].CompletedAtMS)
	}
	if bridge.sampler.samples[1].FirstTokenAtMS != 3_000_550 || bridge.sampler.samples[1].CompletedAtMS != 3_000_680 {
		t.Fatalf("second sample timing = %d..%d, want first-to-last delta 3000550..3000680",
			bridge.sampler.samples[1].FirstTokenAtMS, bridge.sampler.samples[1].CompletedAtMS)
	}
}

// TestCodexResumeDuplicateNotificationCountedOnce verifies a retransmitted
// notification with an identical total is deduplicated by the recorded totals.
func TestCodexResumeDuplicateNotificationCountedOnce(t *testing.T) {
	clock := time.UnixMilli(4_000_000)
	bridge := newResumeTestBridge(t, &clock)

	bridge.turnID = ""
	bridge.handleNotification(resumeTokenUsage(t, resumeTestThread, resumeTestOldT,
		resumeUsageBreakdown(1000, 500, 100, 1100),
		resumeUsageBreakdown(1000, 500, 100, 1100)))
	bridge.turnID = resumeTestTurn

	// Two observed deltas 120ms apart keep the sample claimable; the
	// notification's own arrival time is never part of the window.
	clock = clock.Add(50 * time.Millisecond)
	bridge.handleNotification(resumeAgentDelta(t, "counted once "))
	clock = clock.Add(120 * time.Millisecond)
	bridge.handleNotification(resumeAgentDelta(t, "and never twice"))

	duplicated := resumeTokenUsage(t, resumeTestThread, resumeTestTurn,
		resumeUsageBreakdown(1100, 520, 140, 1240),
		resumeUsageBreakdown(100, 20, 40, 140))
	bridge.handleNotification(duplicated)
	bridge.handleNotification(duplicated)

	if bridge.responseOutputTokens != 40 {
		t.Fatalf("output tokens = %d, want 40 (a duplicate must count once)", bridge.responseOutputTokens)
	}
	if bridge.responseInputTokens != 100 || bridge.responseCachedTokens != 20 {
		t.Fatalf("usage = in=%d cached=%d, want 100/20", bridge.responseInputTokens, bridge.responseCachedTokens)
	}
	if len(bridge.sampler.samples) != 1 {
		t.Fatalf("a duplicate must not add a sample: got %d", len(bridge.sampler.samples))
	}
	if sample := bridge.sampler.samples[0]; sample.OutputTokens != 6 ||
		sample.FirstTokenAtMS != 4_000_050 || sample.CompletedAtMS != 4_000_170 {
		t.Fatalf("sample = %#v, want 6 cl100k tokens over 4000050..4000170", sample)
	}
}

// TestCodexResumeMissingOrMismatchedTotalsOmitSpeed verifies a notification
// whose delta disagrees with `last`, or whose breakdown is missing, contributes
// no usage, no sample, and resets the window rather than combining an all-turn
// figure with a partial window.
func TestCodexResumeMissingOrMismatchedTotalsOmitSpeed(t *testing.T) {
	clock := time.UnixMilli(5_000_000)

	// Case 1: the total delta does not equal `last`.
	bridge := newResumeTestBridge(t, &clock)
	bridge.turnID = ""
	bridge.handleNotification(resumeTokenUsage(t, resumeTestThread, resumeTestOldT,
		resumeUsageBreakdown(1000, 500, 100, 1100),
		resumeUsageBreakdown(1000, 500, 100, 1100)))
	bridge.turnID = resumeTestTurn
	bridge.handleNotification(resumeAgentDelta(t, "mismatch"))
	clock = clock.Add(50 * time.Millisecond)
	bridge.handleNotification(resumeTokenUsage(t, resumeTestThread, resumeTestTurn,
		resumeUsageBreakdown(1100, 500, 140, 1240),
		resumeUsageBreakdown(100, 0, 999, 999)))

	if bridge.responseUsageObserved || bridge.responseOutputTokens != 0 {
		t.Fatalf("a mismatched delta must account nothing: %#v", bridge)
	}
	if len(bridge.sampler.samples) != 0 {
		t.Fatalf("a mismatched delta must omit the sample: %#v", bridge.sampler.samples)
	}
	if bridge.resumeUsage.haveBaseline {
		t.Fatalf("a mismatch must reset the window")
	}

	// Case 2: a missing total breakdown after an opened window.
	bridge2 := newResumeTestBridge(t, &clock)
	bridge2.handleNotification(resumeTokenUsage(t, resumeTestThread, resumeTestOldT,
		resumeUsageBreakdown(1000, 500, 100, 1100),
		resumeUsageBreakdown(1000, 500, 100, 1100)))
	bridge2.handleNotification(resumeAgentDelta(t, "missing"))
	clock = clock.Add(50 * time.Millisecond)
	// No tokenUsage object at all.
	bridge2.handleNotification(resumeUnknownNotification(t, "thread/tokenUsage/updated",
		map[string]any{"threadId": resumeTestThread, "turnId": resumeTestTurn}))

	if bridge2.responseUsageObserved || len(bridge2.sampler.samples) != 0 {
		t.Fatalf("a missing breakdown must account nothing and sample nothing: %#v", bridge2)
	}
	if bridge2.resumeUsage.haveBaseline {
		t.Fatalf("a missing breakdown must reset the window")
	}

	// Case 3: a negative field is not a usable token count.
	bridge3 := newResumeTestBridge(t, &clock)
	bridge3.handleNotification(resumeTokenUsage(t, resumeTestThread, resumeTestOldT,
		resumeUsageBreakdown(1000, 500, 100, 1100),
		resumeUsageBreakdown(1000, 500, 100, 1100)))
	bridge3.handleNotification(resumeAgentDelta(t, "negative"))
	clock = clock.Add(50 * time.Millisecond)
	bridge3.handleNotification(resumeTokenUsage(t, resumeTestThread, resumeTestTurn,
		resumeUsageBreakdown(1100, 500, -140, 1240),
		resumeUsageBreakdown(100, 0, -40, 140)))

	if bridge3.responseUsageObserved || len(bridge3.sampler.samples) != 0 {
		t.Fatalf("a negative token count must be rejected: %#v", bridge3)
	}

	// Case 4: a non-monotonic total is a mismatch, not a negative increment.
	bridge4 := newResumeTestBridge(t, &clock)
	bridge4.handleNotification(resumeTokenUsage(t, resumeTestThread, resumeTestOldT,
		resumeUsageBreakdown(1000, 500, 100, 1100),
		resumeUsageBreakdown(1000, 500, 100, 1100)))
	bridge4.handleNotification(resumeAgentDelta(t, "backwards"))
	clock = clock.Add(50 * time.Millisecond)
	bridge4.handleNotification(resumeTokenUsage(t, resumeTestThread, resumeTestTurn,
		resumeUsageBreakdown(900, 500, 80, 980),
		resumeUsageBreakdown(100, 0, 40, 140)))

	if bridge4.responseUsageObserved || len(bridge4.sampler.samples) != 0 {
		t.Fatalf("a non-monotonic total must not be counted: %#v", bridge4)
	}
}

// TestCodexResumeForeignTurnIgnored verifies an unknown or foreign turn
// notification never enters the current turn's stats.
func TestCodexResumeForeignTurnIgnored(t *testing.T) {
	clock := time.UnixMilli(6_000_000)
	bridge := newResumeTestBridge(t, &clock)

	bridge.turnID = ""
	bridge.handleNotification(resumeTokenUsage(t, resumeTestThread, resumeTestOldT,
		resumeUsageBreakdown(1000, 500, 100, 1100),
		resumeUsageBreakdown(1000, 500, 100, 1100)))
	bridge.turnID = resumeTestTurn

	foreignTurn := resumeTokenUsage(t, resumeTestThread, "turn-someone-else",
		resumeUsageBreakdown(9999, 9999, 9999, 29997),
		resumeUsageBreakdown(8999, 9499, 9899, 28897))
	bridge.handleNotification(foreignTurn)

	foreignThread := resumeTokenUsage(t, "thread-someone-else", resumeTestTurn,
		resumeUsageBreakdown(7777, 7777, 7777, 23331),
		resumeUsageBreakdown(6777, 7277, 7677, 22231))
	bridge.handleNotification(foreignThread)

	if bridge.responseUsageObserved || bridge.responseOutputTokens != 0 {
		t.Fatalf("a foreign turn/thread must not enter current stats: %#v", bridge)
	}
	if len(bridge.sampler.samples) != 0 {
		t.Fatalf("a foreign notification must not sample: %#v", bridge.sampler.samples)
	}
	// The baseline is untouched by the foreign notifications.
	want := codexResumeTotals{Input: 1000, Cached: 500, Output: 100, Total: 1100}
	if bridge.resumeUsage.baseline != want {
		t.Fatalf("a foreign notification must not move the baseline: %#v", bridge.resumeUsage.baseline)
	}
}

// TestCodexResumeFreshRunUnaffected verifies a fresh (non-resume) run never
// engages the resume window, so a stray tokenUsage notification is ignored.
func TestCodexResumeFreshRunUnaffected(t *testing.T) {
	clock := time.UnixMilli(7_000_000)
	bridge := newCodexAppServerBridge(codexAppServerAuth{}, codexAppServerInvocation{})
	bridge.sampler = newResponseTPSSampler(func() time.Time { return clock })
	bridge.output = &bytes.Buffer{}
	bridge.threadID = resumeTestThread
	bridge.model = resumeTestModel
	bridge.turnID = resumeTestTurn

	bridge.handleNotification(resumeTokenUsage(t, resumeTestThread, resumeTestTurn,
		resumeUsageBreakdown(5000, 1000, 700, 5700),
		resumeUsageBreakdown(5000, 1000, 700, 5700)))

	if bridge.responseUsageObserved || bridge.responseOutputTokens != 0 || len(bridge.sampler.samples) != 0 {
		t.Fatalf("a fresh run must ignore the resume usage path: %#v", bridge)
	}
}

// lastOutputRecord returns the last JSONL record the bridge wrote.
func lastOutputRecord(t *testing.T, bridge *codexAppServerBridge) map[string]any {
	t.Helper()
	buffer, ok := bridge.output.(*bytes.Buffer)
	if !ok {
		t.Fatalf("bridge output is not a buffer")
	}
	lines := bytes.Split(bytes.TrimSpace(buffer.Bytes()), []byte("\n"))
	if len(lines) == 0 {
		t.Fatalf("bridge wrote no records")
	}
	var record map[string]any
	if err := json.Unmarshal(lines[len(lines)-1], &record); err != nil {
		t.Fatalf("decode record: %v", err)
	}
	return record
}

func mustJSON(t *testing.T, value any) []byte {
	t.Helper()
	body, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return body
}

func TestCodexResumeMissingBaselineDiscardsTiming(t *testing.T) {
	clock := time.UnixMilli(8_000_000)
	bridge := newResumeTestBridge(t, &clock)
	bridge.handleNotification(resumeAgentDelta(t, "first"))
	clock = clock.Add(time.Second)
	bridge.handleNotification(resumeTokenUsage(t, resumeTestThread, resumeTestTurn,
		resumeUsageBreakdown(1000, 500, 100, 1100), resumeUsageBreakdown(1000, 500, 100, 1100)))
	// No delta for the next response: it must not inherit the first window.
	clock = clock.Add(time.Second)
	bridge.handleNotification(resumeTokenUsage(t, resumeTestThread, resumeTestTurn,
		resumeUsageBreakdown(1100, 550, 120, 1220), resumeUsageBreakdown(100, 50, 20, 120)))
	if len(bridge.sampler.samples) != 0 || bridge.responseOutputTokens != 20 {
		t.Fatalf("unjustified sample or wrong usage: samples=%v output=%d", bridge.sampler.samples, bridge.responseOutputTokens)
	}
}

func TestCodexResumeRejectsUnidentifiedUsage(t *testing.T) {
	clock := time.UnixMilli(9_000_000)
	bridge := newResumeTestBridge(t, &clock)
	bridge.handleNotification(resumeAgentDelta(t, "current"))
	for _, turn := range []string{"", "foreign"} {
		bridge.handleNotification(resumeTokenUsage(t, resumeTestThread, turn,
			resumeUsageBreakdown(1000, 500, 100, 1100), resumeUsageBreakdown(1000, 500, 100, 1100)))
	}
	if bridge.resumeUsage.haveBaseline || bridge.responseWindow.gen.blocks == nil {
		t.Fatal("foreign/missing turn identity changed the active window")
	}
}
