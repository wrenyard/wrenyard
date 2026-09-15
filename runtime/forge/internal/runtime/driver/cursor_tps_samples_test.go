package driver

import (
	"io"
	"strconv"
	"testing"
	"time"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/protocol"
)

// cursorTPSTee builds a Cursor Tee whose monotonic-capable clock is driven
// explicitly, and enables sampling for the given launched wire model.
func cursorTPSTee(t *testing.T, model string) (*TranscriptTee, *[]protocol.Event, func(time.Time)) {
	t.Helper()
	var events []protocol.Event
	tee := NewTranscriptTeeWithEventHandler("cursor", io.Discard, func(event protocol.Event) {
		events = append(events, event)
	})
	now := time.UnixMilli(10000)
	tee.now = func() time.Time { return now }
	tee.SetCursorSamplingModel(model)
	return tee, &events, func(at time.Time) { now = at }
}

func writeCursorTPSLine(t *testing.T, tee *TranscriptTee, at time.Time, setClock func(time.Time), line string) {
	t.Helper()
	setClock(at)
	writeCursorLine(t, tee, line)
}

func cursorTPSSamples(t *testing.T, events []protocol.Event) []any {
	t.Helper()
	for _, event := range events {
		if event.Type != "turn_usage" {
			continue
		}
		if event.Data["tps_sampling_contract"] != "response_v1" {
			t.Fatalf("turn_usage missing response_v1 contract: %#v", event.Data)
		}
		return event.Data["tps_samples"].([]any)
	}
	t.Fatalf("no turn_usage emitted: %#v", events)
	return nil
}

func singleCursorSample(t *testing.T, events []protocol.Event) map[string]any {
	t.Helper()
	samples := cursorTPSSamples(t, events)
	if len(samples) != 1 {
		t.Fatalf("want exactly one aggregate sample, got %#v", samples)
	}
	return samples[0].(map[string]any)
}

func cursorWindows(t *testing.T, sample map[string]any) []map[string]any {
	t.Helper()
	raw, ok := sample["generation_windows"].([]any)
	if !ok {
		t.Fatalf("sample missing generation_windows: %#v", sample)
	}
	out := make([]map[string]any, 0, len(raw))
	for _, window := range raw {
		out = append(out, window.(map[string]any))
	}
	return out
}

const cursorTPSInit = `{"type":"system","subtype":"init","session_id":"s1","model":"composer-2.5"}`

func cursorTPSResult(output int) string {
	return `{"type":"result","subtype":"success","is_error":false,"session_id":"s1","request_id":"req-1","usage":{"inputTokens":10,"outputTokens":` + strconv.Itoa(output) + `,"cacheReadTokens":5,"cacheWriteTokens":2}}`
}

// testCursorTranscriptText replays the same lines through the streaming Tee and
// the line-based adapter and requires both to reconstruct identical text.
func testCursorTranscriptText(t *testing.T, lines ...string) string {
	t.Helper()
	tee, events, setClock := cursorTPSTee(t, "composer-2.5")
	base := time.UnixMilli(10000)
	for i, line := range lines {
		writeCursorTPSLine(t, tee, base.Add(time.Duration(i)*time.Second), setClock, line)
	}
	tee.FinalizeCursorStream()

	var streamed string
	for _, event := range *events {
		if event.Type == "message" {
			streamed += event.Data["text"].(string)
		}
	}
	var adapter CursorAdapter
	parsed, err := adapter.ParseResult(writeCursorLog(t, lines...))
	if err != nil {
		t.Fatal(err)
	}
	if parsed != streamed {
		t.Fatalf("ParseResult = %q, Tee = %q", parsed, streamed)
	}
	return streamed
}

