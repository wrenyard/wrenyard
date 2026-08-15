package driver

import (
	"bufio"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/protocol"
)

func TestCodexNormalizerFixture(t *testing.T) {
	got := normalizeFixture(t, "codex_stream.jsonl", codexNormalizer)
	want := []protocol.Event{
		{Type: "tool_call", Data: map[string]any{
			"name":          "powershell",
			"input_summary": `powershell -NoProfile -Command "Get-ChildItem"`,
			"call_id":       "item_1",
		}},
		{Type: "tool_result", Data: map[string]any{
			"call_id":     "item_1",
			"status":      "ok",
			"output_tail": "Directory listing\nfile.txt\n",
		}},
		{Type: "message", Data: map[string]any{
			"role": "assistant",
			"text": "Understood. I have the workspace context and I’m ready to proceed.",
		}},
		{Type: "turn_usage", Data: map[string]any{
			"input_tokens":  13406,
			"output_tokens": 234,
			"duration_ms":   0,
		}},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("normalized Codex events mismatch\nwant: %#v\n got: %#v", want, got)
	}
}

func TestClaudeNormalizerFixture(t *testing.T) {
	got := normalizeFixture(t, "claude_stream.jsonl", claudeNormalizer)
	want := []protocol.Event{
		{Type: "message", Data: map[string]any{
			"role": "assistant",
			"text": "I’ll inspect the workspace.",
		}},
		{Type: "tool_call", Data: map[string]any{
			"name":          "Bash",
			"input_summary": `{"command":"pwd \u0026\u0026 ls"}`,
			"call_id":       "call_1",
		}},
		{Type: "tool_result", Data: map[string]any{
			"call_id":     "call_1",
			"status":      "ok",
			"output_tail": `C:\Users\dluckdu\Documents\GitHub\forge`,
		}},
		{Type: "turn_usage", Data: map[string]any{
			"input_tokens":   10,
			"output_tokens":  20,
			"duration_ms":    1234,
			"token_scope":    "agent_turn",
			"duration_scope": "agent_turn",
			"tps_contract":   "agent_turn_v1",
		}},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("normalized Claude events mismatch\nwant: %#v\n got: %#v", want, got)
	}
}

func TestOpenCodeNormalizerFixture(t *testing.T) {
	got := normalizeFixture(t, "opencode_stream.jsonl", opencodeNormalizer)
	want := []protocol.Event{
		{Type: "message", Data: map[string]any{
			"role": "assistant",
			"text": "OC_GPT_OK",
		}},
		{Type: "turn_usage", Data: map[string]any{
			"input_tokens":            float64(8),
			"output_tokens":           float64(2),
			"reasoning_output_tokens": float64(1),
			"total_tokens":            float64(10),
			"duration_ms":             0,
		}},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("normalized OpenCode events mismatch\nwant: %#v\n got: %#v", want, got)
	}
}

