package execution

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/protocol"
)

func TestEventSink_StreamV1Contract(t *testing.T) {
	var buf bytes.Buffer
	base := Result{Status: "running", Profile: "p", ClientFamily: "opencode"}
	sink := newEventSink(&buf, protocol.OutputFormatStreamJSON, base)

	// 1. run_started
	sink.emit("run_started", map[string]any{
		"profile":       "p",
		"client_family": "opencode",
		"cwd":           "/tmp/work",
	})
	// 2. message -> aggregated into result.Summary
	sink.handleNormalizedEvent(protocol.Event{Type: "message", Data: map[string]any{"text": "hello world"}})
	// 3. turn_usage -> aggregated into result.Usage
	sink.handleNormalizedEvent(protocol.Event{Type: "turn_usage", Data: map[string]any{"input_tokens": 12.0, "output_tokens": 3.0, "duration_ms": 0}})
	// 4. run_finished
	sink.emit("run_finished", map[string]any{
		"status":    "done",
		"exit_code": 0,
		"summary":   "hello world",
	})

	lines := strings.Split(strings.TrimRight(buf.String(), "\n"), "\n")
	if len(lines) != 4 {
		t.Fatalf("expected 4 envelope lines, got %d: %q", len(lines), buf.String())
	}

	var envelopes []protocol.Envelope
	runIDs := map[string]bool{}
	for i, line := range lines {
		var env protocol.Envelope
		if err := json.Unmarshal([]byte(line), &env); err != nil {
			t.Fatalf("line %d not valid JSON: %v; raw=%q", i, err, line)
		}
		envelopes = append(envelopes, env)
		runIDs[env.RunID] = true
	}

	// Exactly one shared run_id, prefixed fr_ and 16 hex chars after prefix.
	if len(runIDs) != 1 {
		t.Fatalf("expected one shared run_id, got %v", runIDs)
	}
	if !strings.HasPrefix(envelopes[0].RunID, "fr_") {
		t.Fatalf("run_id=%q must start with fr_", envelopes[0].RunID)
	}
	hexPart := strings.TrimPrefix(envelopes[0].RunID, "fr_")
	if len(hexPart) != 16 {
		t.Fatalf("run_id hex part=%q must be 16 hex chars", hexPart)
	}
	for _, c := range hexPart {
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')) {
			t.Fatalf("run_id hex part=%q contains non-hex char", hexPart)
		}
	}

	// protocol/version envelope fields.
	for _, env := range envelopes {
		if env.Protocol != protocol.StreamProtocol {
			t.Fatalf("protocol=%q want %q", env.Protocol, protocol.StreamProtocol)
		}
		if env.Version != protocol.StreamVersion {
			t.Fatalf("version=%d want %d", env.Version, protocol.StreamVersion)
		}
		// parseable UTC timestamp.
		if env.Timestamp.IsZero() || env.Timestamp.Location() != time.UTC {
			t.Fatalf("timestamp=%v not UTC/parseable", env.Timestamp)
		}
	}

	// seq 1..4 in order.
	for i, env := range envelopes {
		if env.Seq != i+1 {
			t.Fatalf("envelope %d seq=%d want %d", i, env.Seq, i+1)
		}
	}

	// event types/order.
	wantTypes := []string{"run_started", "message", "turn_usage", "run_finished"}
	for i, env := range envelopes {
		if env.Type != wantTypes[i] {
			t.Fatalf("envelope %d type=%q want %q", i, env.Type, wantTypes[i])
		}
	}

	// data asserts for key envelopes.
	if envelopes[0].Data["profile"] != "p" {
		t.Fatalf("run_started profile=%v want p", envelopes[0].Data["profile"])
	}
	if envelopes[0].Data["client_family"] != "opencode" {
		t.Fatalf("run_started client_family=%v want opencode", envelopes[0].Data["client_family"])
	}
	if envelopes[3].Data["status"] != "done" {
		t.Fatalf("run_finished status=%v want done", envelopes[3].Data["status"])
	}
	if envelopes[3].Data["exit_code"] != float64(0) {
		t.Fatalf("run_finished exit_code=%v want 0", envelopes[3].Data["exit_code"])
	}
	if envelopes[3].Data["summary"] != "hello world" {
		t.Fatalf("run_finished summary=%v want 'hello world'", envelopes[3].Data["summary"])
	}

	// Aggregated summary/usage carried into the final result snapshot.
	snap := sink.resultSnapshot()
	if snap.Summary != "hello world" {
		t.Fatalf("snapshot summary=%q want 'hello world'", snap.Summary)
	}
	if snap.Usage == nil || snap.Usage["input_tokens"] != 12.0 {
		t.Fatalf("snapshot usage=%v want input_tokens 12", snap.Usage)
	}

	// No native event leakage: every envelope type must be a Stream v1 type.
	for _, env := range envelopes {
		switch env.Type {
		case "run_started", "message", "turn_usage", "run_finished":
		default:
			t.Fatalf("unexpected native event leakage type=%q", env.Type)
		}
	}
}