// TestCursorTPSValidTextTurnAggregatesExactTerminalTokens verifies the primary
// contract: one sample whose output_tokens is the exact terminal aggregate and
// whose single generation window spans the observed delta boundaries.
func TestCursorTPSValidTextTurnAggregatesExactTerminalTokens(t *testing.T) {
	tee, events, setClock := cursorTPSTee(t, "composer-2.5")
	base := time.UnixMilli(10000)
	writeCursorTPSLine(t, tee, base, setClock, cursorTPSInit)
	writeCursorTPSLine(t, tee, base.Add(200*time.Millisecond), setClock, `{"type":"thinking","subtype":"delta","text":"pondering","timestamp_ms":10200}`)
	writeCursorTPSLine(t, tee, base.Add(500*time.Millisecond), setClock, `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hello"}]},"timestamp_ms":10500}`)
	writeCursorTPSLine(t, tee, base.Add(900*time.Millisecond), setClock, `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":" world"}]},"timestamp_ms":10900}`)
	writeCursorTPSLine(t, tee, base.Add(1200*time.Millisecond), setClock, cursorTPSResult(42))
	tee.FinalizeCursorStream()

	sample := singleCursorSample(t, *events)
	if sample["response_id"] != "cursor-turn:req-1" {
		t.Fatalf("response_id = %v", sample["response_id"])
	}
	if sample["model"] != "composer-2.5" {
		t.Fatalf("model = %v", sample["model"])
	}
	if sample["output_tokens"] != int64(42) {
		t.Fatalf("output_tokens = %v, want 42", sample["output_tokens"])
	}
	windows := cursorWindows(t, sample)
	if len(windows) != 1 || windows[0]["first_token_at_ms"] != int64(10200) || windows[0]["completed_at_ms"] != int64(10900) {
		t.Fatalf("windows = %#v", windows)
	}
}

// TestCursorTPSSerialToolCallsExcludeToolWaits verifies that each serial tool
// call closes the preceding generation window at the tool start and that the
// next generation opens only after the tool completes, so tool wait time is
// excluded from every window.
func TestCursorTPSSerialToolCallsExcludeToolWaits(t *testing.T) {
	tee, events, setClock := cursorTPSTee(t, "composer-2.5")
	base := time.UnixMilli(20000)
	writeCursorTPSLine(t, tee, base, setClock, cursorTPSInit)
	writeCursorTPSLine(t, tee, base.Add(100*time.Millisecond), setClock, `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"first"}]},"timestamp_ms":20100}`)
	writeCursorTPSLine(t, tee, base.Add(300*time.Millisecond), setClock, `{"type":"tool_call","subtype":"started","call_id":"c1","model_call_id":"m1","timestamp_ms":20300,"tool_call":{"shellToolCall":{"args":"{}"}}}`)
	// A long tool execution gap must never be counted as generation time.
	writeCursorTPSLine(t, tee, base.Add(9000*time.Millisecond), setClock, `{"type":"tool_call","subtype":"completed","call_id":"c1","model_call_id":"m1","timestamp_ms":29000,"tool_call":{"shellToolCall":{"result":{"success":{"stdout":"ok"}}}}}`)
	writeCursorTPSLine(t, tee, base.Add(9100*time.Millisecond), setClock, `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"second"}]},"timestamp_ms":29100}`)
	writeCursorTPSLine(t, tee, base.Add(9300*time.Millisecond), setClock, `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":" half"}]},"timestamp_ms":29300}`)
	writeCursorTPSLine(t, tee, base.Add(9500*time.Millisecond), setClock, cursorTPSResult(7))
	tee.FinalizeCursorStream()

	sample := singleCursorSample(t, *events)
	if sample["output_tokens"] != int64(7) {
		t.Fatalf("output_tokens = %v, want 7", sample["output_tokens"])
	}
	windows := cursorWindows(t, sample)
	if len(windows) != 2 {
		t.Fatalf("want two serial windows, got %#v", windows)
	}
	if windows[0]["first_token_at_ms"] != int64(20100) || windows[0]["completed_at_ms"] != int64(20300) {
		t.Fatalf("window 0 = %#v", windows[0])
	}
	if windows[1]["first_token_at_ms"] != int64(29100) || windows[1]["completed_at_ms"] != int64(29300) {
		t.Fatalf("window 1 = %#v", windows[1])
	}
}