func TestNormalizerTruncationPreservesUTF8(t *testing.T) {
	command := strings.Repeat("界", 171)
	started, err := json.Marshal(map[string]any{
		"type": "item.started",
		"item": map[string]any{"id": "call-utf8", "type": "command_execution", "command": command},
	})
	if err != nil {
		t.Fatal(err)
	}
	callEvents := codexNormalizer(started)
	if len(callEvents) != 1 {
		t.Fatalf("tool call events = %#v", callEvents)
	}
	inputSummary, _ := callEvents[0].Data["input_summary"].(string)
	if want := strings.Repeat("界", 170); inputSummary != want {
		t.Fatalf("input summary bytes/runes = %d/%d, want exact 510-byte UTF-8 prefix", len(inputSummary), utf8.RuneCountInString(inputSummary))
	}
	if !utf8.ValidString(inputSummary) {
		t.Fatalf("input summary is invalid UTF-8: %q", inputSummary)
	}

	output := "AB" + strings.Repeat("界", 683)
	completed, err := json.Marshal(map[string]any{
		"type": "item.completed",
		"item": map[string]any{
			"id": "call-utf8", "type": "command_execution", "exit_code": 1, "aggregated_output": output,
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	resultEvents := codexNormalizer(completed)
	if len(resultEvents) != 1 {
		t.Fatalf("tool result events = %#v", resultEvents)
	}
	outputTail, _ := resultEvents[0].Data["output_tail"].(string)
	if want := strings.Repeat("界", 682); outputTail != want {
		t.Fatalf("output tail bytes/runes = %d/%d, want current 2046-byte UTF-8 tail", len(outputTail), utf8.RuneCountInString(outputTail))
	}
	if !utf8.ValidString(outputTail) {
		t.Fatalf("output tail is invalid UTF-8: %q", outputTail)
	}
}

func TestNormalizersExposeOnlyNormalizedFailureFields(t *testing.T) {
	line := []byte(`{"type":"result","is_error":true,"session_id":"sid-1","result":"429 rate limit","recovery_at":"2026-07-12T07:00:00Z","prompt":"secret prompt"}`)
	events := claudeNormalizer(line)
	if len(events) != 2 || events[1].Type != "run_finished" {
		t.Fatalf("events=%#v want usage plus normalized run_finished", events)
	}
	data := events[1].Data
	if data["status"] != "failed" || data["error"] != "429 rate limit" || data["native_session_id"] != "sid-1" {
		t.Fatalf("normalized failure=%v", data)
	}
	if _, ok := data["prompt"]; ok {
		t.Fatalf("normalized failure leaked prompt: %v", data)
	}
}

func TestCodeBuddy429ResetNormalizesProfileSpecificRecovery(t *testing.T) {
	line := []byte(`{"type":"assistant","message":{"content":[{"type":"output_text","text":""}],"providerData":{"error":{"status":429,"code":6004,"isRetryable":false,"message":"429 您的使用量已超出频率限制，将在 2026-07-12 11:49:02 UTC+8 重置，您也可以切换其他模型继续使用。 (bb7cd53a39014fd2be1b9bf328201c29/8f51d499-a69a-4bdd-b01a-1ef2b4349197)"}}}}`)
	events := normalizeTranscriptLine("codebuddy", line)
	if len(events) != 1 || events[0].Type != protocol.EventRunFinished {
		t.Fatalf("events=%#v want one normalized CodeBuddy failure", events)
	}
	data := events[0].Data
	if data["status"] != "failed" {
		t.Fatalf("status=%v want failed", data["status"])
	}
	if data["failure_class"] != "profile_specific_limit" {
		t.Fatalf("failure_class=%v want profile_specific_limit", data["failure_class"])
	}
	if data["recovery_at"] != "2026-07-12T03:49:02Z" {
		t.Fatalf("recovery_at=%v want 2026-07-12T03:49:02Z", data["recovery_at"])
	}
	errorData, ok := data["error"].(map[string]any)
	if !ok || errorData["message"] != "429 您的使用量已超出频率限制，将在 2026-07-12 11:49:02 UTC+8 重置，您也可以切换其他模型继续使用。 (bb7cd53a39014fd2be1b9bf328201c29/8f51d499-a69a-4bdd-b01a-1ef2b4349197)" {
		t.Fatalf("normalized error=%v want provider message", data["error"])
	}
}

func TestCodeBuddy429ResetEnrichesClaudeCompatibleResult(t *testing.T) {
	line := []byte(`{"type":"result","is_error":true,"session_id":"sid-1","result":"429 您的使用量已超出频率限制，将在 2026-07-12 11:49:02 UTC+8 重置，您也可以切换其他模型继续使用。 (bb7cd53a39014fd2be1b9bf328201c29/8f51d499-a69a-4bdd-b01a-1ef2b4349197)"}`)
	events := normalizeTranscriptLine("codebuddy", line)
	if len(events) != 2 || events[1].Type != protocol.EventRunFinished {
		t.Fatalf("events=%#v want usage plus normalized failure", events)
	}
	data := events[1].Data
	if data["failure_class"] != "profile_specific_limit" || data["recovery_at"] != "2026-07-12T03:49:02Z" {
		t.Fatalf("data=%v want immediate profile circuit recovery", data)
	}
	if data["native_session_id"] != "sid-1" {
		t.Fatalf("native_session_id=%v want sid-1", data["native_session_id"])
	}
}

func TestCodeBuddy429ResetTemplateAndShapeAreStrict(t *testing.T) {
	tests := []struct {
		name        string
		status      any
		code        any
		isRetryable any
		message     string
		wantReset   bool
	}{
		{
			name:        "malformed timestamp",
			status:      429,
			code:        6004,
			isRetryable: false,
			message:     "429 您的使用量已超出频率限制，将在 2026-07-12 11:49:02 UTC+8:0 重置，您也可以切换其他模型继续使用。 (bb7cd53a39014fd2be1b9bf328201c29/8f51d499-a69a-4bdd-b01a-1ef2b4349197)",
		},
		{
			name:        "template lookalike",
			status:      429,
			code:        6004,
			isRetryable: false,
			message:     "prefix 429 您的使用量已超出频率限制，将在 2026-07-12 11:49:02 UTC+8 重置，您也可以切换其他模型继续使用。 (bb7cd53a39014fd2be1b9bf328201c29/8f51d499-a69a-4bdd-b01a-1ef2b4349197)",
		},
		{
			name:        "wrong shape",
			status:      429,
			code:        6005,
			isRetryable: false,
			message:     "429 您的使用量已超出频率限制，将在 2026-07-12 11:49:02 UTC+8 重置，您也可以切换其他模型继续使用。 (bb7cd53a39014fd2be1b9bf328201c29/8f51d499-a69a-4bdd-b01a-1ef2b4349197)",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			errorValue := map[string]any{
				"status": tt.status, "code": tt.code, "isRetryable": tt.isRetryable, "message": tt.message,
			}
			line, err := json.Marshal(map[string]any{
				"type": "assistant",
				"message": map[string]any{
					"content":      []any{map[string]any{"type": "output_text", "text": ""}},
					"providerData": map[string]any{"error": errorValue},
				},
			})
			if err != nil {
				t.Fatal(err)
			}
			events := normalizeTranscriptLine("codebuddy", line)
			if len(events) != 1 || events[0].Type != protocol.EventRunFinished {
				t.Fatalf("events=%#v want one normalized failure", events)
			}
			_, hasReset := events[0].Data["recovery_at"]
			if hasReset != tt.wantReset {
				t.Fatalf("recovery_at present=%v want %v; data=%v", hasReset, tt.wantReset, events[0].Data)
			}
			if _, ok := events[0].Data["failure_class"]; ok {
				t.Fatalf("malformed CodeBuddy error got explicit failure class: %v", events[0].Data)
			}
		})
	}
}

func TestTranscriptTeePreservesNativeBytesAndEventOrder(t *testing.T) {
	input := strings.Join([]string{
		`{"type":"assistant","message":{"content":[{"type":"text","text":"first"}]}}`,
		`not-json`,
		`{"type":"result","duration_ms":7,"usage":{"input_tokens":1,"output_tokens":2}}`,
		"",
	}, "\n")
	var log strings.Builder
	var events []protocol.Event
	tee := NewTranscriptTeeWithEventHandler("claude", &log, func(event protocol.Event) {
		events = append(events, event)
	})

	split := len(input) / 2
	if _, err := tee.Write([]byte(input[:split])); err != nil {
		t.Fatal(err)
	}
	if _, err := tee.Write([]byte(input[split:])); err != nil {
		t.Fatal(err)
	}
	if log.String() != input {
		t.Fatalf("native log changed\nwant: %q\n got: %q", input, log.String())
	}
	want := []protocol.Event{
		{Type: "message", Data: map[string]any{"role": "assistant", "text": "first"}},
		{Type: "turn_usage", Data: map[string]any{"input_tokens": 1, "output_tokens": 2, "duration_ms": 7, "token_scope": "agent_turn", "duration_scope": "agent_turn", "tps_contract": "agent_turn_v1"}},
	}
	if !reflect.DeepEqual(events, want) {
		t.Fatalf("event order mismatch\nwant: %#v\n got: %#v", want, events)
	}
}

// TestTurnUsageDurationScope is a table-driven regression test for the
// normalizer paths that emit turn_usage. The full agent_turn_v1 contract
// (token_scope, duration_scope, tps_contract) is declared exactly for a
// finite positive client-reported agent turn/session wall duration with
// complete usage on the natively vetted Claude and Codex paths (not provider
// generation time). Paths whose duration/usage provenance is not independently
// established (CodeBuddy delegation, opencode, grok normalizer) never carry
// any trust field, and they stay absent for missing, zero, negative, or
// invalid durations while the existing token and envelope fields remain
// unchanged.
func TestTurnUsageDurationScope(t *testing.T) {
	tests := []struct {
		name      string
		normalize func([]byte) []protocol.Event
		line      string
		want      map[string]any
	}{
		{
			name:      "claude trusted positive agent turn duration",
			normalize: claudeNormalizer,
			line:      `{"type":"result","duration_ms":1234,"usage":{"input_tokens":10,"output_tokens":20}}`,
			want:      map[string]any{"input_tokens": 10, "output_tokens": 20, "duration_ms": 1234, "token_scope": "agent_turn", "duration_scope": "agent_turn", "tps_contract": "agent_turn_v1"},
		},
		{
			name:      "claude missing duration stays unscoped",
			normalize: claudeNormalizer,
			line:      `{"type":"result","usage":{"input_tokens":10,"output_tokens":20}}`,
			want:      map[string]any{"input_tokens": 10, "output_tokens": 20, "duration_ms": 0},
		},
		{
			name:      "claude zero duration stays unscoped",
			normalize: claudeNormalizer,
			line:      `{"type":"result","duration_ms":0,"usage":{"input_tokens":10,"output_tokens":20}}`,
			want:      map[string]any{"input_tokens": 10, "output_tokens": 20, "duration_ms": 0},
		},
		{
			name:      "claude negative duration stays unscoped",
			normalize: claudeNormalizer,
			line:      `{"type":"result","duration_ms":-5,"usage":{"input_tokens":10,"output_tokens":20}}`,
			want:      map[string]any{"input_tokens": 10, "output_tokens": 20, "duration_ms": -5},
		},
		{
			name:      "claude invalid duration stays unscoped",
			normalize: claudeNormalizer,
			line:      `{"type":"result","duration_ms":"n/a","usage":{"input_tokens":10,"output_tokens":20}}`,
			want:      map[string]any{"input_tokens": 10, "output_tokens": 20, "duration_ms": 0},
		},
		{
			name:      "codebuddy delegated positive duration stays unscoped",
			normalize: codebuddyNormalizer,
			line:      `{"type":"result","duration_ms":1234,"usage":{"input_tokens":10,"output_tokens":20}}`,
			want:      map[string]any{"input_tokens": 10, "output_tokens": 20, "duration_ms": 1234},
		},
		{
			name:      "codex trusted positive agent turn duration",
			normalize: codexNormalizer,
			line:      `{"type":"turn.completed","duration_ms":2500,"usage":{"input_tokens":100,"output_tokens":50}}`,
			want:      map[string]any{"input_tokens": 100, "output_tokens": 50, "duration_ms": 2500, "token_scope": "agent_turn", "duration_scope": "agent_turn", "tps_contract": "agent_turn_v1"},
		},
		{
			name:      "codex missing duration stays unscoped",
			normalize: codexNormalizer,
			line:      `{"type":"turn.completed","usage":{"input_tokens":100,"output_tokens":50}}`,
			want:      map[string]any{"input_tokens": 100, "output_tokens": 50, "duration_ms": 0},
		},
		{
			name:      "codex zero duration stays unscoped",
			normalize: codexNormalizer,
			line:      `{"type":"turn.completed","duration_ms":0,"usage":{"input_tokens":100,"output_tokens":50}}`,
			want:      map[string]any{"input_tokens": 100, "output_tokens": 50, "duration_ms": 0},
		},
		{
			name:      "codex negative duration stays unscoped",
			normalize: codexNormalizer,
			line:      `{"type":"turn.completed","duration_ms":-5,"usage":{"input_tokens":100,"output_tokens":50}}`,
			want:      map[string]any{"input_tokens": 100, "output_tokens": 50, "duration_ms": -5},
		},
		{
			name:      "codex invalid duration stays unscoped",
			normalize: codexNormalizer,
			line:      `{"type":"turn.completed","duration_ms":"n/a","usage":{"input_tokens":100,"output_tokens":50}}`,
			want:      map[string]any{"input_tokens": 100, "output_tokens": 50, "duration_ms": 0},
		},
		{
			name:      "opencode usage carries duration_ms=0 and stays unscoped",
			normalize: opencodeNormalizer,
			line:      `{"type":"step_finish","part":{"type":"step-finish","tokens":{"total":10,"input":8,"output":2,"reasoning":1}}}`,
			want:      map[string]any{"input_tokens": float64(8), "output_tokens": float64(2), "reasoning_output_tokens": float64(1), "total_tokens": float64(10), "duration_ms": 0},
		},
		{
			name:      "grok usage carries duration_ms=0 and stays unscoped",
			normalize: grokNormalizer,
			line:      `{"type":"result","result":"ok","usage":{"input_tokens":12,"output_tokens":4}}`,
			want:      map[string]any{"input_tokens": float64(12), "output_tokens": float64(4), "duration_ms": 0},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var got map[string]any
			for _, event := range tt.normalize([]byte(tt.line)) {
				if event.Type == "turn_usage" {
					got = event.Data
				}
			}
			if got == nil {
				t.Fatalf("no turn_usage event normalized from %s", tt.line)
			}
			if !reflect.DeepEqual(got, tt.want) {
				t.Fatalf("turn_usage data mismatch\nwant: %#v\n got: %#v", tt.want, got)
			}
		})
	}
}

// fakeClock is a deterministic injected clock for TranscriptTee timing tests.
// Production TranscriptTee instances use time.Now, whose Sub retains the
// monotonic reading so intervals never go backwards across clock adjustments.
type fakeClock struct {
	t time.Time
}

func (c *fakeClock) Now() time.Time { return c.t }

func (c *fakeClock) Advance(d time.Duration) { c.t = c.t.Add(d) }

// codexTurnStep is one line fed to a codex TranscriptTee together with the
// deterministic clock advance to apply before the line is processed.
type codexTurnStep struct {
	line    string
	advance time.Duration
}

// TestCodexTurnTimingFillsMeasuredDuration reproduces the real-shape fixture
// zero-duration bug: the fixture emits turn.started then turn.completed with
// usage but no duration_ms. When the tee processes it with a deterministic
// injected clock, exactly one turn_usage must preserve the tokens and carry
// the measured agent-turn duration plus duration_scope=agent_turn.
func TestCodexTurnTimingFillsMeasuredDuration(t *testing.T) {
	clock := &fakeClock{t: time.Date(2026, 6, 1, 0, 0, 0, 0, time.UTC)}
	var events []protocol.Event
	tee := NewTranscriptTeeWithEventHandler("codex", io.Discard, func(event protocol.Event) {
		events = append(events, event)
	})
	tee.now = clock.Now

	lines := readFixtureLines(t, "codex_stream.jsonl")
	for _, line := range lines[:len(lines)-1] {
		if _, err := tee.Write([]byte(line + "\n")); err != nil {
			t.Fatal(err)
		}
	}
	clock.Advance(2500 * time.Millisecond)
	if _, err := tee.Write([]byte(lines[len(lines)-1] + "\n")); err != nil {
		t.Fatal(err)
	}

	var usage protocol.Event
	count := 0
	for _, event := range events {
		if event.Type == "turn_usage" {
			count++
			usage = event
		}
	}
	if count != 1 {
		t.Fatalf("turn_usage count = %d, want 1; events=%#v", count, events)
	}
	want := map[string]any{
		"input_tokens":   13406,
		"output_tokens":  234,
		"duration_ms":    2500,
		"token_scope":    "agent_turn",
		"duration_scope": "agent_turn",
		"tps_contract":   "agent_turn_v1",
	}
	if !reflect.DeepEqual(usage.Data, want) {
		t.Fatalf("turn_usage data mismatch\nwant: %#v\n got: %#v", want, usage.Data)
	}
}

// TestCodexTurnTimingFailsClosed verifies that no positive agent-turn duration
// or duration_scope is ever fabricated: for unmatched completion, a start
// reset by turn.failed, nonpositive elapsed, and duplicate/out-of-order
// boundaries the token metadata stays available but no trusted duration is
// attached.
func TestCodexTurnTimingFailsClosed(t *testing.T) {
	const (
		start     = `{"type":"turn.started"}`
		failed    = `{"type":"turn.failed"}`
		completed = `{"type":"turn.completed","usage":{"input_tokens":100,"output_tokens":50}}`
	)
	tests := []struct {
		name  string
		steps []codexTurnStep
	}{
		{
			name:  "completion without matching start",
			steps: []codexTurnStep{{advance: 2500 * time.Millisecond, line: completed}},
		},
		{
			name: "start reset by turn.failed",
			steps: []codexTurnStep{
				{line: start},
				{line: failed},
				{advance: 2500 * time.Millisecond, line: completed},
			},
		},
		{
			name: "nonpositive elapsed",
			steps: []codexTurnStep{
				{line: start},
				{line: completed},
			},
		},
		{
			name: "duplicate start invalidates measurement",
			steps: []codexTurnStep{
				{line: start},
				{line: start},
				{advance: 2500 * time.Millisecond, line: completed},
			},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			clock := &fakeClock{t: time.Date(2026, 6, 1, 0, 0, 0, 0, time.UTC)}
			var events []protocol.Event
			tee := NewTranscriptTeeWithEventHandler("codex", io.Discard, func(event protocol.Event) {
				events = append(events, event)
			})
			tee.now = clock.Now
			for _, step := range tt.steps {
				clock.Advance(step.advance)
				if _, err := tee.Write([]byte(step.line + "\n")); err != nil {
					t.Fatal(err)
				}
			}
			var usageData []map[string]any
			for _, event := range events {
				if event.Type == "turn_usage" {
					usageData = append(usageData, event.Data)
				}
			}
			if len(usageData) == 0 {
				t.Fatalf("no turn_usage preserved on %q", tt.name)
			}
			for _, data := range usageData {
				if duration, ok := data["duration_ms"].(int); ok && duration > 0 {
					t.Fatalf("fabricated positive duration on %q: %#v", tt.name, data)
				}
				if _, ok := data["duration_scope"]; ok {
					t.Fatalf("fabricated duration_scope on %q: %#v", tt.name, data)
				}
				if data["input_tokens"] != 100 || data["output_tokens"] != 50 {
					t.Fatalf("token metadata lost on %q: %#v", tt.name, data)
				}
			}
		})
	}
}

