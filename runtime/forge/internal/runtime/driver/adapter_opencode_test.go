package driver

import (
	"strings"
	"testing"
)

func TestOpenCodeAdapterParseResultFromTextPart(t *testing.T) {
	path := writeAdapterLog(t, `{"type":"step_start","part":{"type":"step-start"}}
{"type":"text","part":{"type":"text","text":"OC_GPT_OK"}}
{"type":"step_finish","part":{"type":"step-finish","tokens":{"total":10,"input":8,"output":2}}}
`)

	result, err := (&OpenCodeAdapter{}).ParseResult(path)
	if err != nil {
		t.Fatal(err)
	}
	if result != "OC_GPT_OK" {
		t.Fatalf("result = %q, want OC_GPT_OK", result)
	}
}

func TestOpenCodeAdapterParseResultFallsBackToRawLines(t *testing.T) {
	path := writeAdapterLog(t, "first raw line\n"+`{"type":"rendered_prompt","prompt":"secret context"}`+"\nlast raw line\n")

	result, err := (&OpenCodeAdapter{}).ParseResult(path)
	if err != nil {
		t.Fatal(err)
	}
	if result != "first raw line\nlast raw line" {
		t.Fatalf("raw fallback result = %q", result)
	}
}

func TestOpenCodeAdapterParseSessionIDExtractsLatest(t *testing.T) {
	path := writeAdapterLog(t, strings.Join([]string{
		`{"type":"step_start","sessionID":"oc-early"}`,
		`{"type":"text","part":{"type":"text","text":"OC_GPT_OK"}}`,
		`{"type":"step_finish","session_id":"oc-latest"}`,
	}, "\n")+"\n")

	id, err := (&OpenCodeAdapter{}).ParseSessionID(path)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if id != "oc-latest" {
		t.Fatalf("session id=%q want oc-latest", id)
	}
}

func TestOpenCodeAdapterParseSessionIDMissing(t *testing.T) {
	path := writeAdapterLog(t, `{"type":"text","part":{"type":"text","text":"no session here"}}`+"\n")
	_, err := (&OpenCodeAdapter{}).ParseSessionID(path)
	if err == nil || !strings.Contains(err.Error(), "no opencode session id") {
		t.Fatalf("expected missing session error, got %v", err)
	}
}