// TestCursorTPSDeduplicatesAggregateAssistantSummary verifies the shared
// lookahead deduper: the timestamped partial deltas are real content, the
// timestamped aggregate summary carrying model_call_id and the timestamp-free
// final summary flush are not, so the transcript is never doubled.
func TestCursorTPSDeduplicatesAggregateAssistantSummary(t *testing.T) {
	streamed := testCursorTranscriptText(t,
		cursorTPSInit,
		`{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"draft"}]},"timestamp_ms":10100}`,
		`{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":" more"}]},"timestamp_ms":10400}`,
		`{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"draft more"}]},"timestamp_ms":10450,"model_call_id":"m1"}`,
		`{"type":"tool_call","subtype":"started","call_id":"c1","model_call_id":"m1","timestamp_ms":10450}`,
		`{"type":"tool_call","subtype":"completed","call_id":"c1","model_call_id":"m1","timestamp_ms":10550}`,
		`{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":" final"}]},"timestamp_ms":10700}`,
		`{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":" final"}]}}`,
		cursorTPSResult(5),
	)
	if streamed != "draft more final" {
		t.Fatalf("deduplicated transcript = %q", streamed)
	}
}

// TestCursorTPSRetainsRepeatedIdenticalDeltas verifies equal consecutive real
// deltas are both forwarded: an identical real token is content, not a
// duplicate.
func TestCursorTPSRetainsRepeatedIdenticalDeltas(t *testing.T) {
	streamed := testCursorTranscriptText(t,
		cursorTPSInit,
		`{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"ha"}]},"timestamp_ms":10100}`,
		`{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"ha"}]},"timestamp_ms":10200}`,
		`{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"ha"}]},"timestamp_ms":10300}`,
		cursorTPSResult(5),
	)
	if streamed != "hahaha" {
		t.Fatalf("repeated real deltas = %q, want %q", streamed, "hahaha")
	}
}

// TestCursorTPSRetrySummaryNotDuplicated verifies a retry record repeating the
// whole accumulation suppresses that pending text, so a --stream-partial-output
// transcript that is re-emitted as a timestamped summary is not doubled.
func TestCursorTPSRetrySummaryNotDuplicated(t *testing.T) {
	streamed := testCursorTranscriptText(t,
		cursorTPSInit,
		`{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hello"}]},"timestamp_ms":10100}`,
		`{"type":"retry","message":{"role":"assistant","content":[{"type":"text","text":"hello"}]},"timestamp_ms":10200}`,
		`{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":" world"}]},"timestamp_ms":10300}`,
		cursorTPSResult(5),
	)
	if streamed != "hello world" {
		t.Fatalf("retry-summarized transcript = %q, want %q", streamed, "hello world")
	}
}

// TestCursorTPSInteractionQuerySummaryNotDuplicated verifies the same
// suppression for an interaction_query record.
func TestCursorTPSInteractionQuerySummaryNotDuplicated(t *testing.T) {
	streamed := testCursorTranscriptText(t,
		cursorTPSInit,
		`{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"awaiting"}]},"timestamp_ms":10100}`,
		`{"type":"interaction_query","message":{"role":"assistant","content":[{"type":"text","text":"awaiting"}]},"timestamp_ms":10200}`,
		cursorTPSResult(5),
	)
	if streamed != "awaiting" {
		t.Fatalf("interaction-query transcript = %q, want %q", streamed, "awaiting")
	}
}

// TestCursorTPSPreservesLegacyAssistantOnlyTranscript verifies the deduper
// keeps a legacy non-partial transcript working: distinct full messages with no
// partial deltas are all forwarded.
func TestCursorTPSPreservesLegacyAssistantOnlyTranscript(t *testing.T) {
	streamed := testCursorTranscriptText(t,
		`{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"one"}]}}`,
		`{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"two"}]}}`,
	)
	if streamed != "onetwo" {
		t.Fatalf("legacy transcript = %q, want %q", streamed, "onetwo")
	}
}

// TestCursorTPSMissingTimestampNonSummaryPoisons verifies a timestamp-free
// assistant record that does NOT repeat the accumulated partial text is a
// coverage gap: it is forwarded as content but never assumed to be a harmless
// summary, so no sample is produced.
func TestCursorTPSMissingTimestampNonSummaryPoisons(t *testing.T) {
	streamed := testCursorTranscriptText(t,
		cursorTPSInit,
		`{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"partial"}]},"timestamp_ms":40100}`,
		`{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":" unaccounted"}]}}`,
	)
	if streamed != "partial unaccounted" {
		t.Fatalf("transcript = %q, want %q", streamed, "partial unaccounted")
	}
}