// TestCodexTurnTimingSubMillisecondIntervalStaysUnscoped verifies that a valid
// start/completed pair only 500 microseconds apart never attaches a
// duration_ms=0 or duration_scope=agent_turn: the measured interval must be a
// whole positive millisecond before the trusted scope is claimed, otherwise
// the turn_usage keeps its tokens and stays unscoped.
func TestCodexTurnTimingSubMillisecondIntervalStaysUnscoped(t *testing.T) {
	clock := &fakeClock{t: time.Date(2026, 6, 1, 0, 0, 0, 0, time.UTC)}
	var events []protocol.Event
	tee := NewTranscriptTeeWithEventHandler("codex", io.Discard, func(event protocol.Event) {
		events = append(events, event)
	})
	tee.now = clock.Now

	if _, err := tee.Write([]byte(`{"type":"turn.started"}` + "\n")); err != nil {
		t.Fatal(err)
	}
	clock.Advance(500 * time.Microsecond)
	if _, err := tee.Write([]byte(`{"type":"turn.completed","usage":{"input_tokens":100,"output_tokens":50}}` + "\n")); err != nil {
		t.Fatal(err)
	}

	var usage map[string]any
	for _, event := range events {
		if event.Type == "turn_usage" {
			usage = event.Data
		}
	}
	if usage == nil {
		t.Fatal("no turn_usage event")
	}
	if _, ok := usage["duration_scope"]; ok {
		t.Fatalf("sub-millisecond interval fabricated duration_scope: %#v", usage)
	}
	if duration, ok := usage["duration_ms"].(int); ok && duration > 0 {
		t.Fatalf("sub-millisecond interval fabricated duration_ms: %#v", usage)
	}
	if usage["input_tokens"] != 100 || usage["output_tokens"] != 50 {
		t.Fatalf("token metadata lost: %#v", usage)
	}
}

// TestCodexTurnTimingDuplicateStartPoisonsUntilCompleted verifies the
// malformed start/duplicate-start/third-start sequence stays poisoned through
// completion: the third start must not re-enable measurement, so no measured
// duration or duration_scope is fabricated, and the terminal completion resets
// the state so a later clean pair receives its own positive agent_turn
// duration.
func TestCodexTurnTimingDuplicateStartPoisonsUntilCompleted(t *testing.T) {
	clock := &fakeClock{t: time.Date(2026, 6, 1, 0, 0, 0, 0, time.UTC)}
	var events []protocol.Event
	tee := NewTranscriptTeeWithEventHandler("codex", io.Discard, func(event protocol.Event) {
		events = append(events, event)
	})
	tee.now = clock.Now

	write := func(line string) {
		t.Helper()
		if _, err := tee.Write([]byte(line + "\n")); err != nil {
			t.Fatal(err)
		}
	}
	write(`{"type":"turn.started"}`)
	write(`{"type":"turn.started"}`)
	write(`{"type":"turn.started"}`)
	clock.Advance(2500 * time.Millisecond)
	write(`{"type":"turn.completed","usage":{"input_tokens":100,"output_tokens":50}}`)

	var poisoned map[string]any
	for _, event := range events {
		if event.Type == "turn_usage" {
			poisoned = event.Data
		}
	}
	if poisoned == nil {
		t.Fatal("no turn_usage preserved from poisoned sequence")
	}
	if _, ok := poisoned["duration_scope"]; ok {
		t.Fatalf("poisoned sequence fabricated duration_scope: %#v", poisoned)
	}
	if duration, ok := poisoned["duration_ms"].(int); ok && duration > 0 {
		t.Fatalf("poisoned sequence fabricated duration_ms: %#v", poisoned)
	}
	if poisoned["input_tokens"] != 100 || poisoned["output_tokens"] != 50 {
		t.Fatalf("token metadata lost in poisoned sequence: %#v", poisoned)
	}
	events = nil

	// The terminal completion resets to idle; a later clean pair measures its
	// own positive agent_turn duration.
	write(`{"type":"turn.started"}`)
	clock.Advance(2500 * time.Millisecond)
	write(`{"type":"turn.completed","usage":{"input_tokens":100,"output_tokens":50}}`)

	var clean map[string]any
	for _, event := range events {
		if event.Type == "turn_usage" {
			clean = event.Data
		}
	}
	if clean == nil {
		t.Fatal("no turn_usage from later clean turn")
	}
	want := map[string]any{
		"input_tokens":   100,
		"output_tokens":  50,
		"duration_ms":    2500,
		"token_scope":    "agent_turn",
		"duration_scope": "agent_turn",
		"tps_contract":   "agent_turn_v1",
	}
	if !reflect.DeepEqual(clean, want) {
		t.Fatalf("later clean turn mismatch\nwant: %#v\n got: %#v", want, clean)
	}
}

