package driver

import (
	"bytes"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/protocol"
)

func countTurnUsage(events []protocol.Event) int {
	count := 0
	for _, event := range events {
		if event.Type == "turn_usage" {
			count++
		}
	}
	return count
}

func lastTurnUsage(events []protocol.Event) map[string]any {
	var data map[string]any
	for _, event := range events {
		if event.Type == "turn_usage" {
			data = event.Data
		}
	}
	return data
}

// TestGrokTeeEmitsSingleCanonicalUsageFromFinalEndAggregate is the regression
// test for doubled Grok TOKEN accounting. Grok 1.0.0 native streaming-json
// emits early native usage records and one final end aggregate; the tee used
// to forward a turn_usage per usage-bearing line. It must buffer usage at the
// Tee stream layer, keep messages available at native response boundaries,
// and emit exactly one canonical turn_usage on finalization whose token totals
// are the final end aggregate, carrying a positive agent_turn duration measured
// from the first native record to finalization.
func TestGrokTeeEmitsSingleCanonicalUsageFromFinalEndAggregate(t *testing.T) {
	clock := &fakeClock{t: time.Date(2026, 6, 1, 0, 0, 0, 0, time.UTC)}
	var events []protocol.Event
	tee := NewTranscriptTeeWithEventHandler("grok", io.Discard, func(event protocol.Event) {
		events = append(events, event)
	})
	tee.now = clock.Now

	write := func(line string) {
		t.Helper()
		if _, err := tee.Write([]byte(line + "\n")); err != nil {
			t.Fatal(err)
		}
	}
	write(`{"type":"text","data":"draft","usage":{"input_tokens":10,"output_tokens":2}}`)
	clock.Advance(300 * time.Millisecond)
	write(`{"type":"text","data":" more","usage":{"input_tokens":12,"output_tokens":3}}`)
	clock.Advance(700 * time.Millisecond)
	write(`{"type":"end","stopReason":"EndTurn","sessionId":"s1","usage":{"input_tokens":100,"output_tokens":40}}`)

	if got := countTurnUsage(events); got != 0 {
		t.Fatalf("turn_usage streamed before finalization: count=%d events=%#v", got, events)
	}
	clock.Advance(1000 * time.Millisecond)
	validity := tee.FinalizeGrokStream()
	if !validity.IsValid() {
		t.Fatalf("validity = %+v, want valid success", validity)
	}
	if got := countTurnUsage(events); got != 1 {
		t.Fatalf("turn_usage count = %d, want 1; events=%#v", got, events)
	}
	// The canonical usage must precede the terminal event: execution relies on
	// run_finished being the final normalized event of a valid attempt.
	if events[len(events)-1].Type != protocol.EventRunFinished {
		t.Fatalf("terminal run_finished is not the final event: %#v", events)
	}
	data := lastTurnUsage(events)
	want := map[string]any{
		"input_tokens":   float64(100),
		"output_tokens":  float64(40),
		"duration_ms":    2000,
		"token_scope":    "agent_turn",
		"duration_scope": "agent_turn",
		"tps_contract":   "agent_turn_v1",
	}
	if !reflect.DeepEqual(data, want) {
		t.Fatalf("canonical usage mismatch\nwant: %#v\n got: %#v", want, data)
	}
}

