package driver

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/protocol"
)

func TestDSHNormalizerMessageText(t *testing.T) {
	events := dshNormalizer([]byte(`{"event":"assistant/message","text":"hello dsh"}`))
	want := []protocol.Event{{Type: "message", Data: map[string]any{"role": "assistant", "text": "hello dsh"}}}
	if !reflect.DeepEqual(events, want) {
		t.Fatalf("normalized events mismatch\nwant: %#v\n got: %#v", want, events)
	}
}

func TestDSHNormalizerTypeFallback(t *testing.T) {
	events := dshNormalizer([]byte(`{"type":"assistant/message","text":"legacy"}`))
	want := []protocol.Event{{Type: "message", Data: map[string]any{"role": "assistant", "text": "legacy"}}}
	if !reflect.DeepEqual(events, want) {
		t.Fatalf("type fallback mismatch\nwant: %#v\n got: %#v", want, events)
	}
}

func TestDSHNormalizerReasoningNeverSurfaces(t *testing.T) {
	if events := dshNormalizer([]byte(`{"event":"assistant/reasoning","text":"thinking..."}`)); len(events) != 0 {
		t.Fatalf("assistant/reasoning deltas must not surface as messages: %#v", events)
	}
	if events := dshNormalizer([]byte(`{"event":"assistant/chunk","kind":"reasoning","text":"hidden thinking"}`)); len(events) != 0 {
		t.Fatalf("assistant/chunk kind=reasoning must not surface as messages: %#v", events)
	}
}

func TestDSHNormalizerToolLifecycle(t *testing.T) {
	call := dshNormalizer([]byte(`{"event":"tool/call","callId":"c1","name":"Bash","input":{"command":"pwd"}}`))
	if len(call) != 1 || call[0].Type != "tool_call" {
		t.Fatalf("expected one tool_call: %#v", call)
	}
	if call[0].Data["name"] != "Bash" || call[0].Data["call_id"] != "c1" {
		t.Fatalf("tool_call data=%v want name Bash call_id c1", call[0].Data)
	}

	result := dshNormalizer([]byte(`{"event":"tool/result","callId":"c1","status":"ok","output":"/tmp"}`))
	if len(result) != 1 || result[0].Type != "tool_result" {
		t.Fatalf("expected one tool_result: %#v", result)
	}
	if result[0].Data["status"] != "ok" || result[0].Data["call_id"] != "c1" {
		t.Fatalf("tool_result data=%v want ok c1", result[0].Data)
	}
}

func TestDSHNormalizerToolCallIDFallback(t *testing.T) {
	call := dshNormalizer([]byte(`{"event":"tool/call","id":"c1","name":"Bash","input":{}}`))
	if len(call) != 1 || call[0].Data["call_id"] != "c1" {
		t.Fatalf("id fallback tool_call data=%v want call_id c1", call[0].Data)
	}
	result := dshNormalizer([]byte(`{"type":"tool/result","call_id":"c2","status":"ok","output":"x"}`))
	if len(result) != 1 || result[0].Data["call_id"] != "c2" {
		t.Fatalf("call_id fallback tool_result data=%v want call_id c2", result[0].Data)
	}
}

func TestDSHTurnEndCompletesWithTrustedUsage(t *testing.T) {
	events := dshNormalizer([]byte(`{"event":"turn/end","status":"done","text":"final answer","usage":{"input_tokens":100,"output_tokens":50},"duration":2500}`))
	if len(events) != 3 {
		t.Fatalf("events=%#v want message, turn_usage, run_finished", events)
	}
	if events[0].Type != "message" || events[0].Data["text"] != "final answer" {
		t.Fatalf("bridge final text must be the final message: %#v", events[0])
	}
	var usage map[string]any
	for _, event := range events {
		if event.Type == "turn_usage" {
			usage = event.Data
		}
	}
	if usage == nil {
		t.Fatal("no turn_usage emitted")
	}
	want := trustedAgentTurnContract(100, 50, 2500)
	if got := normalizeUsageNumbers(usage); !reflect.DeepEqual(got, want) {
		t.Fatalf("turn_usage contract mismatch\nwant: %#v\n got: %#v", want, got)
	}
	last := events[len(events)-1]
	if last.Type != protocol.EventRunFinished || last.Data["status"] != "done" {
		t.Fatalf("run_finished must be the terminal done event: %#v", last)
	}
}

func TestDSHTurnEndDurationFallback(t *testing.T) {
	events := dshNormalizer([]byte(`{"type":"turn/end","status":"done","text":"ok","usage":{"input_tokens":100,"output_tokens":50},"duration_ms":2500}`))
	usages := collectTurnUsage(events)
	if len(usages) != 1 {
		t.Fatalf("turn_usage count = %d, want 1; events=%#v", len(usages), events)
	}
	want := trustedAgentTurnContract(100, 50, 2500)
	if got := normalizeUsageNumbers(usages[0]); !reflect.DeepEqual(got, want) {
		t.Fatalf("duration_ms fallback contract mismatch\nwant: %#v\n got: %#v", want, got)
	}
}