// TestCodexTurnTimingDuplicateStartPoisonsUntilFailed verifies that a poisoned
// sequence ending with turn.failed also resets to idle: a later clean
// start/completed pair receives its own positive measured agent_turn duration.
func TestCodexTurnTimingDuplicateStartPoisonsUntilFailed(t *testing.T) {
	clock := &fakeClock{t: time.Date(2026, 6, 1, 0, 0, 0, 0, time.UTC)}
	var events []protocol.Event
	tee := NewTranscriptTeeWithEventHandler("codex", io.Discard, func(event protocol.Event) {
		events = append(events, event)
	})
	tee.now = clock.Now

	write := func(line string) {
		t.Helper()
		if _, err := tee.Write([]byte(line + "\n")); err != nil {
			t.Fatal(err)
		}
	}
	write(`{"type":"turn.started"}`)
	write(`{"type":"turn.started"}`)
	write(`{"type":"turn.started"}`)
	write(`{"type":"turn.failed"}`)
	write(`{"type":"turn.started"}`)
	clock.Advance(2500 * time.Millisecond)
	write(`{"type":"turn.completed","usage":{"input_tokens":100,"output_tokens":50}}`)

	var usage map[string]any
	for _, event := range events {
		if event.Type == "turn_usage" {
			usage = event.Data
		}
	}
	if usage == nil {
		t.Fatal("no turn_usage from clean turn after failed reset")
	}
	want := map[string]any{
		"input_tokens":   100,
		"output_tokens":  50,
		"duration_ms":    2500,
		"token_scope":    "agent_turn",
		"duration_scope": "agent_turn",
		"tps_contract":   "agent_turn_v1",
	}
	if !reflect.DeepEqual(usage, want) {
		t.Fatalf("turn_usage data mismatch\nwant: %#v\n got: %#v", want, usage)
	}
}

// TestCodexTurnTimingPreservesNativeDuration verifies that an explicit valid
// positive native duration_ms is preserved and scoped rather than replaced by
// the measured interval (which here would be 5000ms).
func TestCodexTurnTimingPreservesNativeDuration(t *testing.T) {
	clock := &fakeClock{t: time.Date(2026, 6, 1, 0, 0, 0, 0, time.UTC)}
	var events []protocol.Event
	tee := NewTranscriptTeeWithEventHandler("codex", io.Discard, func(event protocol.Event) {
		events = append(events, event)
	})
	tee.now = clock.Now

	if _, err := tee.Write([]byte(`{"type":"turn.started"}` + "\n")); err != nil {
		t.Fatal(err)
	}
	clock.Advance(5000 * time.Millisecond)
	if _, err := tee.Write([]byte(`{"type":"turn.completed","duration_ms":2500,"usage":{"input_tokens":100,"output_tokens":50}}` + "\n")); err != nil {
		t.Fatal(err)
	}

	var usage map[string]any
	for _, event := range events {
		if event.Type == "turn_usage" {
			usage = event.Data
		}
	}
	if usage == nil {
		t.Fatal("no turn_usage event")
	}
	want := map[string]any{
		"input_tokens":   100,
		"output_tokens":  50,
		"duration_ms":    2500,
		"token_scope":    "agent_turn",
		"duration_scope": "agent_turn",
		"tps_contract":   "agent_turn_v1",
	}
	if !reflect.DeepEqual(usage, want) {
		t.Fatalf("turn_usage data mismatch\nwant: %#v\n got: %#v", want, usage)
	}
}

// TestCodexTurnTimingResetsAcrossTurns verifies pending timing state is cleared
// on turn.completed so each turn measures only its own native boundary and
// timing never crosses turns or retries.
func TestCodexTurnTimingResetsAcrossTurns(t *testing.T) {
	clock := &fakeClock{t: time.Date(2026, 6, 1, 0, 0, 0, 0, time.UTC)}
	var events []protocol.Event
	tee := NewTranscriptTeeWithEventHandler("codex", io.Discard, func(event protocol.Event) {
		events = append(events, event)
	})
	tee.now = clock.Now

	write := func(line string) {
		t.Helper()
		if _, err := tee.Write([]byte(line + "\n")); err != nil {
			t.Fatal(err)
		}
	}
	write(`{"type":"turn.started"}`)
	clock.Advance(1000 * time.Millisecond)
	write(`{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":1}}`)
	write(`{"type":"turn.started"}`)
	clock.Advance(2500 * time.Millisecond)
	write(`{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":1}}`)

	var durations []int
	for _, event := range events {
		if event.Type == "turn_usage" {
			durations = append(durations, event.Data["duration_ms"].(int))
		}
	}
	want := []int{1000, 2500}
	if !reflect.DeepEqual(durations, want) {
		t.Fatalf("durations = %v, want %v (timing crossed turn boundaries)", durations, want)
	}
}

// collectTurnUsage returns the Data of every turn_usage event in events.
func collectTurnUsage(events []protocol.Event) []map[string]any {
	var out []map[string]any
	for _, event := range events {
		if event.Type == "turn_usage" {
			out = append(out, event.Data)
		}
	}
	return out
}

// normalizeUsageNumbers converts whole JSON float64 numerics to int so usage
// records assembled by different codecs (JSON-decoded maps vs int-valued
// normalizers) compare equal under reflect.DeepEqual.
func normalizeUsageNumbers(data map[string]any) map[string]any {
	out := copyMap(data)
	for key, value := range out {
		if f, ok := value.(float64); ok && f == float64(int(f)) {
			out[key] = int(f)
		}
	}
	return out
}

// trustedAgentTurnContract is the explicit tps_contract=agent_turn_v1
// turn_usage every comparable client must emit for one agent turn: current
// child-invocation input/output tokens, current agent-turn wall duration, and
// both additive scopes declared.
func trustedAgentTurnContract(input, output, duration int) map[string]any {
	return map[string]any{
		"input_tokens":   input,
		"output_tokens":  output,
		"duration_ms":    duration,
		"token_scope":    "agent_turn",
		"duration_scope": "agent_turn",
		"tps_contract":   "agent_turn_v1",
	}
}

// assertExactlyOneTrustedUsage asserts events carries exactly one turn_usage
// whose normalized data equals the trusted agent_turn contract for the given
// current-invocation tokens and wall duration.
func assertExactlyOneTrustedUsage(t *testing.T, events []protocol.Event, input, output, duration int) {
	t.Helper()
	usages := collectTurnUsage(events)
	if len(usages) != 1 {
		t.Fatalf("turn_usage count = %d, want exactly 1; events=%#v", len(usages), events)
	}
	want := trustedAgentTurnContract(input, output, duration)
	if got := normalizeUsageNumbers(usages[0]); !reflect.DeepEqual(got, want) {
		t.Fatalf("turn_usage contract mismatch\nwant: %#v\n got: %#v", want, got)
	}
}

// assertNoTrustFields asserts none of the trusted agent_turn contract fields
// (token_scope, duration_scope, tps_contract) are present on a turn_usage.
func assertNoTrustFields(t *testing.T, data map[string]any) {
	t.Helper()
	for _, key := range []string{"token_scope", "duration_scope", "tps_contract"} {
		if _, ok := data[key]; ok {
			t.Fatalf("fail-closed turn_usage carries %q: %#v", key, data)
		}
	}
}

// TestCodeBuddyInvocationUsageFreshCurrentInvocation verifies that a CodeBuddy
// transcript with one assistant message.usage record and a terminal result
// carrying larger cumulative usage emits exactly one turn_usage that uses the
// current child invocation's input/output tokens, never the cumulative
// terminal result.usage, and declares the full trusted agent_turn contract.
func TestCodeBuddyInvocationUsageFreshCurrentInvocation(t *testing.T) {
	var events []protocol.Event
	tee := NewTranscriptTeeWithEventHandler("codebuddy", io.Discard, func(event protocol.Event) {
		events = append(events, event)
	})
	write := func(line string) {
		t.Helper()
		if _, err := tee.Write([]byte(line + "\n")); err != nil {
			t.Fatal(err)
		}
	}
	write(`{"type":"assistant","message":{"content":[{"type":"text","text":"ready"}],"usage":{"input_tokens":1200,"output_tokens":1456}}}`)
	write(`{"type":"result","is_error":false,"duration_ms":23456,"usage":{"input_tokens":15000,"output_tokens":59043}}`)
	assertExactlyOneTrustedUsage(t, events, 1200, 1456, 23456)
}