func TestGrokTeeCoalescesTextChunksPerNativeResponse(t *testing.T) {
	var events []protocol.Event
	tee := NewTranscriptTeeWithEventHandler("grok", io.Discard, func(event protocol.Event) {
		events = append(events, event)
	})

	write := func(line string) {
		t.Helper()
		if _, err := tee.Write([]byte(line + "\n")); err != nil {
			t.Fatal(err)
		}
	}
	write(`{"type":"text","data":"I"}`)
	write(`{"type":"text","data":"'ll"}`)
	write(`{"type":"text","data":" start"}`)
	write(`{"type":"text","data":" by"}`)
	write(`{"type":"text","data":" inspect"}`)
	write(`{"type":"text","data":"ing"}`)
	if len(events) != 0 {
		t.Fatalf("text chunks leaked before a response boundary: %#v", events)
	}
	write(`{"type":"usage","messageId":"response-1","stopReason":"tool_use","usage":{"input_tokens":10,"output_tokens":6}}`)
	write(`{"type":"tool_call","toolCallId":"call-1","toolName":"read_file","status":"in_progress"}`)
	write(`{"type":"tool_call_update","toolCallId":"call-1","status":"completed"}`)
	write(`{"type":"text","data":"Done"}`)
	write(`{"type":"text","data":"."}`)
	write(`{"type":"usage","messageId":"response-2","stopReason":"end_turn","usage":{"input_tokens":12,"output_tokens":2}}`)
	write(`{"type":"end","stopReason":"EndTurn","sessionId":"s1","usage":{"input_tokens":22,"output_tokens":8}}`)
	tee.FinalizeGrokStream()

	var messages []string
	for _, event := range events {
		if event.Type == "message" {
			messages = append(messages, event.Data["text"].(string))
		}
	}
	want := []string{"I'll start by inspecting", "Done."}
	if !reflect.DeepEqual(messages, want) {
		t.Fatalf("coalesced messages mismatch\nwant: %#v\n got: %#v\nevents: %#v", want, messages, events)
	}
}

func TestGrokTeeFlushesPartialMessageWhenStreamIsIncomplete(t *testing.T) {
	var events []protocol.Event
	tee := NewTranscriptTeeWithEventHandler("grok", io.Discard, func(event protocol.Event) {
		events = append(events, event)
	})
	if _, err := tee.Write([]byte("{\"type\":\"text\",\"data\":\"partial\"}\n")); err != nil {
		t.Fatal(err)
	}
	validity := tee.FinalizeGrokStream()
	if validity.IsValid() {
		t.Fatalf("incomplete stream unexpectedly valid: %+v", validity)
	}
	if len(events) != 1 || events[0].Type != "message" || events[0].Data["text"] != "partial" {
		t.Fatalf("partial message was not preserved: %#v", events)
	}
}

func TestGrokNormalizerEmitsToolLifecycle(t *testing.T) {
	call := grokNormalizer([]byte(`{"type":"tool_call","toolCallId":"call_1","title":"Read","kind":"read","status":"in_progress","toolName":"read_file","rawInput":{"path":"src/main.rs"},"content":[],"locations":[]}`))
	wantCall := []protocol.Event{{
		Type: "tool_call",
		Data: map[string]any{
			"name":          "read_file",
			"input_summary": `{"path":"src/main.rs"}`,
			"call_id":       "call_1",
		},
	}}
	if !reflect.DeepEqual(call, wantCall) {
		t.Fatalf("tool call mismatch\nwant: %#v\n got: %#v", wantCall, call)
	}

	progress := grokNormalizer([]byte(`{"type":"tool_call_update","toolCallId":"call_1","status":"in_progress","content":[],"locations":[]}`))
	if len(progress) != 0 {
		t.Fatalf("non-terminal tool update leaked: %#v", progress)
	}

	result := grokNormalizer([]byte(`{"type":"tool_call_update","toolCallId":"call_1","status":"completed","content":[],"rawOutput":{"lines":42},"locations":[]}`))
	wantResult := []protocol.Event{{
		Type: "tool_result",
		Data: map[string]any{
			"call_id":     "call_1",
			"status":      "ok",
			"output_tail": `{"lines":42}`,
		},
	}}
	if !reflect.DeepEqual(result, wantResult) {
		t.Fatalf("tool result mismatch\nwant: %#v\n got: %#v", wantResult, result)
	}

	failure := grokNormalizer([]byte(`{"type":"tool_call_update","toolCallId":"call_2","status":"failed","rawOutput":"denied"}`))
	if len(failure) != 1 || failure[0].Type != "tool_result" || failure[0].Data["status"] != "error" {
		t.Fatalf("failed tool result mismatch: %#v", failure)
	}
}

