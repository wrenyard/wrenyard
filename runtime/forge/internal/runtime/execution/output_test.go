package execution

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/protocol"
)

func TestPrintResult_TextSummaryNewline(t *testing.T) {
	var out, errb bytes.Buffer
	result := Result{Status: "done", Profile: "p", Summary: "all good", ExitCode: 0}
	code := printResult(result, protocol.OutputFormatText, &out, &errb)
	if code != 0 {
		t.Fatalf("exit code=%d want 0", code)
	}
	got := out.String()
	// Text summary prints exactly one trailing newline.
	if got != "all good\n" {
		t.Fatalf("got %q want exact 'all good\\n'", got)
	}
	if errb.Len() != 0 {
		t.Fatalf("stderr=%q want empty", errb.String())
	}
}

func TestPrintResult_TextEmptySummarySilent(t *testing.T) {
	var out, errb bytes.Buffer
	result := Result{Status: "running", Profile: "p", ExitCode: 1}
	code := printResult(result, protocol.OutputFormatText, &out, &errb)
	if code != 1 {
		t.Fatalf("exit code=%d want 1 for non-done status", code)
	}
	if out.Len() != 0 {
		t.Fatalf("stdout=%q want empty", out.String())
	}
}

func TestPrintResult_JSONSingleObjectOmitEmpty(t *testing.T) {
	var out, errb bytes.Buffer
	result := Result{
		Status:       "done",
		Profile:      "p",
		ClientFamily: "opencode",
		ExitCode:     0,
		Summary:      "ok",
	}
	code := printResult(result, protocol.OutputFormatJSON, &out, &errb)
	if code != 0 {
		t.Fatalf("exit code=%d want 0", code)
	}
	// JSON output must be a single object (MarshalIndent appends newline).
	raw := strings.TrimRight(out.String(), "\n")
	var decoded map[string]any
	if err := json.Unmarshal([]byte(raw), &decoded); err != nil {
		t.Fatalf("output not a single JSON object: %v; raw=%q", err, out.String())
	}
	// omitempty fields must be absent.
	if _, ok := decoded["native_session_id"]; ok {
		t.Fatalf("native_session_id should be omitted, got %v", decoded["native_session_id"])
	}
	if _, ok := decoded["usage"]; ok {
		t.Fatalf("usage should be omitted, got %v", decoded["usage"])
	}
	if _, ok := decoded["error"]; ok {
		t.Fatalf("error should be omitted, got %v", decoded["error"])
	}
}

func TestPrintResult_StreamEmitsNoDuplicateOutput(t *testing.T) {
	var out, errb bytes.Buffer
	// printResult is a no-op for stream format (stream lines come from Execute).
	result := Result{Status: "done", Profile: "p", Summary: "dup?", ExitCode: 0}
	code := printResult(result, protocol.OutputFormatStreamJSON, &out, &errb)
	if code != 0 {
		t.Fatalf("exit code=%d want 0", code)
	}
	if out.Len() != 0 {
		t.Fatalf("stream printResult must emit no output, got %q", out.String())
	}
}

func TestPrintResult_FailedReturnsTopLevel1AndSingleJSON(t *testing.T) {
	var out, errb bytes.Buffer
	result := Result{Status: "failed", Profile: "p", ExitCode: 1, Error: "boom"}
	code := printResult(result, protocol.OutputFormatJSON, &out, &errb)
	if code != 1 {
		t.Fatalf("exit code=%d want top-level 1 for failed result", code)
	}
	raw := strings.TrimRight(out.String(), "\n")
	var decoded map[string]any
	if err := json.Unmarshal([]byte(raw), &decoded); err != nil {
		t.Fatalf("output not a single JSON object: %v; raw=%q", err, out.String())
	}
	// Exactly one JSON object: nested decode of the whole buffer works and the
	// error field is present.
	if decoded["error"] != "boom" {
		t.Fatalf("error field=%v want boom", decoded["error"])
	}
	if decoded["exit_code"] != float64(1) {
		t.Fatalf("exit_code=%v want 1", decoded["exit_code"])
	}
}