// TestCodeBuddyInvocationUsageMultipleAssistantsSummed verifies that several
// assistant usage records within the current invocation are summed for the
// turn_usage while the terminal result's larger cumulative usage is ignored.
func TestCodeBuddyInvocationUsageMultipleAssistantsSummed(t *testing.T) {
	var events []protocol.Event
	tee := NewTranscriptTeeWithEventHandler("codebuddy", io.Discard, func(event protocol.Event) {
		events = append(events, event)
	})
	write := func(line string) {
		t.Helper()
		if _, err := tee.Write([]byte(line + "\n")); err != nil {
			t.Fatal(err)
		}
	}
	write(`{"type":"assistant","message":{"content":[{"type":"text","text":"one"}],"usage":{"input_tokens":600,"output_tokens":700}}}`)
	write(`{"type":"assistant","message":{"content":[{"type":"text","text":"two"}],"usage":{"input_tokens":600,"output_tokens":756}}}`)
	write(`{"type":"result","is_error":false,"duration_ms":23456,"usage":{"input_tokens":15000,"output_tokens":59043}}`)
	assertExactlyOneTrustedUsage(t, events, 1200, 1456, 23456)
}

// TestCodeBuddyInvocationUsageCompactionResetKeepsCurrentOutput verifies that
// after a compaction reset the terminal result.usage output (59043) is never
// routed into the turn_usage: the current assistant output (1456) is the only
// trusted value.
func TestCodeBuddyInvocationUsageCompactionResetKeepsCurrentOutput(t *testing.T) {
	var events []protocol.Event
	tee := NewTranscriptTeeWithEventHandler("codebuddy", io.Discard, func(event protocol.Event) {
		events = append(events, event)
	})
	write := func(line string) {
		t.Helper()
		if _, err := tee.Write([]byte(line + "\n")); err != nil {
			t.Fatal(err)
		}
	}
	write(`{"type":"assistant","message":{"content":[{"type":"text","text":"after compaction"}],"usage":{"input_tokens":1200,"output_tokens":1456}}}`)
	write(`{"type":"result","is_error":false,"duration_ms":30100,"usage":{"input_tokens":42000,"output_tokens":59043}}`)
	assertExactlyOneTrustedUsage(t, events, 1200, 1456, 30100)
}

// TestCodeBuddyInvocationUsageResultOnlyFailsClosed verifies that a transcript
// with only a terminal result and no assistant usage record never claims any
// of the trusted agent_turn contract fields: without current-invocation usage
// the turn_usage stays untrusted.
func TestCodeBuddyInvocationUsageResultOnlyFailsClosed(t *testing.T) {
	var events []protocol.Event
	tee := NewTranscriptTeeWithEventHandler("codebuddy", io.Discard, func(event protocol.Event) {
		events = append(events, event)
	})
	if _, err := tee.Write([]byte(`{"type":"result","is_error":false,"duration_ms":23456,"usage":{"input_tokens":15000,"output_tokens":59043}}` + "\n")); err != nil {
		t.Fatal(err)
	}
	usages := collectTurnUsage(events)
	if len(usages) == 0 {
		t.Fatalf("no turn_usage preserved from result-only transcript; events=%#v", events)
	}
	for _, data := range usages {
		assertNoTrustFields(t, data)
	}
}

func TestCodeBuddyInvocationUsageMalformedAssistantPoisonsContract(t *testing.T) {
	var events []protocol.Event
	tee := NewTranscriptTeeWithEventHandler("codebuddy", io.Discard, func(event protocol.Event) {
		events = append(events, event)
	})
	write := func(line string) {
		t.Helper()
		if _, err := tee.Write([]byte(line + "\n")); err != nil {
			t.Fatal(err)
		}
	}
	write(`{"type":"assistant","message":{"usage":{"input_tokens":100,"output_tokens":50}}}`)
	write(`{"type":"assistant","message":{"usage":{"input_tokens":10}}}`)
	write(`{"type":"result","is_error":false,"duration_ms":2500,"usage":{"input_tokens":900,"output_tokens":700}}`)

	usages := collectTurnUsage(events)
	if len(usages) != 1 {
		t.Fatalf("turn_usage count = %d, want 1; events=%#v", len(usages), events)
	}
	assertNoTrustFields(t, usages[0])
}

// TestTrustedAgentTurnTPSContractParity is a table-driven regression test that
// every comparable client emits exactly one turn_usage carrying the identical
// explicit tps_contract=agent_turn_v1 trust fields (token_scope,
// duration_scope, tps_contract) for the same current-invocation tokens and
// agent-turn wall duration. Protocol extraction may differ; the statistical
// contract may not. OpenCode step_finish stays outside the contract until it
// has a trustworthy full-turn duration.
func TestTrustedAgentTurnTPSContractParity(t *testing.T) {
	const (
		wantInput    = 100
		wantOutput   = 50
		wantDuration = 2500
	)
	want := trustedAgentTurnContract(wantInput, wantOutput, wantDuration)
	tests := []struct {
		name   string
		events func(t *testing.T) []protocol.Event
	}{
		{
			name: "valid claude result",
			events: func(t *testing.T) []protocol.Event {
				return claudeNormalizer([]byte(`{"type":"result","duration_ms":2500,"usage":{"input_tokens":100,"output_tokens":50}}`))
			},
		},
		{
			name: "codex turn.completed",
			events: func(t *testing.T) []protocol.Event {
				return codexNormalizer([]byte(`{"type":"turn.completed","duration_ms":2500,"usage":{"input_tokens":100,"output_tokens":50}}`))
			},
		},
		{
			name: "codebuddy transcript tee",
			events: func(t *testing.T) []protocol.Event {
				var events []protocol.Event
				tee := NewTranscriptTeeWithEventHandler("codebuddy", io.Discard, func(event protocol.Event) {
					events = append(events, event)
				})
				if _, err := tee.Write([]byte(`{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}],"usage":{"input_tokens":100,"output_tokens":50}}}` + "\n")); err != nil {
					t.Fatal(err)
				}
				if _, err := tee.Write([]byte(`{"type":"result","duration_ms":2500,"usage":{"input_tokens":900,"output_tokens":700}}` + "\n")); err != nil {
					t.Fatal(err)
				}
				return events
			},
		},
		{
			name: "valid finalized grok transcript tee",
			events: func(t *testing.T) []protocol.Event {
				clock := &fakeClock{t: time.Date(2026, 6, 1, 0, 0, 0, 0, time.UTC)}
				var events []protocol.Event
				tee := NewTranscriptTeeWithEventHandler("grok", io.Discard, func(event protocol.Event) {
					events = append(events, event)
				})
				tee.now = clock.Now
				if _, err := tee.Write([]byte(`{"type":"text","data":"hi"}` + "\n")); err != nil {
					t.Fatal(err)
				}
				if _, err := tee.Write([]byte(`{"type":"result","status":"done","usage":{"input_tokens":100,"output_tokens":50}}` + "\n")); err != nil {
					t.Fatal(err)
				}
				clock.Advance(wantDuration * time.Millisecond)
				tee.FinalizeGrokStream()
				return events
			},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			usages := collectTurnUsage(tt.events(t))
			if len(usages) != 1 {
				t.Fatalf("turn_usage count = %d, want exactly 1", len(usages))
			}
			if got := normalizeUsageNumbers(usages[0]); !reflect.DeepEqual(got, want) {
				t.Fatalf("contract mismatch\nwant: %#v\n got: %#v", want, got)
			}
		})
	}

	// OpenCode step_finish has no trustworthy full-turn wall duration yet, so
	// its turn_usage must remain outside the tps_contract until one exists.
	opencodeEvents := opencodeNormalizer([]byte(`{"type":"step_finish","part":{"type":"step-finish","tokens":{"total":10,"input":8,"output":2,"reasoning":1}}}`))
	found := false
	for _, event := range opencodeEvents {
		if event.Type != "turn_usage" {
			continue
		}
		found = true
		assertNoTrustFields(t, event.Data)
	}
	if !found {
		t.Fatal("opencode step_finish produced no turn_usage to check")
	}
}

func readFixtureLines(t *testing.T, name string) []string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatal(err)
	}
	var lines []string
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSuffix(line, "\r")
		if strings.TrimSpace(line) == "" {
			continue
		}
		lines = append(lines, line)
	}
	return lines
}

func normalizeFixture(t *testing.T, name string, normalize func([]byte) []protocol.Event) []protocol.Event {
	t.Helper()
	path := filepath.Join("testdata", name)
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()

	var events []protocol.Event
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		events = append(events, normalize(scanner.Bytes())...)
	}
	if err := scanner.Err(); err != nil {
		t.Fatal(err)
	}
	return events
}