// TestGrokTeeFailsClosedForInvalidStreams verifies that malformed, truncated,
// failed, cancelled, duplicate-terminal, non-final-terminal, and
// sub-millisecond Grok streams never fabricate a positive duration or
// duration_scope. At most one usage record is emitted and token metadata is
// preserved when available, even when the fake clock advanced by whole
// positive milliseconds.
func TestGrokTeeFailsClosedForInvalidStreams(t *testing.T) {
	tests := []struct {
		name       string
		stream     string
		advance    time.Duration
		wantValid  bool
		wantUsage  bool
		wantTokens map[string]any
	}{
		{
			name:       "malformed first record",
			stream:     "not-json\n{\"type\":\"end\",\"stopReason\":\"EndTurn\",\"usage\":{\"input_tokens\":1,\"output_tokens\":2}}",
			advance:    5000 * time.Millisecond,
			wantUsage:  true,
			wantTokens: map[string]any{"input_tokens": float64(1), "output_tokens": float64(2)},
		},
		{
			name:       "truncated final record",
			stream:     "{\"type\":\"text\",\"data\":\"partial\",\"usage\":{\"input_tokens\":3,\"output_tokens\":1}}\n{\"type\":\"end\",\"stopReason\":\"EndTurn\"",
			advance:    5000 * time.Millisecond,
			wantUsage:  true,
			wantTokens: map[string]any{"input_tokens": float64(3), "output_tokens": float64(1)},
		},
		{
			name:       "failed terminal",
			stream:     "{\"type\":\"error\",\"message\":\"boom\",\"usage\":{\"input_tokens\":5,\"output_tokens\":1}}",
			advance:    5000 * time.Millisecond,
			wantUsage:  true,
			wantTokens: map[string]any{"input_tokens": float64(5), "output_tokens": float64(1)},
		},
		{
			name:       "cancelled terminal",
			stream:     "{\"type\":\"end\",\"stopReason\":\"Cancelled\",\"usage\":{\"input_tokens\":5,\"output_tokens\":1}}",
			advance:    5000 * time.Millisecond,
			wantUsage:  true,
			wantTokens: map[string]any{"input_tokens": float64(5), "output_tokens": float64(1)},
		},
		{
			name:       "duplicate terminal",
			stream:     "{\"type\":\"end\",\"stopReason\":\"EndTurn\",\"usage\":{\"input_tokens\":6,\"output_tokens\":2}}\n{\"type\":\"end\",\"stopReason\":\"EndTurn\",\"usage\":{\"input_tokens\":6,\"output_tokens\":2}}",
			advance:    5000 * time.Millisecond,
			wantUsage:  true,
			wantTokens: map[string]any{"input_tokens": float64(6), "output_tokens": float64(2)},
		},
		{
			name:       "trailing after terminal",
			stream:     "{\"type\":\"end\",\"stopReason\":\"EndTurn\",\"usage\":{\"input_tokens\":7,\"output_tokens\":3}}\n{\"type\":\"text\",\"data\":\"late\",\"usage\":{\"input_tokens\":9,\"output_tokens\":1}}",
			advance:    5000 * time.Millisecond,
			wantUsage:  true,
			wantTokens: map[string]any{"input_tokens": float64(9), "output_tokens": float64(1)},
		},
		{
			name:      "failure without usage",
			stream:    "{\"type\":\"error\",\"message\":\"boom\"}",
			advance:   5000 * time.Millisecond,
			wantUsage: false,
		},
		{
			name:       "sub-millisecond valid stream",
			stream:     "{\"type\":\"text\",\"data\":\"ok\"}\n{\"type\":\"end\",\"stopReason\":\"EndTurn\",\"usage\":{\"input_tokens\":8,\"output_tokens\":4}}",
			advance:    500 * time.Microsecond,
			wantValid:  true,
			wantUsage:  true,
			wantTokens: map[string]any{"input_tokens": float64(8), "output_tokens": float64(4)},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			clock := &fakeClock{t: time.Date(2026, 6, 1, 0, 0, 0, 0, time.UTC)}
			var events []protocol.Event
			tee := NewTranscriptTeeWithEventHandler("grok", io.Discard, func(event protocol.Event) {
				events = append(events, event)
			})
			tee.now = clock.Now
			midpoint := len(tt.stream) / 2
			if _, err := tee.Write([]byte(tt.stream[:midpoint])); err != nil {
				t.Fatal(err)
			}
			if _, err := tee.Write([]byte(tt.stream[midpoint:])); err != nil {
				t.Fatal(err)
			}
			clock.Advance(tt.advance)
			validity := tee.FinalizeGrokStream()
			if validity.IsValid() != tt.wantValid {
				t.Fatalf("validity.IsValid() = %v, want %v; validity=%+v", validity.IsValid(), tt.wantValid, validity)
			}
			if got := countTurnUsage(events); got > 1 {
				t.Fatalf("turn_usage count = %d, want at most 1; events=%#v", got, events)
			}
			data := lastTurnUsage(events)
			if tt.wantUsage {
				if data == nil {
					t.Fatalf("no turn_usage preserved; events=%#v", events)
				}
				for key, want := range tt.wantTokens {
					if got, ok := data[key]; !ok || got != want {
						t.Fatalf("usage[%s] = %v (present=%v), want %v; data=%#v", key, got, ok, want, data)
					}
				}
				if _, ok := data["duration_scope"]; ok {
					t.Fatalf("fabricated duration_scope: %#v", data)
				}
				if duration, ok := data["duration_ms"].(int); ok && duration > 0 {
					t.Fatalf("fabricated positive duration_ms: %#v", data)
				}
			} else if data != nil {
				t.Fatalf("unexpected turn_usage without usage candidate: %#v", data)
			}
		})
	}
}

