package driver

import (
	"bufio"
	"bytes"
	"encoding/json"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/protocol"
	"os"
	"reflect"
	"testing"
	"time"
)

func TestResponseTPSSamplerTextAndRepeatedCumulativeUsage(t *testing.T) {
	clock := time.UnixMilli(1000)
	sampler := newResponseTPSSampler(func() time.Time { return clock })
	observe := func(value string) { sampler.observe([]byte(value)) }
	observe(`{"type":"message_start","event":{"message":{"id":"r1","model":"deepseek-v4.1-flash-ioa"}}}`)
	clock = clock.Add(120 * time.Millisecond)
	observe(`{"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}`)
	observe(`{"type":"message_delta","event":{"usage":{"output_tokens":2}}}`)
	observe(`{"type":"message_delta","event":{"usage":{"output_tokens":2}}}`)
	clock = clock.Add(80 * time.Millisecond)
	observe(`{"type":"message_stop"}`)

	data := map[string]any{}
	sampler.takeSamples(data)
	want := map[string]any{
		"tps_sampling_contract": "response_v1",
		"tps_samples": []any{map[string]any{
			"response_id": "r1", "model": "deepseek-v4.1-flash-ioa", "output_tokens": int64(2),
			"first_token_at_ms": int64(1120), "completed_at_ms": int64(1200),
		}},
	}
	if !reflect.DeepEqual(data, want) {
		t.Fatalf("payload = %#v, want %#v", data, want)
	}
}

func TestResponseTPSSamplerToolArgsReasoningAndChildStreams(t *testing.T) {
	clock := time.UnixMilli(5000)
	sampler := newResponseTPSSampler(func() time.Time { return clock })
	sampler.observe([]byte(`{"type":"message_start","parent_tool_use_id":"child","event":{"message":{"id":"child","model":"m"}}}`))
	sampler.observe([]byte(`{"type":"message_start","event":{"message":{"id":"r","model":"m"}}}`))
	clock = clock.Add(time.Second)
	sampler.observe([]byte(`{"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"reason"}}`))
	clock = clock.Add(2 * time.Second)
	sampler.observe([]byte(`{"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{}"}}`))
	sampler.observe([]byte(`{"type":"message_delta","event":{"usage":{"output_tokens":4}}}`))
	sampler.observe([]byte(`{"type":"message_stop"}`))
	if len(sampler.samples) != 1 || sampler.samples[0].FirstTokenAtMS != 6000 || sampler.samples[0].CompletedAtMS != 8000 {
		t.Fatalf("samples = %#v", sampler.samples)
	}
}