// TestAllClientNormalizersPassCentralSchema validates that representative
// normalized events from every first-class client codec pass the centralized
// Forge Agent Stream v1 schema, and that no native event type leaks.
func TestAllClientNormalizersPassCentralSchema(t *testing.T) {
	lines := map[string][]string{
		"claude": {
			`{"type":"assistant","message":{"content":[{"type":"text","text":"hello"}]}}`,
			`{"type":"assistant","message":{"content":[{"type":"tool_use","id":"c1","name":"Bash","input":{"command":"pwd"}}]}}`,
			`{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"c1","content":"done"}]}}`,
			`{"type":"result","duration_ms":100,"usage":{"input_tokens":5,"output_tokens":3}}`,
		},
		"codebuddy": {
			`{"type":"assistant","message":{"content":[{"type":"output_text","text":"cb text"}],"usage":{"input_tokens":10,"output_tokens":5}}}`,
			`{"type":"result","is_error":false,"duration_ms":200,"usage":{"input_tokens":10,"output_tokens":5}}`,
		},
		"codex": {
			`{"type":"item.started","item":{"id":"i1","type":"command_execution","command":"ls -la"}}`,
			`{"type":"item.completed","item":{"id":"i1","type":"command_execution","exit_code":0,"aggregated_output":"file.txt"}}`,
			`{"type":"item.completed","item":{"id":"i0","type":"agent_message","text":"done"}}`,
			`{"type":"turn.completed","duration_ms":50,"usage":{"input_tokens":100,"output_tokens":20}}`,
		},
		"opencode": {
			`{"type":"text","part":{"type":"text","text":"oc text"}}`,
			`{"type":"tool_use","sessionID":"s1","part":{"type":"tool","id":"t1","name":"read","input":{"path":"/x"},"output":"data","state":"completed"}}`,
			`{"type":"tool_use","sessionID":"s2","part":{"type":"tool","id":"t2","tool":"read","state":{"status":"completed","input":{"path":"/y"},"output":"data"}}}`,
			`{"type":"step_finish","part":{"type":"step-finish","tokens":{"total":3,"input":2,"output":1}}}`,
		},
		"grok": {
			`{"type":"text","data":"grok text"}`,
			`{"type":"tool_call","toolCallId":"g1","toolName":"bash","rawInput":{"command":"echo hi"}}`,
			`{"type":"tool_call_update","toolCallId":"g1","status":"completed","rawOutput":"hi"}`,
			`{"type":"result","status":"done","usage":{"input_tokens":7,"output_tokens":4}}`,
		},
		"dsh": {
			`{"type":"assistant/chunk","text":"dsh "}`,
			`{"type":"assistant/message","text":"dsh text"}`,
			`{"type":"tool/call","id":"d1","name":"read","input":{"path":"/x"}}`,
			`{"type":"tool/result","id":"d1","status":"ok","output":"data"}`,
			`{"type":"turn/end","status":"done","text":"final","usage":{"input_tokens":7,"output_tokens":4},"duration_ms":1200}`,
		},
	}
	for family, famLines := range lines {
		t.Run(family, func(t *testing.T) {
			for _, line := range famLines {
				for _, event := range normalizeTranscriptLine(family, []byte(line)) {
					if err := protocol.ValidateEvent(event); err != nil {
						t.Fatalf("family %s event %q failed schema: %v; data=%v", family, event.Type, err, event.Data)
					}
				}
			}
		})
	}
}

// TestDSHFamilyRoutesToDedicatedAdapter verifies the dsh transcript family
// dispatches through its own codec, never through a shared/emulation family,
// and that non-JSON trailing stdout is ignored.
func TestDSHFamilyRoutesToDedicatedAdapter(t *testing.T) {
	events := normalizeTranscriptLine("dsh", []byte(`{"type":"assistant/message","text":"routed"}`))
	if len(events) != 1 || events[0].Type != "message" || events[0].Data["text"] != "routed" {
		t.Fatalf("dsh family must route to the dedicated adapter: %#v", events)
	}
	if events := normalizeTranscriptLine("dsh", []byte(`not-json`)); len(events) != 0 {
		t.Fatalf("non-JSON dsh stdout must be ignored: %#v", events)
	}
}

func TestValidateEventRejectsUnknownAndMalformed(t *testing.T) {
	tests := []struct {
		name  string
		event protocol.Event
	}{
		{name: "unknown type", event: protocol.Event{Type: "native_assistant", Data: map[string]any{"text": "x"}}},
		{name: "missing type", event: protocol.Event{Type: "", Data: map[string]any{}}},
		{name: "message no text", event: protocol.Event{Type: "message", Data: map[string]any{"role": "assistant"}}},
		{name: "tool_call no name", event: protocol.Event{Type: "tool_call", Data: map[string]any{"call_id": "x"}}},
		{name: "tool_call no call_id", event: protocol.Event{Type: "tool_call", Data: map[string]any{"name": "x"}}},
		{name: "tool_result bad status", event: protocol.Event{Type: "tool_result", Data: map[string]any{"call_id": "x", "status": "running"}}},
		{name: "turn_usage no tokens", event: protocol.Event{Type: "turn_usage", Data: map[string]any{"duration_ms": 5}}},
		{name: "turn_usage missing duration_ms", event: protocol.Event{Type: "turn_usage", Data: map[string]any{"input_tokens": 1, "output_tokens": 2}}},
		{name: "turn_usage negative duration", event: protocol.Event{Type: "turn_usage", Data: map[string]any{"input_tokens": 1, "output_tokens": 2, "duration_ms": -3}}},
		{name: "run_finished bad status", event: protocol.Event{Type: "run_finished", Data: map[string]any{"status": "pending"}}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if err := protocol.ValidateEvent(tt.event); err == nil {
				t.Fatalf("expected validation error for %s: %#v", tt.name, tt.event)
			}
		})
	}
}

func TestOpenCodeToolUseNormalizesPairedToolLifecycle(t *testing.T) {
	line := []byte(`{"type":"tool_use","sessionID":"sess-1","part":{"type":"tool","id":"tool-7","name":"read","input":{"path":"/etc/hosts"},"output":"127.0.0.1 localhost","state":"completed"}}`)
	events := opencodeNormalizer(line)
	if len(events) != 2 {
		t.Fatalf("expected paired tool_call/tool_result, got %d events: %#v", len(events), events)
	}
	call := events[0]
	if call.Type != "tool_call" {
		t.Fatalf("first event type=%q want tool_call", call.Type)
	}
	if call.Data["name"] != "read" {
		t.Fatalf("tool_call name=%v want read", call.Data["name"])
	}
	if call.Data["call_id"] != "tool-7" {
		t.Fatalf("tool_call call_id=%v want tool-7", call.Data["call_id"])
	}
	if call.Data["native_session_id"] != "sess-1" {
		t.Fatalf("tool_call native_session_id=%v want sess-1", call.Data["native_session_id"])
	}
	if summary, _ := call.Data["input_summary"].(string); summary == "" {
		t.Fatalf("tool_call input_summary must be non-empty: %v", call.Data)
	}
	result := events[1]
	if result.Type != "tool_result" {
		t.Fatalf("second event type=%q want tool_result", result.Type)
	}
	if result.Data["call_id"] != "tool-7" {
		t.Fatalf("tool_result call_id=%v want tool-7", result.Data["call_id"])
	}
	if result.Data["status"] != "ok" {
		t.Fatalf("tool_result status=%v want ok", result.Data["status"])
	}
	if result.Data["native_session_id"] != "sess-1" {
		t.Fatalf("tool_result native_session_id=%v want sess-1", result.Data["native_session_id"])
	}
}

func TestOpenCodeToolUseErrorStatusMapped(t *testing.T) {
	line := []byte(`{"type":"tool_use","part":{"type":"tool","id":"t-err","name":"bash","input":{"command":"false"},"output":"exit 1","state":"error"}}`)
	events := opencodeNormalizer(line)
	if len(events) != 2 || events[1].Data["status"] != "error" {
		t.Fatalf("expected paired events with error status: %#v", events)
	}
}

func TestOpenCodeToolUseNonTerminalEmitsOnlyCall(t *testing.T) {
	line := []byte(`{"type":"tool_use","part":{"type":"tool","id":"t-pending","name":"bash","input":{"command":"ls"},"state":"running"}}`)
	events := opencodeNormalizer(line)
	if len(events) != 1 || events[0].Type != "tool_call" {
		t.Fatalf("expected single tool_call for non-terminal part: %#v", events)
	}
}

func TestOpenCodeToolUseDerivedStableCallID(t *testing.T) {
	// No explicit id: the derived call_id must be stable (same input -> same id)
	// and shared across the paired events.
	line := []byte(`{"type":"tool_use","part":{"type":"tool","name":"read","input":{"path":"/x"},"output":"y","state":"completed"}}`)
	first := opencodeNormalizer(line)
	second := opencodeNormalizer(line)
	if len(first) != 2 || len(second) != 2 {
		t.Fatalf("expected paired events: %#v / %#v", first, second)
	}
	id1, _ := first[0].Data["call_id"].(string)
	id2, _ := second[0].Data["call_id"].(string)
	if id1 == "" || id1 != id2 {
		t.Fatalf("derived call_id must be stable: %q vs %q", id1, id2)
	}
	if first[1].Data["call_id"] != id1 {
		t.Fatalf("paired tool_result must share call_id: %v", first[1].Data["call_id"])
	}
}