// TestGrokTeePreservesExplicitNativeDuration verifies that a canonical Grok
// usage carrying an explicit positive native duration_ms preserves that value
// (never overwritten by a measured interval) and claims agent_turn scope on a
// structurally valid successful stream.
func TestGrokTeePreservesExplicitNativeDuration(t *testing.T) {
	clock := &fakeClock{t: time.Date(2026, 6, 1, 0, 0, 0, 0, time.UTC)}
	var events []protocol.Event
	tee := NewTranscriptTeeWithEventHandler("grok", io.Discard, func(event protocol.Event) {
		events = append(events, event)
	})
	tee.now = clock.Now

	if _, err := tee.Write([]byte(`{"type":"text","data":"ok"}` + "\n")); err != nil {
		t.Fatal(err)
	}
	clock.Advance(5000 * time.Millisecond)
	if _, err := tee.Write([]byte(`{"type":"end","stopReason":"EndTurn","duration_ms":2500,"usage":{"input_tokens":8,"output_tokens":2}}` + "\n")); err != nil {
		t.Fatal(err)
	}
	if validity := tee.FinalizeGrokStream(); !validity.IsValid() {
		t.Fatalf("validity = %+v, want valid success", validity)
	}
	data := lastTurnUsage(events)
	want := map[string]any{
		"input_tokens":   float64(8),
		"output_tokens":  float64(2),
		"duration_ms":    2500,
		"token_scope":    "agent_turn",
		"duration_scope": "agent_turn",
		"tps_contract":   "agent_turn_v1",
	}
	if !reflect.DeepEqual(data, want) {
		t.Fatalf("canonical usage mismatch\nwant: %#v\n got: %#v", want, data)
	}
}

func TestGrokTeeIncompleteUsageStaysOutsideTPSContract(t *testing.T) {
	clock := &fakeClock{t: time.Date(2026, 6, 1, 0, 0, 0, 0, time.UTC)}
	var events []protocol.Event
	tee := NewTranscriptTeeWithEventHandler("grok", io.Discard, func(event protocol.Event) {
		events = append(events, event)
	})
	tee.now = clock.Now

	if _, err := tee.Write([]byte(`{"type":"text","data":"ok"}` + "\n")); err != nil {
		t.Fatal(err)
	}
	clock.Advance(2500 * time.Millisecond)
	if _, err := tee.Write([]byte(`{"type":"end","stopReason":"EndTurn","usage":{"input_tokens":8}}` + "\n")); err != nil {
		t.Fatal(err)
	}
	if validity := tee.FinalizeGrokStream(); !validity.IsValid() {
		t.Fatalf("validity = %+v, want valid success", validity)
	}
	data := lastTurnUsage(events)
	if data["duration_ms"] != 2500 {
		t.Fatalf("measured duration lost: %#v", data)
	}
	for _, key := range []string{"token_scope", "duration_scope", "tps_contract"} {
		if _, ok := data[key]; ok {
			t.Fatalf("incomplete usage claimed %s: %#v", key, data)
		}
	}
}