func TestResponseTPSSamplerRejectsInvalidOrDuplicateTerminals(t *testing.T) {
	clock := time.UnixMilli(9000)
	sampler := newResponseTPSSampler(func() time.Time { return clock })
	start := []byte(`{"type":"message_start","event":{"message":{"id":"r","model":"m"}}}`)
	sampler.observe(start)
	sampler.observe([]byte(`{"type":"content_block_delta","delta":{"type":"text_delta","text":"x"}}`))
	sampler.observe([]byte(`{"type":"message_delta","event":{"usage":{"output_tokens":0.5}}}`))
	sampler.observe([]byte(`{"type":"message_stop"}`))
	sampler.observe(start)
	sampler.observe([]byte(`{"type":"message_delta","event":{"usage":{"output_tokens":9}}}`))
	sampler.observe([]byte(`{"type":"message_stop"}`))
	if len(sampler.samples) != 0 {
		t.Fatalf("invalid/duplicate stream produced samples: %#v", sampler.samples)
	}

	// Assistant metadata is intentionally not observed as a usage boundary.
	var metadata map[string]any
	if err := json.Unmarshal([]byte(`{"type":"assistant","message":{"usage":{"output_tokens":99}}}`), &metadata); err != nil {
		t.Fatal(err)
	}
	sampler.observe([]byte(`{"type":"assistant","message":{"usage":{"output_tokens":99}}}`))
}
func TestResponseTPSSamplerRejectsMismatchAndFailedTerminals(t *testing.T) {
	clock := time.UnixMilli(12000)
	sampler := newResponseTPSSampler(func() time.Time { return clock })
	sampler.observe([]byte(`{"type":"message_start","event":{"message":{"id":"r1","model":"m"}}}`))
	sampler.observe([]byte(`{"type":"content_block_delta","response_id":"r2","delta":{"type":"text_delta","text":"wrong"}}`))
	sampler.observe([]byte(`{"type":"message_delta","event":{"usage":{"output_tokens":1}}}`))
	sampler.observe([]byte(`{"type":"message_stop","response_id":"r2"}`))
	if len(sampler.samples) != 0 {
		t.Fatalf("mismatched response produced samples: %#v", sampler.samples)
	}

	sampler.observe([]byte(`{"type":"message_start","event":{"message":{"id":"retry","model":"m"}}}`))
	sampler.observe([]byte(`{"type":"content_block_delta","delta":{"type":"text_delta","text":"x"}}`))
	sampler.observe([]byte(`{"type":"failed"}`))
	sampler.observe([]byte(`{"type":"message_stop"}`))
	if len(sampler.samples) != 0 {
		t.Fatalf("failed response produced samples: %#v", sampler.samples)
	}
}
func TestResponseTPSSamplerDoesNotSampleLegacyFullMessages(t *testing.T) {
	sampler := newResponseTPSSampler(time.Now)
	sampler.observe([]byte(`{"type":"assistant","message":{"id":"legacy","model":"m","content":[{"text":"complete"}],"usage":{"output_tokens":3}}}`))
	sampler.observe([]byte(`{"type":"message_stop"}`))
	if len(sampler.samples) != 0 {
		t.Fatalf("legacy full-message stream produced samples: %#v", sampler.samples)
	}
}

// Replays observed CodeBuddy envelopes through the actual Tee, not an invented
// flattened stream shape. Text/arguments are placeholders; IDs/timing/counts
// retain the source fixture's relationships.
func TestResponseTPSRealCodeBuddyTeeReplay(t *testing.T) {
	f, err := os.Open("testdata/codebuddy_tps_sanitized.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	var events []protocol.Event
	var log bytes.Buffer
	tee := NewTranscriptTeeWithEventHandler("codebuddy", &log, func(e protocol.Event) { events = append(events, e) })
	var now time.Time
	tee.now = func() time.Time { return now }
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		var row struct {
			At     int64           `json:"at_ms"`
			Record json.RawMessage `json:"record"`
		}
		if err := json.Unmarshal(scanner.Bytes(), &row); err != nil {
			t.Fatal(err)
		}
		now = time.UnixMilli(row.At)
		if _, err := tee.Write(append(row.Record, '\n')); err != nil {
			t.Fatal(err)
		}
	}
	if err := scanner.Err(); err != nil {
		t.Fatal(err)
	}
	var samples []any
	for _, e := range events {
		if e.Type == "turn_usage" {
			if e.Data["tps_sampling_contract"] != "response_v1" {
				t.Fatalf("missing TPS contract: %#v", e.Data)
			}
			samples, _ = e.Data["tps_samples"].([]any)
		}
	}
	if len(samples) != 2 {
		t.Fatalf("want two matched responses, got %#v", samples)
	}
	var tokens, duration int64
	for _, raw := range samples {
		m := raw.(map[string]any)
		tokens += m["output_tokens"].(int64)
		duration += m["completed_at_ms"].(int64) - m["first_token_at_ms"].(int64)
		if m["model"] != "deepseek-v4.1-flash-ioa" {
			t.Fatal(m)
		}
	}
	if tokens != 226 || duration < 1800 || duration > 1820 {
		t.Fatalf("unexpected paired totals tokens=%d duration=%d", tokens, duration)
	}
}