func TestCursorTPSRejectsUnsafeStreams(t *testing.T) {
	base := time.UnixMilli(40000)
	for _, tc := range []struct {
		name  string
		lines []struct {
			at   time.Duration
			line string
		}
	}{
		{
			name: "retry",
			lines: []struct {
				at   time.Duration
				line string
			}{
				{0, cursorTPSInit},
				{100 * time.Millisecond, `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"x"}]},"timestamp_ms":40100}`},
				{150 * time.Millisecond, `{"type":"retry"}`},
				{400 * time.Millisecond, cursorTPSResult(3)},
			},
		},
		{
			name: "connection",
			lines: []struct {
				at   time.Duration
				line string
			}{
				{0, cursorTPSInit},
				{100 * time.Millisecond, `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"x"}]},"timestamp_ms":40100}`},
				{150 * time.Millisecond, `{"type":"connection"}`},
				{400 * time.Millisecond, cursorTPSResult(3)},
			},
		},
		{
			name: "reconnect",
			lines: []struct {
				at   time.Duration
				line string
			}{
				{0, cursorTPSInit},
				{100 * time.Millisecond, `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"x"}]},"timestamp_ms":40100}`},
				{150 * time.Millisecond, `{"type":"reconnecting"}`},
				{400 * time.Millisecond, cursorTPSResult(3)},
			},
		},
		{
			name: "all record session mismatch",
			lines: []struct {
				at   time.Duration
				line string
			}{
				{0, `{"type":"system","subtype":"init","session_id":"s2","model":"composer-2.5"}`},
				{100 * time.Millisecond, `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"x"}]},"timestamp_ms":40100}`},
				{400 * time.Millisecond, cursorTPSResult(3)},
			},
		},
		{
			name: "mismatched completed model call id",
			lines: []struct {
				at   time.Duration
				line string
			}{
				{0, cursorTPSInit},
				{100 * time.Millisecond, `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"x"}]},"timestamp_ms":40100}`},
				{200 * time.Millisecond, `{"type":"tool_call","subtype":"started","call_id":"c1","model_call_id":"m1","timestamp_ms":40200,"tool_call":{"shellToolCall":{"args":"{}"}}}`},
				{300 * time.Millisecond, `{"type":"tool_call","subtype":"completed","call_id":"c1","model_call_id":"m2","timestamp_ms":40300,"tool_call":{"shellToolCall":{"result":{"success":{"stdout":"ok"}}}}}`},
				{400 * time.Millisecond, `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"y"}]},"timestamp_ms":40400}`},
				{500 * time.Millisecond, cursorTPSResult(3)},
			},
		},
		{
			name: "nonmonotonic tool completion",
			lines: []struct {
				at   time.Duration
				line string
			}{
				{0, cursorTPSInit},
				{200 * time.Millisecond, `{"type":"thinking","subtype":"delta","text":"p","timestamp_ms":40200}`},
				{300 * time.Millisecond, `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"x"}]},"timestamp_ms":40300}`},
				{400 * time.Millisecond, `{"type":"tool_call","subtype":"started","call_id":"c1","model_call_id":"m1","timestamp_ms":40400,"tool_call":{"shellToolCall":{"args":"{}"}}}`},
				{500 * time.Millisecond, `{"type":"tool_call","subtype":"completed","call_id":"c1","model_call_id":"m1","timestamp_ms":40250,"tool_call":{"shellToolCall":{"result":{"success":{"stdout":"ok"}}}}}`},
				{600 * time.Millisecond, cursorTPSResult(3)},
			},
		},
		{
			name: "generation while tool pending",
			lines: []struct {
				at   time.Duration
				line string
			}{
				{0, cursorTPSInit},
				{100 * time.Millisecond, `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"x"}]},"timestamp_ms":40100}`},
				{200 * time.Millisecond, `{"type":"tool_call","subtype":"started","call_id":"c1","model_call_id":"m1","timestamp_ms":40200,"tool_call":{"shellToolCall":{"args":"{}"}}}`},
				{300 * time.Millisecond, `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"y"}]},"timestamp_ms":40300}`},
				{400 * time.Millisecond, `{"type":"tool_call","subtype":"completed","call_id":"c1","model_call_id":"m1","timestamp_ms":40400,"tool_call":{"shellToolCall":{"result":{"success":{"stdout":"ok"}}}}}`},
				{500 * time.Millisecond, cursorTPSResult(3)},
			},
		},
		{
			name: "unknown tool completion",
			lines: []struct {
				at   time.Duration
				line string
			}{
				{0, cursorTPSInit},
				{100 * time.Millisecond, `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"x"}]},"timestamp_ms":40100}`},
				{200 * time.Millisecond, `{"type":"tool_call","subtype":"completed","call_id":"ghost","model_call_id":"m1","timestamp_ms":40200}`},
				{400 * time.Millisecond, cursorTPSResult(3)},
			},
		},
		{
			name: "parallel tool stream",
			lines: []struct {
				at   time.Duration
				line string
			}{
				{0, cursorTPSInit},
				{100 * time.Millisecond, `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"x"}]},"timestamp_ms":40100}`},
				{200 * time.Millisecond, `{"type":"tool_call","subtype":"started","call_id":"c1","model_call_id":"m1","timestamp_ms":40200,"tool_call":{"shellToolCall":{"args":"{}"}}}`},
				{250 * time.Millisecond, `{"type":"tool_call","subtype":"started","call_id":"c2","model_call_id":"m2","timestamp_ms":40250,"tool_call":{"shellToolCall":{"args":"{}"}}}`},
				{400 * time.Millisecond, cursorTPSResult(3)},
			},
		},
		{
			name: "reused model call group",
			lines: []struct {
				at   time.Duration
				line string
			}{
				{0, cursorTPSInit},
				{100 * time.Millisecond, `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"x"}]},"timestamp_ms":40100}`},
				{200 * time.Millisecond, `{"type":"tool_call","subtype":"started","call_id":"c1","model_call_id":"m1","timestamp_ms":40200,"tool_call":{"shellToolCall":{"args":"{}"}}}`},
				{300 * time.Millisecond, `{"type":"tool_call","subtype":"completed","call_id":"c1","model_call_id":"m1","timestamp_ms":40300,"tool_call":{"shellToolCall":{"result":{"success":{"stdout":"ok"}}}}}`},
				{400 * time.Millisecond, `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"y"}]},"timestamp_ms":40400}`},
				{500 * time.Millisecond, `{"type":"tool_call","subtype":"started","call_id":"c9","model_call_id":"m1","timestamp_ms":40500,"tool_call":{"shellToolCall":{"args":"{}"}}}`},
				{600 * time.Millisecond, cursorTPSResult(3)},
			},
		},
		{
			name: "direct tool only response",
			lines: []struct {
				at   time.Duration
				line string
			}{
				{0, cursorTPSInit},
				{100 * time.Millisecond, `{"type":"tool_call","subtype":"started","call_id":"c1","model_call_id":"m1","timestamp_ms":40100,"tool_call":{"shellToolCall":{"args":"{}"}}}`},
				{400 * time.Millisecond, cursorTPSResult(3)},
			},
		},
		{
			name: "missing delta timestamp",
			lines: []struct {
				at   time.Duration
				line string
			}{
				{0, cursorTPSInit},
				{100 * time.Millisecond, `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"x"}]}}`},
				{400 * time.Millisecond, cursorTPSResult(3)},
			},
		},
		{
			name: "nonmonotonic timestamps",
			lines: []struct {
				at   time.Duration
				line string
			}{
				{0, cursorTPSInit},
				{100 * time.Millisecond, `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"x"}]},"timestamp_ms":40500}`},
				{200 * time.Millisecond, `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"y"}]},"timestamp_ms":40200}`},
				{400 * time.Millisecond, cursorTPSResult(3)},
			},
		},
		{
			name: "session change",
			lines: []struct {
				at   time.Duration
				line string
			}{
				{0, cursorTPSInit},
				{100 * time.Millisecond, `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"x"}]},"timestamp_ms":40100}`},
				{400 * time.Millisecond, `{"type":"result","subtype":"success","is_error":false,"session_id":"s2","request_id":"req-1","usage":{"inputTokens":1,"outputTokens":3,"cacheReadTokens":0,"cacheWriteTokens":0}}`},
			},
		},
		{
			name: "truncated terminal",
			lines: []struct {
				at   time.Duration
				line string
			}{
				{0, cursorTPSInit},
				{100 * time.Millisecond, `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"x"}]},"timestamp_ms":40100}`},
				{400 * time.Millisecond, `{"type":"result","subtype":"success"}`},
			},
		},
		{
			name: "duplicate terminal",
			lines: []struct {
				at   time.Duration
				line string
			}{
				{0, cursorTPSInit},
				{100 * time.Millisecond, `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"x"}]},"timestamp_ms":40100}`},
				{400 * time.Millisecond, cursorTPSResult(3)},
				{600 * time.Millisecond, cursorTPSResult(3)},
			},
		},
		{
			name: "failed terminal",
			lines: []struct {
				at   time.Duration
				line string
			}{
				{0, cursorTPSInit},
				{100 * time.Millisecond, `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"x"}]},"timestamp_ms":40100}`},
				{400 * time.Millisecond, `{"type":"result","subtype":"error","is_error":true,"error":"boom","session_id":"s1","request_id":"req-1","usage":{"inputTokens":1,"outputTokens":3,"cacheReadTokens":0,"cacheWriteTokens":0}}`},
			},
		},
		{
			name: "invalid usage",
			lines: []struct {
				at   time.Duration
				line string
			}{
				{0, cursorTPSInit},
				{100 * time.Millisecond, `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"x"}]},"timestamp_ms":40100}`},
				{400 * time.Millisecond, `{"type":"result","subtype":"success","is_error":false,"session_id":"s1","request_id":"req-1","usage":{"inputTokens":1,"outputTokens":1.5,"cacheReadTokens":0,"cacheWriteTokens":0}}`},
			},
		},
		{
			name: "missing request id",
			lines: []struct {
				at   time.Duration
				line string
			}{
				{0, cursorTPSInit},
				{100 * time.Millisecond, `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"x"}]},"timestamp_ms":40100}`},
				{400 * time.Millisecond, `{"type":"result","subtype":"success","is_error":false,"session_id":"s1","usage":{"inputTokens":1,"outputTokens":3,"cacheReadTokens":0,"cacheWriteTokens":0}}`},
			},
		},
		{
			name: "collapsed window below minimum",
			lines: []struct {
				at   time.Duration
				line string
			}{
				{0, cursorTPSInit},
				{100 * time.Millisecond, `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"x"}]},"timestamp_ms":40100}`},
				{150 * time.Millisecond, cursorTPSResult(3)},
			},
		},
		{
			name: "missing terminal",
			lines: []struct {
				at   time.Duration
				line string
			}{
				{0, cursorTPSInit},
				{100 * time.Millisecond, `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"x"}]},"timestamp_ms":40100}`},
			},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			tee, events, setClock := cursorTPSTee(t, "composer-2.5")
			for _, entry := range tc.lines {
				writeCursorTPSLine(t, tee, base.Add(entry.at), setClock, entry.line)
			}
			tee.FinalizeCursorStream()
			for _, event := range *events {
				if event.Type != "turn_usage" {
					continue
				}
				if _, present := event.Data["tps_samples"]; present {
					t.Fatalf("unsafe stream produced a sample: %#v", event.Data)
				}
			}
		})
	}
}