// TestGrokTeeCanonicalizationIsFamilyWide verifies the canonical usage path is
// driven by the shared grok client family that every gk-glm/gk-kimi/gk-grok
// profile resolves to, with no profile-name special case.
func TestGrokTeeCanonicalizationIsFamilyWide(t *testing.T) {
	clock := &fakeClock{t: time.Date(2026, 6, 1, 0, 0, 0, 0, time.UTC)}
	var events []protocol.Event
	tee := NewTranscriptTeeWithEventHandler("grok", io.Discard, func(event protocol.Event) {
		events = append(events, event)
	})
	tee.now = clock.Now

	if _, err := tee.Write([]byte(`{"type":"text","data":"ok"}` + "\n")); err != nil {
		t.Fatal(err)
	}
	clock.Advance(1200 * time.Millisecond)
	if _, err := tee.Write([]byte(`{"type":"end","stopReason":"EndTurn","usage":{"input_tokens":4,"output_tokens":1}}` + "\n")); err != nil {
		t.Fatal(err)
	}
	tee.FinalizeGrokStream()
	data := lastTurnUsage(events)
	if data == nil {
		t.Fatal("no canonical usage emitted")
	}
	if data["input_tokens"] != float64(4) || data["output_tokens"] != float64(1) {
		t.Fatalf("usage tokens = %#v", data)
	}
	if data["duration_ms"] != 1200 || data["duration_scope"] != "agent_turn" {
		t.Fatalf("usage duration = %#v", data)
	}
}

func TestGrokNormalizerPreservesTextUsageErrorAndSession(t *testing.T) {
	events := grokNormalizer([]byte(`{"type":"result","result":"final answer","session_id":"grok-session-1","usage":{"input_tokens":12,"output_tokens":4}}`))
	if len(events) != 3 || events[0].Type != "message" || events[1].Type != "turn_usage" || events[2].Type != "run_finished" {
		t.Fatalf("normalized result events = %#v", events)
	}
	if events[0].Data["text"] != "final answer" || events[2].Data["native_session_id"] != "grok-session-1" || events[2].Data["status"] != "done" {
		t.Fatalf("normalized result data = %#v", events)
	}
	failure := grokNormalizer([]byte(`{"type":"error","message":"provider rejected request","session_id":"grok-session-2"}`))
	if len(failure) != 1 || failure[0].Type != "run_finished" || failure[0].Data["status"] != "failed" || failure[0].Data["error"] != "provider rejected request" {
		t.Fatalf("normalized failure = %#v", failure)
	}
}

func TestGrokAdapterParsesNativeSessionAndFinalText(t *testing.T) {
	path := filepath.Join(t.TempDir(), "grok.jsonl")
	data := []byte("{\"type\":\"message\",\"text\":\"draft\"}\n{\"type\":\"result\",\"result\":\"final\",\"session_id\":\"native-grok-id\"}\n")
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	adapter := &GrokAdapter{}
	id, err := adapter.ParseSessionID(path)
	if err != nil || id != "native-grok-id" {
		t.Fatalf("session id = %q err=%v", id, err)
	}
	text, err := adapter.ParseResult(path)
	if err != nil || text != "final" {
		t.Fatalf("result = %q err=%v", text, err)
	}
}

func TestGrokNormalizerAndAdapterParseInstalledStreamingShape(t *testing.T) {
	end := grokNormalizer([]byte(`{"type":"end","stopReason":"EndTurn","sessionId":"native-019f","usage":{"input_tokens":7,"output_tokens":3}}`))
	if len(end) != 2 || end[0].Type != "turn_usage" || end[1].Type != "run_finished" || end[1].Data["native_session_id"] != "native-019f" {
		t.Fatalf("installed end shape normalized events = %#v", end)
	}

	path := filepath.Join(t.TempDir(), "grok-native.jsonl")
	data := []byte("{\"type\":\"thought\",\"data\":\"not final\"}\n{\"type\":\"text\",\"data\":\"hello\"}\n{\"type\":\"text\",\"data\":\" world\"}\n{\"type\":\"end\",\"stopReason\":\"EndTurn\",\"sessionId\":\"native-019f\"}\n")
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	adapter := &GrokAdapter{}
	text, err := adapter.ParseResult(path)
	if err != nil || text != "hello world" {
		t.Fatalf("installed stream result = %q err=%v", text, err)
	}
	id, err := adapter.ParseSessionID(path)
	if err != nil || id != "native-019f" {
		t.Fatalf("installed stream session = %q err=%v", id, err)
	}
}

