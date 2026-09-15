package driver

import (
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/protocol"
)

// Captured from Cursor 2026.09.10-fd3934a. Fixtures retain exact usage and
// timing while removing local identities and compacting consecutive deltas.
func TestCursorTPSLiveTranscriptReplay(t *testing.T) {
	for _, tc := range []struct {
		name, model          string
		accepted             bool
		tokens, generationMS int64
	}{
		{"text", "cursor-grok-4.6-high", true, 673, 12677},
		// Composer buffered its entire first generation into 21ms. Keeping the
		// terminal's 881 tokens while dropping that window would inflate TPS.
		{"composer", "composer-2.5", false, 881, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			path := filepath.Join("testdata", "cursor_tps_"+tc.name+"_sanitized.jsonl")
			data, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			var events []protocol.Event
			tee := NewTranscriptTeeWithEventHandler("cursor", io.Discard, func(e protocol.Event) { events = append(events, e) })
			tee.SetCursorSamplingModel(tc.model)
			if _, err = tee.Write(data); err != nil {
				t.Fatal(err)
			}
			tee.FinalizeCursorStream()
			if !tee.cursorTrack.result().IsValid() {
				t.Fatal("invalid native stream")
			}
			usage := lastTurnUsage(events)
			if (usage["tps_sampling_contract"] == "response_v1") != tc.accepted {
				t.Fatalf("sampling acceptance: %#v", usage)
			}
			if tc.accepted {
				samples := usage["tps_samples"].([]any)
				if len(samples) != 1 {
					t.Fatalf("aggregate samples: %#v", samples)
				}
				sample := samples[0].(map[string]any)
				if sample["output_tokens"] != tc.tokens || sample["model"] != tc.model {
					t.Fatalf("wrong attribution: %#v", sample)
				}
				var duration int64
				for _, raw := range sample["generation_windows"].([]any) {
					w := raw.(map[string]any)
					duration += w["completed_at_ms"].(int64) - w["first_token_at_ms"].(int64)
				}
				if duration != tc.generationMS {
					t.Fatalf("generation ms=%d want %d", duration, tc.generationMS)
				}
			}
			result, err := (&CursorAdapter{}).ParseResult(path)
			if err != nil {
				t.Fatal(err)
			}
			var streamed strings.Builder
			for _, e := range events {
				if e.Type == "message" {
					streamed.WriteString(e.Data["text"].(string))
				}
			}
			if strings.TrimSpace(streamed.String()) != result {
				t.Fatal("Tee and adapter disagree")
			}
			lines := strings.Split(strings.TrimSpace(string(data)), "\n")
			var terminal struct {
				Result string `json:"result"`
			}
			if err := json.Unmarshal([]byte(lines[len(lines)-1]), &terminal); err != nil {
				t.Fatal(err)
			}
			if result != strings.TrimSpace(terminal.Result) {
				t.Fatal("reconstructed text differs from native aggregate")
			}
		})
	}
}

// Every negative case starts with an otherwise eligible sample. This prevents
// a zero-duration baseline from masking a missing rejection guard.
func TestCursorTPSRejectsUnknownSignalsFromEligibleBaseline(t *testing.T) {
	signals := []string{
		"",
		`{"type":"background_task","timestamp_ms":10200}`,
		`{"type":"system","subtype":"model_changed","model":"other"}`,
		`{"type":"thinking","subtype":"other","text":"hidden","timestamp_ms":10200}`,
		`{"type":"tool_call","subtype":"unknown","timestamp_ms":10200}`,
		`{"type":"connection","subtype":"reconnecting","timestamp_ms":10200}`,
		`{"type":"retry","timestamp_ms":10200}`,
		`{"type":"user","session_id":"s1"}`,
		`{"type":"assistant","session_id":"different","message":{"content":[{"type":"text","text":"hidden"}]},"timestamp_ms":10200}`,
		`{"type":"thinking","subtype":"completed","timestamp_ms":10200.5}`,
		`{"type":"assistant","message":{"content":[{"type":"text","text":"missing timestamp"}]}}`,
	}
	for _, signal := range signals {
		t.Run(signal, func(t *testing.T) {
			var events []protocol.Event
			tee := NewTranscriptTeeWithEventHandler("cursor", io.Discard, func(e protocol.Event) { events = append(events, e) })
			tee.SetCursorSamplingModel("composer-2.5")
			for _, line := range []string{cursorTPSInit,
				`{"type":"assistant","message":{"content":[{"type":"text","text":"x"}]},"timestamp_ms":10100}`,
				signal,
				`{"type":"assistant","message":{"content":[{"type":"text","text":" y"}]},"timestamp_ms":10400}`,
				`{"type":"assistant","message":{"content":[{"type":"text","text":"x y"}]}}`,
				cursorTPSResult(600),
			} {
				if line != "" {
					if _, err := tee.Write([]byte(line + "\n")); err != nil {
						t.Fatal(err)
					}
				}
			}
			tee.FinalizeCursorStream()
			admitted := lastTurnUsage(events)["tps_sampling_contract"] == "response_v1"
			if admitted != (signal == "") {
				t.Fatalf("admitted=%v for %q", admitted, signal)
			}
		})
	}
}