// TestCursorTPSSamplingDisabledWithoutExplicitModel verifies no sample is
// produced when no explicit nonempty non-auto launched model is configured.
func TestCursorTPSSamplingDisabledWithoutExplicitModel(t *testing.T) {
	for _, model := range []string{"", "auto", "  "} {
		t.Run(model, func(t *testing.T) {
			var events []protocol.Event
			tee := NewTranscriptTeeWithEventHandler("cursor", io.Discard, func(event protocol.Event) {
				events = append(events, event)
			})
			now := time.UnixMilli(50000)
			tee.now = func() time.Time { return now }
			tee.SetCursorSamplingModel(model)
			writeCursorLine(t, tee, cursorTPSInit)
			now = now.Add(100 * time.Millisecond)
			writeCursorLine(t, tee, `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"x"}]},"timestamp_ms":50100}`)
			now = now.Add(300 * time.Millisecond)
			writeCursorLine(t, tee, cursorTPSResult(3))
			tee.FinalizeCursorStream()
			for _, event := range events {
				if event.Type != "turn_usage" {
					continue
				}
				if _, present := event.Data["tps_samples"]; present {
					t.Fatalf("unconfigured model produced a sample: %#v", event.Data)
				}
			}
		})
	}
}

// TestCursorTPSRejectsExcludedBackgroundTools verifies subagent/background tool
// records poison the sample: the exclusion is keyed on the actual tool_call key
// (taskToolCall/subagentToolCall), never on an unrelated description, and a
// nested isBackground=true argument is still rejected.
func TestCursorTPSRejectsExcludedBackgroundTools(t *testing.T) {
	for _, line := range []string{
		`{"type":"tool_call","subtype":"started","call_id":"c1","model_call_id":"m1","timestamp_ms":40200,"tool_call":{"taskToolCall":{"args":"{}"}}}`,
		`{"type":"tool_call","subtype":"started","call_id":"c1","model_call_id":"m1","timestamp_ms":40200,"tool_call":{"subagentToolCall":{"args":"{}"}}}`,
		`{"type":"tool_call","subtype":"started","call_id":"c1","model_call_id":"m1","timestamp_ms":40200,"tool_call":{"shellToolCall":{"args":{"isBackground":true}}}}`,
	} {
		t.Run(line, func(t *testing.T) {
			tee, events, setClock := cursorTPSTee(t, "composer-2.5")
			base := time.UnixMilli(40000)
			writeCursorTPSLine(t, tee, base, setClock, cursorTPSInit)
			writeCursorTPSLine(t, tee, base.Add(100*time.Millisecond), setClock, `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"x"}]},"timestamp_ms":40100}`)
			writeCursorTPSLine(t, tee, base.Add(200*time.Millisecond), setClock, line)
			writeCursorTPSLine(t, tee, base.Add(500*time.Millisecond), setClock, cursorTPSResult(3))
			tee.FinalizeCursorStream()
			for _, event := range *events {
				if event.Type == "turn_usage" {
					if _, present := event.Data["tps_samples"]; present {
						t.Fatalf("excluded tool produced a sample: %#v", event.Data)
					}
				}
			}
		})
	}
}