func TestGrokNormalizerRejectsIncompleteOrUnknownTerminalShapes(t *testing.T) {
	for _, line := range []string{
		`{"type":"end"}`,
		`{"type":"end","stopReason":"Unknown"}`,
		`{"type":"run_finished","status":"running"}`,
	} {
		for _, event := range grokNormalizer([]byte(line)) {
			if event.Type == "run_finished" {
				t.Fatalf("invalid native terminal shape normalized as terminal: %s -> %#v", line, event)
			}
		}
	}
}

func TestGrokNativeStreamValidityCoversTerminalStructureAndPosition(t *testing.T) {
	cases := []struct {
		name       string
		stream     string
		wantValid  bool
		wantStatus string
		wantTrust  GrokAttemptTrust
	}{
		{name: "empty", wantTrust: GrokTrustInvalidOrIncomplete},
		{name: "malformed", stream: "not-json\n", wantTrust: GrokTrustInvalidOrIncomplete},
		{name: "truncated", stream: `{"type":"end","stopReason":"EndTurn"`, wantTrust: GrokTrustInvalidOrIncomplete},
		{name: "incomplete", stream: "{\"type\":\"end\"}\n", wantTrust: GrokTrustInvalidOrIncomplete},
		{name: "duplicate", stream: "{\"type\":\"end\",\"stopReason\":\"EndTurn\"}\n{\"type\":\"end\",\"stopReason\":\"EndTurn\"}\n", wantStatus: "done", wantTrust: GrokTrustInvalidOrIncomplete},
		{name: "non-final after terminal", stream: "{\"type\":\"end\",\"stopReason\":\"EndTurn\"}\n{\"type\":\"thought\",\"data\":\"late\"}\n", wantStatus: "done", wantTrust: GrokTrustInvalidOrIncomplete},
		{name: "failed", stream: "{\"type\":\"error\",\"message\":\"native failure\"}\n", wantStatus: "failed", wantTrust: GrokTrustCompleteNativeFailure},
		{name: "cancelled", stream: "{\"type\":\"end\",\"stopReason\":\"Cancelled\"}\n", wantStatus: "failed", wantTrust: GrokTrustCancelled},
		{name: "valid success", stream: "{\"type\":\"text\",\"data\":\"ok\"}\n{\"type\":\"end\",\"stopReason\":\"EndTurn\"}\n", wantValid: true, wantStatus: "done", wantTrust: GrokTrustCompleteSuccess},
		{name: "valid final record without newline", stream: "{\"type\":\"text\",\"data\":\"ok\"}\n{\"type\":\"end\",\"stopReason\":\"EndTurn\"}", wantValid: true, wantStatus: "done", wantTrust: GrokTrustCompleteSuccess},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var log bytes.Buffer
			var events []protocol.Event
			tee := NewTranscriptTeeWithEventHandler("grok", &log, func(event protocol.Event) {
				events = append(events, event)
			})
			midpoint := len(tc.stream) / 2
			if _, err := tee.Write([]byte(tc.stream[:midpoint])); err != nil {
				t.Fatal(err)
			}
			if _, err := tee.Write([]byte(tc.stream[midpoint:])); err != nil {
				t.Fatal(err)
			}
			validity := tee.FinalizeGrokStream()
			if !validity.Checked || validity.IsValid() != tc.wantValid || validity.Trust != tc.wantTrust {
				t.Fatalf("validity = %+v, want valid=%v; events=%+v", validity, tc.wantValid, events)
			}
			if tc.wantStatus != "" {
				status := ""
				for _, event := range events {
					if event.Type == protocol.EventRunFinished {
						status, _ = event.Data["status"].(string)
					}
				}
				if status != tc.wantStatus {
					t.Fatalf("normalized terminal status = %q, want %q; events=%+v", status, tc.wantStatus, events)
				}
			}
			if log.String() != tc.stream {
				t.Fatalf("transcript bytes changed: got %q want %q", log.String(), tc.stream)
			}
		})
	}
}