func TestDSHTurnEndIncompleteUsageStaysUnscoped(t *testing.T) {
	events := dshNormalizer([]byte(`{"event":"turn/end","status":"done","text":"ok","usage":{"input_tokens":100},"duration":2500}`))
	usages := collectTurnUsage(events)
	if len(usages) != 1 {
		t.Fatalf("turn_usage count = %d, want 1; events=%#v", len(usages), events)
	}
	assertNoTrustFields(t, usages[0])
	if duration, ok := usages[0]["duration_ms"].(int); !ok || duration != 2500 {
		t.Fatalf("raw duration metadata must be preserved: %#v", usages[0])
	}
}

func TestDSHTurnEndTerminalError(t *testing.T) {
	events := dshNormalizer([]byte(`{"event":"turn/end","status":"error","error":"rate limited","session_id":"s1"}`))
	last := events[len(events)-1]
	if last.Type != protocol.EventRunFinished || last.Data["status"] != "failed" {
		t.Fatalf("terminal error must normalize to failed run_finished: %#v", last)
	}
	if last.Data["error"] != "rate limited" {
		t.Fatalf("error=%v want rate limited", last.Data["error"])
	}
	if last.Data["native_session_id"] != "s1" {
		t.Fatalf("native_session_id=%v want s1", last.Data["native_session_id"])
	}
	for _, event := range events {
		if err := protocol.ValidateEvent(event); err != nil {
			t.Fatalf("event %q failed schema: %v", event.Type, err)
		}
	}
}

func TestDSHNormalizerIgnoresNonJSONStdout(t *testing.T) {
	if events := dshNormalizer([]byte(`plain DSH stdout is not JSON`)); len(events) != 0 {
		t.Fatalf("non-JSON trailing stdout must be ignored: %#v", events)
	}
	if events := dshNormalizer([]byte(``)); len(events) != 0 {
		t.Fatalf("blank lines must be ignored: %#v", events)
	}
}

func TestDSHAdapterParseResultPrefersBridgeFinalText(t *testing.T) {
	path := filepath.Join(t.TempDir(), "stream.jsonl")
	data := strings.Join([]string{
		`{"event":"assistant/chunk","text":"accumulated "}`,
		`{"event":"assistant/chunk","text":"deltas"}`,
		`{"event":"turn/end","status":"done","text":"bridge final text"}`,
		`trailing plain stdout is ignored`,
	}, "\n")
	if err := os.WriteFile(path, []byte(data), 0o600); err != nil {
		t.Fatal(err)
	}
	adapter := &DSHAdapter{}
	result, err := adapter.ParseResult(path)
	if err != nil {
		t.Fatal(err)
	}
	if result != "bridge final text" {
		t.Fatalf("ParseResult=%q want bridge final text", result)
	}
}

func TestDSHAdapterParseResultFallsBackToAccumulatedText(t *testing.T) {
	path := filepath.Join(t.TempDir(), "stream.jsonl")
	data := strings.Join([]string{
		`{"event":"assistant/chunk","text":"no "}`,
		`{"event":"assistant/chunk","text":"bridge text"}`,
		`{"event":"turn/end","status":"done"}`,
	}, "\n")
	if err := os.WriteFile(path, []byte(data), 0o600); err != nil {
		t.Fatal(err)
	}
	adapter := &DSHAdapter{}
	result, err := adapter.ParseResult(path)
	if err != nil {
		t.Fatal(err)
	}
	if result != "no bridge text" {
		t.Fatalf("ParseResult=%q want accumulated fallback", result)
	}
}

func TestDSHAdapterParseResultNoDuplicateFinalOutput(t *testing.T) {
	path := filepath.Join(t.TempDir(), "stream.jsonl")
	data := strings.Join([]string{
		`{"event":"assistant/chunk","text":"the answer is "}`,
		`{"event":"assistant/chunk","text":"42"}`,
		`{"event":"assistant/message","text":"the answer is 42","fallback":true}`,
		`{"event":"turn/end","status":"done"}`,
	}, "\n")
	if err := os.WriteFile(path, []byte(data), 0o600); err != nil {
		t.Fatal(err)
	}
	adapter := &DSHAdapter{}
	result, err := adapter.ParseResult(path)
	if err != nil {
		t.Fatal(err)
	}
	if result != "the answer is 42" {
		t.Fatalf("ParseResult=%q want a single final answer without duplicates", result)
	}
}

func TestDSHAdapterParseSessionID(t *testing.T) {
	path := filepath.Join(t.TempDir(), "stream.jsonl")
	data := strings.Join([]string{
		`{"event":"turn/start","session_id":"sess-9"}`,
		`{"event":"assistant/message","text":"hi"}`,
	}, "\n")
	if err := os.WriteFile(path, []byte(data), 0o600); err != nil {
		t.Fatal(err)
	}
	adapter := &DSHAdapter{}
	id, err := adapter.ParseSessionID(path)
	if err != nil {
		t.Fatal(err)
	}
	if id != "sess-9" {
		t.Fatalf("session id=%q want sess-9", id)
	}
}
