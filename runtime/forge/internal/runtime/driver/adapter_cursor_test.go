package driver

import (
	"io"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/protocol"
)

func writeCursorLog(t *testing.T, lines ...string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "cursor.jsonl")
	var sb strings.Builder
	for _, line := range lines {
		sb.WriteString(line)
		sb.WriteString("\n")
	}
	if err := os.WriteFile(path, []byte(sb.String()), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func newCursorTee(t *testing.T) (*TranscriptTee, *[]protocol.Event) {
	t.Helper()
	var events []protocol.Event
	tee := NewTranscriptTeeWithEventHandler("cursor", io.Discard, func(event protocol.Event) {
		events = append(events, event)
	})
	tee.now = (&fakeClock{t: time.Date(2026, 8, 11, 0, 0, 0, 0, time.UTC)}).Now
	return tee, &events
}

func writeCursorLine(t *testing.T, tee *TranscriptTee, line string) {
	t.Helper()
	if _, err := tee.Write([]byte(line + "\n")); err != nil {
		t.Fatal(err)
	}
}

// TestCursorTeeAggregatesAssistantTextAndEmitsExactlyOneUsage verifies the
// complete-success contract against the sanitized wire shape: assistant text
// aggregates from message.content text blocks into a single message, exactly
// one canonical turn_usage is emitted before the terminal run_finished, full
// cached input is the cache read+write sum counted once, and total_tokens is
// the additive sum of all four partitions.
func TestCursorTeeAggregatesAssistantTextAndEmitsExactlyOneUsage(t *testing.T) {
	tee, events := newCursorTee(t)
	writeCursorLine(t, tee, `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"draft"}]}}`)
	writeCursorLine(t, tee, `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":" more"}]}}`)
	writeCursorLine(t, tee, `{"type":"result","subtype":"success","is_error":false,"duration_ms":11717,"session_id":"s1","request_id":"r1","usage":{"inputTokens":10,"outputTokens":3,"cacheReadTokens":5,"cacheWriteTokens":2}}`)

	if got := countTurnUsage(*events); got != 0 {
		t.Fatalf("turn_usage streamed before finalization: %d", got)
	}
	tee.FinalizeCursorStream()

	var assistantText string
	for _, event := range *events {
		if event.Type == "message" {
			assistantText += event.Data["text"].(string)
		}
	}
	if assistantText != "draft more" {
		t.Fatalf("aggregated assistant text = %q, want %q", assistantText, "draft more")
	}
	if got := countTurnUsage(*events); got != 1 {
		t.Fatalf("turn_usage count = %d, want 1", got)
	}
	if (*events)[len(*events)-1].Type != protocol.EventRunFinished {
		t.Fatalf("terminal run_finished is not the final event: %#v", *events)
	}
	data := lastTurnUsage(*events)
	want := map[string]any{
		"input_tokens":                10,
		"output_tokens":               3,
		"cache_read_input_tokens":     5,
		"cache_creation_input_tokens": 2,
		// Full cached input counted once: read + write.
		"cached_input_tokens": 7,
		// Additive sum of all four partitions.
		"total_tokens":   20,
		"duration_ms":    11717,
		"token_scope":    "agent_turn",
		"duration_scope": "agent_turn",
		"tps_contract":   "agent_turn_v1",
	}
	if !reflect.DeepEqual(data, want) {
		t.Fatalf("canonical usage mismatch\nwant: %#v\n got: %#v", want, data)
	}
}

// TestCursorTeeIgnoresCompletedSubtypesOnNonTerminalRecords covers the live
// Cursor wire sequence, where both thinking and tool calls use
// subtype=completed before the final result. Those records must not be counted
// as run terminals or poison the otherwise trustworthy usage contract.
func TestCursorTeeIgnoresCompletedSubtypesOnNonTerminalRecords(t *testing.T) {
	tee, events := newCursorTee(t)
	writeCursorLine(t, tee, `{"type":"thinking","subtype":"completed","session_id":"s1"}`)
	writeCursorLine(t, tee, `{"type":"tool_call","subtype":"started","call_id":"c1","tool_call":{"shellToolCall":{"args":{"command":"pwd"}}}}`)
	writeCursorLine(t, tee, `{"type":"tool_call","subtype":"completed","call_id":"c1","tool_call":{"shellToolCall":{"result":{"success":{"stdout":"/workspace\n","stderr":"","exitCode":0}}}}}`)
	writeCursorLine(t, tee, `{"type":"result","subtype":"success","is_error":false,"duration_ms":11717,"session_id":"s1","usage":{"inputTokens":10,"outputTokens":3,"cacheReadTokens":5,"cacheWriteTokens":2}}`)
	tee.FinalizeCursorStream()

	usage := lastTurnUsage(*events)
	if usage["token_scope"] != "agent_turn" || usage["duration_scope"] != "agent_turn" || usage["tps_contract"] != "agent_turn_v1" {
		t.Fatalf("non-terminal completed subtypes poisoned trusted usage: %#v", usage)
	}
	if got := countTurnUsage(*events); got != 1 {
		t.Fatalf("turn_usage count = %d, want 1", got)
	}
}

// TestCursorTeePairsToolsByCallID verifies tool_call records pair by the
// top-level call_id across started/completed subtypes, deriving a stable
// snake-case tool name from the single nested shellToolCall object and reading
// the completed result safely from result.success.
func TestCursorTeePairsToolsByCallID(t *testing.T) {
	tee, events := newCursorTee(t)
	writeCursorLine(t, tee, `{"type":"tool_call","subtype":"started","call_id":"c1","tool_call":{"shellToolCall":{"args":{"command":"pwd","workingDirectory":"/workspace"},"description":"Print working directory"}}}`)
	writeCursorLine(t, tee, `{"type":"tool_call","subtype":"completed","call_id":"c1","tool_call":{"shellToolCall":{"args":{"command":"pwd","workingDirectory":"/workspace"},"result":{"success":{"stdout":"/workspace\n","stderr":"","exitCode":0}},"description":"Print working directory"}}}`)
	writeCursorLine(t, tee, `{"type":"result","subtype":"success","is_error":false,"duration_ms":1,"session_id":"s1","usage":{"inputTokens":1,"outputTokens":1,"cacheReadTokens":0,"cacheWriteTokens":0}}`)
	tee.FinalizeCursorStream()

	var calls, results int
	for _, event := range *events {
		switch event.Type {
		case "tool_call":
			calls++
			if event.Data["call_id"] != "c1" || event.Data["name"] != "shell_tool_call" {
				t.Fatalf("bad tool_call: %#v", event.Data)
			}
			if summary := event.Data["input_summary"].(string); !strings.Contains(summary, "pwd") {
				t.Fatalf("tool_call missing args summary: %q", summary)
			}
		case "tool_result":
			results++
			if event.Data["call_id"] != "c1" || event.Data["status"] != "ok" {
				t.Fatalf("bad tool_result: %#v", event.Data)
			}
			if tail := event.Data["output_tail"].(string); !strings.Contains(tail, "/workspace") {
				t.Fatalf("tool_result missing stdout tail: %q", tail)
			}
		}
	}
	if calls != 1 || results != 1 {
		t.Fatalf("tool pairs = %d/%d, want 1/1", calls, results)
	}
}

// TestCursorAdapterSessionAndResult verifies the transcript parser extracts
// the native session id and a bounded final result from the sanitized wire
// shape without native payload leakage.
func TestCursorAdapterSessionAndResult(t *testing.T) {
	path := writeCursorLog(t,
		`{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hello"}]}}`,
		`{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":" world"}]}}`,
		`{"type":"result","subtype":"success","is_error":false,"duration_ms":1,"session_id":"sess_abc","usage":{"inputTokens":1,"outputTokens":1,"cacheReadTokens":0,"cacheWriteTokens":0}}`,
	)
	adapter := &CursorAdapter{}
	session, err := adapter.ParseSessionID(path)
	if err != nil {
		t.Fatal(err)
	}
	if session != "sess_abc" {
		t.Fatalf("session = %q, want sess_abc", session)
	}
	result, err := adapter.ParseResult(path)
	if err != nil {
		t.Fatal(err)
	}
	if result != "hello world" {
		t.Fatalf("result = %q, want %q", result, "hello world")
	}
}

// TestCursorTeeFailureCarriesNoTrustField verifies a complete native failure
// (subtype=error / is_error=true) produces a run_finished failure and a
// turn_usage without any agent_turn_v1 trust claim.
func TestCursorTeeFailureCarriesNoTrustField(t *testing.T) {
	tee, events := newCursorTee(t)
	writeCursorLine(t, tee, `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"partial"}]}}`)
	writeCursorLine(t, tee, `{"type":"result","subtype":"error","is_error":true,"duration_ms":500,"error":"boom","session_id":"s1","usage":{"inputTokens":10,"outputTokens":2,"cacheReadTokens":0,"cacheWriteTokens":0}}`)
	tee.FinalizeCursorStream()

	data := lastTurnUsage(*events)
	if _, ok := data["tps_contract"]; ok {
		t.Fatalf("failure usage must not claim trust: %#v", data)
	}
	if (*events)[len(*events)-1].Data["status"] != "failed" {
		t.Fatalf("terminal status = %v, want failed", (*events)[len(*events)-1].Data["status"])
	}
}

// TestCursorTeeDuplicateTerminalFailsClosed verifies that two terminal records
// make the stream untrusted and suppress the trust contract.
func TestCursorTeeDuplicateTerminalFailsClosed(t *testing.T) {
	tee, events := newCursorTee(t)
	writeCursorLine(t, tee, `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"x"}]}}`)
	writeCursorLine(t, tee, `{"type":"result","subtype":"success","is_error":false,"duration_ms":1,"session_id":"s1","usage":{"inputTokens":10,"outputTokens":2,"cacheReadTokens":0,"cacheWriteTokens":0}}`)
	writeCursorLine(t, tee, `{"type":"result","subtype":"success","is_error":false,"duration_ms":1,"session_id":"s1","usage":{"inputTokens":1,"outputTokens":1,"cacheReadTokens":0,"cacheWriteTokens":0}}`)
	tee.FinalizeCursorStream()

	data := lastTurnUsage(*events)
	if _, ok := data["tps_contract"]; ok {
		t.Fatalf("duplicate terminal usage must not claim trust: %#v", data)
	}
}

// TestCursorTeeMalformedFailsClosed verifies a non-JSON record poisons the
// stream so the usage never claims trust.
func TestCursorTeeMalformedFailsClosed(t *testing.T) {
	tee, events := newCursorTee(t)
	writeCursorLine(t, tee, `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"x"}]}}`)
	writeCursorLine(t, tee, `this is not json`)
	writeCursorLine(t, tee, `{"type":"result","subtype":"success","is_error":false,"duration_ms":1,"session_id":"s1","usage":{"inputTokens":10,"outputTokens":2,"cacheReadTokens":0,"cacheWriteTokens":0}}`)
	tee.FinalizeCursorStream()

	data := lastTurnUsage(*events)
	if _, ok := data["tps_contract"]; ok {
		t.Fatalf("malformed usage must not claim trust: %#v", data)
	}
}

// TestCursorTeeTruncatedFinalRecordFailsClosed verifies a final partial JSON
// record (no terminal) leaves the stream incomplete so usage never claims
// trust.
func TestCursorTeeTruncatedFinalRecordFailsClosed(t *testing.T) {
	tee, events := newCursorTee(t)
	writeCursorLine(t, tee, `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"x"}]}}`)
	// Final record without a trailing newline and no terminal boundary.
	if _, err := tee.Write([]byte(`{"type":"result","subtype":"success"`)); err != nil {
		t.Fatal(err)
	}
	tee.FinalizeCursorStream()

	data := lastTurnUsage(*events)
	if _, ok := data["tps_contract"]; ok {
		t.Fatalf("truncated usage must not claim trust: %#v", data)
	}
}

// TestCursorTeeBoundsToolOutput verifies tool output is truncated to the
// output byte ceiling so native payloads never leak unbounded.
func TestCursorTeeBoundsToolOutput(t *testing.T) {
	tee, events := newCursorTee(t)
	big := strings.Repeat("z", 2*outputTailMaxBytes+10)
	writeCursorLine(t, tee, `{"type":"tool_call","subtype":"started","call_id":"c1","tool_call":{"shellToolCall":{"args":{"command":"cat"}}}}`)
	writeCursorLine(t, tee, `{"type":"tool_call","subtype":"completed","call_id":"c1","tool_call":{"shellToolCall":{"result":{"success":{"stdout":"`+big+`","stderr":"","exitCode":0}}}}}`)
	writeCursorLine(t, tee, `{"type":"result","subtype":"success","is_error":false,"duration_ms":1,"session_id":"s1","usage":{"inputTokens":1,"outputTokens":1,"cacheReadTokens":0,"cacheWriteTokens":0}}`)
	tee.FinalizeCursorStream()

	for _, event := range *events {
		if event.Type != "tool_result" {
			continue
		}
		out := event.Data["output_tail"].(string)
		if len(out) > outputTailMaxBytes {
			t.Fatalf("tool output tail = %d bytes, want <= %d", len(out), outputTailMaxBytes)
		}
	}
}

// TestCursorTeeOverflowFailsClosed verifies an overflow in the cached-input
// sum fails closed and never claims trust.
func TestCursorTeeOverflowFailsClosed(t *testing.T) {
	tee, events := newCursorTee(t)
	// 2^62 each: the cached-input sum overflows int.
	huge := "4611686018427387904"
	writeCursorLine(t, tee, `{"type":"result","subtype":"success","is_error":false,"duration_ms":1,"session_id":"s1","usage":{"inputTokens":1,"outputTokens":1,"cacheReadTokens":`+huge+`,"cacheWriteTokens":`+huge+`}}`)
	tee.FinalizeCursorStream()

	data := lastTurnUsage(*events)
	if _, ok := data["tps_contract"]; ok {
		t.Fatalf("overflow usage must not claim trust: %#v", data)
	}
}