// TestOpenCodeToolUseNestedStateNormalizesTerminalLifecycle covers the actual
// OpenCode 1.17 run --format json shape: part.type=tool, part.id, part.tool,
// and a nested part.state carrying status/input/output. One terminal tool_use
// part normalizes to one valid tool_call and one valid tool_result carrying
// correct input, output, status, id, and session metadata.
func TestOpenCodeToolUseNestedStateNormalizesTerminalLifecycle(t *testing.T) {
	line := []byte(`{"type":"tool_use","sessionID":"oc-sess-1","part":{"type":"tool","id":"call_abc","tool":"read","state":{"status":"completed","input":{"path":"/etc/hosts"},"output":"127.0.0.1 localhost"}}}`)
	events := opencodeNormalizer(line)
	if len(events) != 2 || events[0].Type != "tool_call" || events[1].Type != "tool_result" {
		t.Fatalf("expected paired tool_call/tool_result, got %d events: %#v", len(events), events)
	}
	call := events[0]
	if call.Data["name"] != "read" {
		t.Fatalf("tool_call name=%v want read", call.Data["name"])
	}
	if call.Data["call_id"] != "call_abc" {
		t.Fatalf("tool_call call_id=%v want call_abc", call.Data["call_id"])
	}
	if call.Data["native_session_id"] != "oc-sess-1" {
		t.Fatalf("tool_call native_session_id=%v want oc-sess-1", call.Data["native_session_id"])
	}
	if summary, _ := call.Data["input_summary"].(string); summary != `{"path":"/etc/hosts"}` {
		t.Fatalf("tool_call input_summary=%q want {\"path\":\"/etc/hosts\"}", summary)
	}
	result := events[1]
	if result.Data["call_id"] != "call_abc" {
		t.Fatalf("tool_result call_id=%v want call_abc", result.Data["call_id"])
	}
	if result.Data["status"] != "ok" {
		t.Fatalf("tool_result status=%v want ok", result.Data["status"])
	}
	if result.Data["output_tail"] != "127.0.0.1 localhost" {
		t.Fatalf("tool_result output_tail=%v want 127.0.0.1 localhost", result.Data["output_tail"])
	}
	if result.Data["native_session_id"] != "oc-sess-1" {
		t.Fatalf("tool_result native_session_id=%v want oc-sess-1", result.Data["native_session_id"])
	}
	for _, event := range events {
		if err := protocol.ValidateEvent(event); err != nil {
			t.Fatalf("nested-state event %q failed schema: %v", event.Type, err)
		}
	}
}

func TestOpenCodeToolUseNestedErrorStateMapped(t *testing.T) {
	line := []byte(`{"type":"tool_use","part":{"type":"tool","id":"call_err","tool":"bash","state":{"status":"error","input":{"command":"false"},"error":"exit 1"}}}`)
	events := opencodeNormalizer(line)
	if len(events) != 2 || events[1].Data["status"] != "error" {
		t.Fatalf("expected paired events with error status: %#v", events)
	}
	if events[1].Data["output_tail"] != "exit 1" {
		t.Fatalf("error output_tail=%v want exit 1", events[1].Data["output_tail"])
	}
	if summary, _ := events[0].Data["input_summary"].(string); summary != `{"command":"false"}` {
		t.Fatalf("nested input not read from state.input: %q", summary)
	}
}

func TestOpenCodeToolUseNestedNonTerminalEmitsOnlyCall(t *testing.T) {
	line := []byte(`{"type":"tool_use","part":{"type":"tool","id":"call_run","tool":"bash","state":{"status":"running","input":{"command":"ls"}}}}`)
	events := opencodeNormalizer(line)
	if len(events) != 1 || events[0].Type != "tool_call" {
		t.Fatalf("expected single tool_call for non-terminal nested state: %#v", events)
	}
}

func TestOpenCodeStepFinishAggregatedOnceWithMeasuredDuration(t *testing.T) {
	clock := &fakeClock{t: time.Date(2026, 6, 1, 0, 0, 0, 0, time.UTC)}
	var events []protocol.Event
	tee := NewTranscriptTeeWithEventHandler("opencode", io.Discard, func(event protocol.Event) {
		events = append(events, event)
	})
	tee.now = clock.Now
	write := func(line string) {
		t.Helper()
		if _, err := tee.Write([]byte(line + "\n")); err != nil {
			t.Fatal(err)
		}
	}
	write(`{"type":"step_start","part":{"type":"step-start"}}`)
	write(`{"type":"text","part":{"type":"text","text":"working"}}`)
	write(`{"type":"step_finish","part":{"type":"step-finish","tokens":{"total":10,"input":8,"output":2}}}`)
	write(`{"type":"step_finish","part":{"type":"step-finish","tokens":{"total":5,"input":4,"output":1}}}`)
	clock.Advance(2500 * time.Millisecond)
	tee.FinalizeOpenCodeStream()

	var usages []map[string]any
	for _, event := range events {
		if event.Type == "turn_usage" {
			usages = append(usages, event.Data)
		}
	}
	if len(usages) != 1 {
		t.Fatalf("turn_usage count = %d, want exactly 1; events=%#v", len(usages), events)
	}
	want := map[string]any{
		"input_tokens":   12,
		"output_tokens":  3,
		"duration_ms":    2500,
		"total_tokens":   15,
		"token_scope":    "agent_turn",
		"duration_scope": "agent_turn",
		"tps_contract":   "agent_turn_v1",
	}
	if got := normalizeUsageNumbers(usages[0]); !reflect.DeepEqual(got, want) {
		t.Fatalf("aggregated turn_usage mismatch\nwant: %#v\n got: %#v", want, got)
	}
}

func TestOpenCodeStepFinishIncompleteTokensFailClosed(t *testing.T) {
	clock := &fakeClock{t: time.Date(2026, 6, 1, 0, 0, 0, 0, time.UTC)}
	var events []protocol.Event
	tee := NewTranscriptTeeWithEventHandler("opencode", io.Discard, func(event protocol.Event) {
		events = append(events, event)
	})
	tee.now = clock.Now
	write := func(line string) {
		t.Helper()
		if _, err := tee.Write([]byte(line + "\n")); err != nil {
			t.Fatal(err)
		}
	}
	// A step_finish missing output_tokens makes the invocation invalid.
	write(`{"type":"step_finish","part":{"type":"step-finish","tokens":{"total":10,"input":8}}}`)
	clock.Advance(2500 * time.Millisecond)
	tee.FinalizeOpenCodeStream()

	usages := collectTurnUsage(events)
	if len(usages) != 1 {
		t.Fatalf("turn_usage count = %d, want 1", len(usages))
	}
	assertNoTrustFields(t, usages[0])
}

func TestOpenCodeStepFinishSubMillisecondStaysUnscoped(t *testing.T) {
	clock := &fakeClock{t: time.Date(2026, 6, 1, 0, 0, 0, 0, time.UTC)}
	var events []protocol.Event
	tee := NewTranscriptTeeWithEventHandler("opencode", io.Discard, func(event protocol.Event) {
		events = append(events, event)
	})
	tee.now = clock.Now
	if _, err := tee.Write([]byte(`{"type":"step_finish","part":{"type":"step-finish","tokens":{"total":10,"input":8,"output":2}}}` + "\n")); err != nil {
		t.Fatal(err)
	}
	clock.Advance(500 * time.Microsecond)
	tee.FinalizeOpenCodeStream()
	usages := collectTurnUsage(events)
	if len(usages) != 1 {
		t.Fatalf("turn_usage count = %d, want 1", len(usages))
	}
	assertNoTrustFields(t, usages[0])
}

// TestOpenCodeFinalRecordWithoutNewlineIsConsumed verifies that an OpenCode
// transcript whose final step_finish record lacks a trailing newline still has
// that record consumed at finalization, yielding exactly one schema-valid
// aggregated turn_usage.
func TestOpenCodeFinalRecordWithoutNewlineIsConsumed(t *testing.T) {
	clock := &fakeClock{t: time.Date(2026, 6, 1, 0, 0, 0, 0, time.UTC)}
	var events []protocol.Event
	tee := NewTranscriptTeeWithEventHandler("opencode", io.Discard, func(event protocol.Event) {
		events = append(events, event)
	})
	tee.now = clock.Now
	if _, err := tee.Write([]byte(`{"type":"step_finish","part":{"type":"step-finish","tokens":{"total":5,"input":4,"output":1}}}` + "\n")); err != nil {
		t.Fatal(err)
	}
	clock.Advance(2000 * time.Millisecond)
	// Final step_finish record intentionally lacks a trailing newline.
	if _, err := tee.Write([]byte(`{"type":"step_finish","part":{"type":"step-finish","tokens":{"total":5,"input":4,"output":1}}}`)); err != nil {
		t.Fatal(err)
	}
	tee.FinalizeOpenCodeStream()

	usages := collectTurnUsage(events)
	if len(usages) != 1 {
		t.Fatalf("turn_usage count = %d, want exactly 1; events=%#v", len(usages), events)
	}
	got := normalizeUsageNumbers(usages[0])
	if got["input_tokens"] != 8 || got["output_tokens"] != 2 {
		t.Fatalf("final record not consumed/aggregated: %#v", got)
	}
	if err := protocol.ValidateEvent(protocol.Event{Type: "turn_usage", Data: usages[0]}); err != nil {
		t.Fatalf("aggregated turn_usage not schema-valid: %v; data=%#v", err, usages[0])
	}
}