// TestCursorTPSAllowsShellToolWithTaskDescription verifies an ordinary shell
// tool is not excluded merely because its description mentions a task: the
// exclusion keys on the actual tool_call key, not on prose.
func TestCursorTPSAllowsShellToolWithTaskDescription(t *testing.T) {
	tee, events, setClock := cursorTPSTee(t, "composer-2.5")
	base := time.UnixMilli(60000)
	writeCursorTPSLine(t, tee, base, setClock, cursorTPSInit)
	writeCursorTPSLine(t, tee, base.Add(100*time.Millisecond), setClock, `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"x"}]},"timestamp_ms":60100}`)
	writeCursorTPSLine(t, tee, base.Add(300*time.Millisecond), setClock, `{"type":"tool_call","subtype":"started","call_id":"c1","model_call_id":"m1","timestamp_ms":60300,"tool_call":{"shellToolCall":{"args":"{}","description":"run the task list"}}}`)
	writeCursorTPSLine(t, tee, base.Add(600*time.Millisecond), setClock, `{"type":"tool_call","subtype":"completed","call_id":"c1","model_call_id":"m1","timestamp_ms":60600,"tool_call":{"shellToolCall":{"result":{"success":{"stdout":"ok"}}}}}`)
	writeCursorTPSLine(t, tee, base.Add(700*time.Millisecond), setClock, `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"y"}]},"timestamp_ms":60700}`)
	writeCursorTPSLine(t, tee, base.Add(850*time.Millisecond), setClock, `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"z"}]},"timestamp_ms":60850}`)
	writeCursorTPSLine(t, tee, base.Add(900*time.Millisecond), setClock, cursorTPSResult(3))
	tee.FinalizeCursorStream()
	singleCursorSample(t, *events)
}