func TestCodexMCPToolCallNormalization(t *testing.T) {
	started := []byte(`{"type":"item.started","item":{"id":"mcp_1","type":"mcp_tool_call","server_label":"db","tool_name":"query","arguments":"{\"sql\":\"SELECT 1\"}"}}`)
	callEvents := codexNormalizer(started)
	if len(callEvents) != 1 || callEvents[0].Type != "tool_call" {
		t.Fatalf("expected one tool_call: %#v", callEvents)
	}
	if callEvents[0].Data["name"] != "query" {
		t.Fatalf("name=%v want query", callEvents[0].Data["name"])
	}
	if callEvents[0].Data["call_id"] != "mcp_1" {
		t.Fatalf("call_id=%v want mcp_1", callEvents[0].Data["call_id"])
	}

	completed := []byte(`{"type":"item.completed","item":{"id":"mcp_1","type":"mcp_tool_call","status":"completed","output":"row count: 1"}}`)
	resultEvents := codexNormalizer(completed)
	if len(resultEvents) != 1 || resultEvents[0].Type != "tool_result" {
		t.Fatalf("expected one tool_result: %#v", resultEvents)
	}
	if resultEvents[0].Data["status"] != "ok" {
		t.Fatalf("status=%v want ok", resultEvents[0].Data["status"])
	}
	if resultEvents[0].Data["call_id"] != "mcp_1" {
		t.Fatalf("call_id=%v want mcp_1", resultEvents[0].Data["call_id"])
	}
}

// TestCodexMCPToolCallUpstreamFields covers the actual Codex 0.144 mcp_tool_call
// shape: id, server, tool, arguments, result, error, status. A success
// completion serializes result safely; an error completion maps status=error
// with a bounded output_tail.
func TestCodexMCPToolCallUpstreamFields(t *testing.T) {
	started := []byte(`{"type":"item.started","item":{"id":"mcp_2","type":"mcp_tool_call","server":"db","tool":"query","arguments":{"sql":"SELECT 1"}}}`)
	callEvents := codexNormalizer(started)
	if len(callEvents) != 1 || callEvents[0].Type != "tool_call" {
		t.Fatalf("expected one tool_call: %#v", callEvents)
	}
	if callEvents[0].Data["name"] != "query" {
		t.Fatalf("name=%v want query (from tool field)", callEvents[0].Data["name"])
	}
	if callEvents[0].Data["call_id"] != "mcp_2" {
		t.Fatalf("call_id=%v want mcp_2", callEvents[0].Data["call_id"])
	}
	if summary, _ := callEvents[0].Data["input_summary"].(string); summary != `{"sql":"SELECT 1"}` {
		t.Fatalf("input_summary=%q want serialized arguments", summary)
	}

	success := []byte(`{"type":"item.completed","item":{"id":"mcp_2","type":"mcp_tool_call","status":"completed","result":{"rows":1}}}`)
	successEvents := codexNormalizer(success)
	if len(successEvents) != 1 || successEvents[0].Type != "tool_result" {
		t.Fatalf("expected one tool_result: %#v", successEvents)
	}
	if successEvents[0].Data["status"] != "ok" {
		t.Fatalf("status=%v want ok", successEvents[0].Data["status"])
	}
	if outputTail, _ := successEvents[0].Data["output_tail"].(string); !strings.Contains(outputTail, "rows") {
		t.Fatalf("result must serialize safely into output_tail: %q", outputTail)
	}

	errCompleted := []byte(`{"type":"item.completed","item":{"id":"mcp_3","type":"mcp_tool_call","status":"error","error":"connection refused"}}`)
	errEvents := codexNormalizer(errCompleted)
	if len(errEvents) != 1 || errEvents[0].Type != "tool_result" {
		t.Fatalf("expected one tool_result: %#v", errEvents)
	}
	if errEvents[0].Data["status"] != "error" {
		t.Fatalf("error status=%v want error", errEvents[0].Data["status"])
	}
	if errEvents[0].Data["output_tail"] != "connection refused" {
		t.Fatalf("error output_tail=%v want connection refused", errEvents[0].Data["output_tail"])
	}
}

func TestCodexWebSearchNormalization(t *testing.T) {
	started := []byte(`{"type":"item.started","item":{"id":"ws_1","type":"web_search","query":"golang testing"}}`)
	callEvents := codexNormalizer(started)
	if len(callEvents) != 1 || callEvents[0].Type != "tool_call" {
		t.Fatalf("expected one tool_call: %#v", callEvents)
	}
	if callEvents[0].Data["name"] != "web_search" {
		t.Fatalf("name=%v want web_search", callEvents[0].Data["name"])
	}

	completed := []byte(`{"type":"item.completed","item":{"id":"ws_1","type":"web_search","status":"completed","results":[{"title":"Go Testing"},{"title":"Go Blog"}]}}`)
	resultEvents := codexNormalizer(completed)
	if len(resultEvents) != 1 || resultEvents[0].Type != "tool_result" {
		t.Fatalf("expected one tool_result: %#v", resultEvents)
	}
	if resultEvents[0].Data["status"] != "ok" {
		t.Fatalf("status=%v want ok", resultEvents[0].Data["status"])
	}
	outputTail, _ := resultEvents[0].Data["output_tail"].(string)
	if !strings.Contains(outputTail, "Go Testing") || !strings.Contains(outputTail, "Go Blog") {
		t.Fatalf("output_tail must contain result titles: %q", outputTail)
	}
}

func TestCodexFileChangeNormalization(t *testing.T) {
	// Native Codex emits file_change only as an atomic item.completed record
	// carrying a changes array; it normalizes to exactly one tool_call followed
	// by one tool_result.
	completed := []byte(`{"type":"item.completed","item":{"id":"fc_1","type":"file_change","status":"completed","changes":[{"path":"main.go","change":"+package main"}]}}`)
	events := codexNormalizer(completed)
	if len(events) != 2 || events[0].Type != "tool_call" || events[1].Type != "tool_result" {
		t.Fatalf("expected paired tool_call/tool_result, got %d events: %#v", len(events), events)
	}
	if events[0].Data["name"] != "file_change" {
		t.Fatalf("name=%v want file_change", events[0].Data["name"])
	}
	if events[0].Data["call_id"] != "fc_1" {
		t.Fatalf("call_id=%v want fc_1", events[0].Data["call_id"])
	}
	if events[1].Data["status"] != "ok" {
		t.Fatalf("status=%v want ok", events[1].Data["status"])
	}
}

func TestCodexFileChangeStartedNeverEmits(t *testing.T) {
	// A hypothetical file_change item.started must never emit so the atomic
	// completed record is counted exactly once.
	started := []byte(`{"type":"item.started","item":{"id":"fc_1","type":"file_change","changes":[{"path":"main.go"}]}}`)
	if events := codexNormalizer(started); len(events) != 0 {
		t.Fatalf("file_change started must not emit: %#v", events)
	}
}

func TestCodexCommandExecutionNotRegressed(t *testing.T) {
	started := []byte(`{"type":"item.started","item":{"id":"cmd_1","type":"command_execution","command":"echo hi"}}`)
	callEvents := codexNormalizer(started)
	if len(callEvents) != 1 || callEvents[0].Data["name"] != "echo" {
		t.Fatalf("command_execution tool_call name=%v want echo: %#v", callEvents[0].Data["name"], callEvents)
	}
	completed := []byte(`{"type":"item.completed","item":{"id":"cmd_1","type":"command_execution","exit_code":1,"aggregated_output":"err"}}`)
	resultEvents := codexNormalizer(completed)
	if len(resultEvents) != 1 || resultEvents[0].Data["status"] != "error" {
		t.Fatalf("command_execution nonzero exit must be error: %#v", resultEvents)
	}
}

func TestClaudeOutputTextBlockNormalized(t *testing.T) {
	line := []byte(`{"type":"assistant","message":{"content":[{"type":"output_text","text":"compatible text"}]}}`)
	events := claudeNormalizer(line)
	if len(events) != 1 || events[0].Type != "message" {
		t.Fatalf("expected one message for output_text block: %#v", events)
	}
	if events[0].Data["text"] != "compatible text" {
		t.Fatalf("text=%v want compatible text", events[0].Data["text"])
	}
}
