package driver

import (
	"bufio"
	"bytes"
	"encoding/json"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/protocol"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"
)

// wantTokens returns the fixed cl100k_base count a tokenizer_v1 sample is
// expected to carry for the given observed text.
func wantTokens(t *testing.T, text string) int64 {
	t.Helper()
	tokens, ok := countTPSTokens(text)
	if !ok {
		t.Fatalf("fixed tokenizer unavailable")
	}
	return tokens
}

func TestResponseTPSSamplerTokenizerWindowWithoutUsage(t *testing.T) {
	clock := time.UnixMilli(1000)
	sampler := newResponseTPSSampler(func() time.Time { return clock })
	observe := func(value string) { sampler.observe([]byte(value)) }
	observe(`{"type":"message_start","event":{"message":{"id":"r1","model":"deepseek-v4.1-flash-ioa"}}}`)
	clock = clock.Add(120 * time.Millisecond)
	observe(`{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"hi"}}`)
	// Official usage is no longer a sampling prerequisite, and a repeated
	// cumulative usage record changes nothing either way.
	observe(`{"type":"message_delta","event":{"usage":{"output_tokens":2}}}`)
	observe(`{"type":"message_delta","event":{"usage":{"output_tokens":2}}}`)
	clock = clock.Add(100 * time.Millisecond)
	observe(`{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"there"}}`)
	observe(`{"type":"message_stop"}`)

	data := map[string]any{}
	sampler.takeSamples(data)
	want := map[string]any{
		"tps_sampling_contract": tokenizerTPSSamplingContract,
		"tps_samples": []any{map[string]any{
			"response_id": "r1", "model": "deepseek-v4.1-flash-ioa", "output_tokens": wantTokens(t, "hithere"),
			"first_token_at_ms": int64(1120), "completed_at_ms": int64(1220),
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
	sampler.observe([]byte(`{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"reason"}}`))
	clock = clock.Add(2 * time.Second)
	sampler.observe([]byte(`{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{}"}}`))
	sampler.observe([]byte(`{"type":"message_stop"}`))
	if len(sampler.samples) != 1 {
		t.Fatalf("samples = %#v", sampler.samples)
	}
	sample := sampler.samples[0]
	if sample.FirstTokenAtMS != 6000 || sample.CompletedAtMS != 8000 {
		t.Fatalf("window = %d..%d, want 6000..8000", sample.FirstTokenAtMS, sample.CompletedAtMS)
	}
	if want := wantTokens(t, "reason") + wantTokens(t, "{}"); sample.OutputTokens != want {
		t.Fatalf("tokens = %d, want the per-block concatenated count %d", sample.OutputTokens, want)
	}
}

// A window whose deltas collapsed onto one arrival timestamp is unobservable:
// it is skipped without poisoning the sampler, and a later complete response
// is still sampled.
func TestResponseTPSSamplerSkipsUnobservableWindows(t *testing.T) {
	clock := time.UnixMilli(20000)
	sampler := newResponseTPSSampler(func() time.Time { return clock })
	sampler.observe([]byte(`{"type":"message_start","event":{"message":{"id":"burst","model":"m"}}}`))
	sampler.observe([]byte(`{"type":"content_block_delta","delta":{"type":"text_delta","text":"a"}}`))
	sampler.observe([]byte(`{"type":"content_block_delta","delta":{"type":"text_delta","text":"b"}}`))
	sampler.observe([]byte(`{"type":"message_stop"}`))
	clock = clock.Add(time.Second)
	sampler.observe([]byte(`{"type":"message_start","event":{"message":{"id":"steady","model":"m"}}}`))
	sampler.observe([]byte(`{"type":"content_block_delta","delta":{"type":"text_delta","text":"c"}}`))
	clock = clock.Add(150 * time.Millisecond)
	sampler.observe([]byte(`{"type":"content_block_delta","delta":{"type":"text_delta","text":"d"}}`))
	sampler.observe([]byte(`{"type":"message_stop"}`))
	if len(sampler.samples) != 1 || sampler.samples[0].ResponseID != "steady" {
		t.Fatalf("only the observable window must be sampled: %#v", sampler.samples)
	}
	if sampler.samples[0].OutputTokens != wantTokens(t, "cd") {
		t.Fatalf("tokens = %d, want the concatenated count", sampler.samples[0].OutputTokens)
	}
}

func TestResponseTPSSamplerRejectsDuplicateTerminalsAndIgnoresUsageValidity(t *testing.T) {
	clock := time.UnixMilli(9000)
	sampler := newResponseTPSSampler(func() time.Time { return clock })
	start := []byte(`{"type":"message_start","event":{"message":{"id":"r","model":"m"}}}`)
	sampler.observe(start)
	sampler.observe([]byte(`{"type":"content_block_delta","delta":{"type":"text_delta","text":"x"}}`))
	// A fractional usage figure no longer gates the speed sample: official
	// usage and the tokenizer_v1 claim are independent.
	sampler.observe([]byte(`{"type":"message_delta","event":{"usage":{"output_tokens":0.5}}}`))
	clock = clock.Add(150 * time.Millisecond)
	sampler.observe([]byte(`{"type":"content_block_delta","delta":{"type":"text_delta","text":"y"}}`))
	sampler.observe([]byte(`{"type":"message_stop"}`))
	if len(sampler.samples) != 1 || sampler.samples[0].OutputTokens != wantTokens(t, "xy") {
		t.Fatalf("usage validity must not gate the tokenizer sample: %#v", sampler.samples)
	}
	sampler.observe(start)
	sampler.observe([]byte(`{"type":"message_delta","event":{"usage":{"output_tokens":9}}}`))
	sampler.observe([]byte(`{"type":"message_stop"}`))
	if len(sampler.samples) != 1 {
		t.Fatalf("a replayed response id must not produce a second sample: %#v", sampler.samples)
	}

	// Assistant metadata is intentionally not observed as generation.
	sampler.observe([]byte(`{"type":"assistant","message":{"usage":{"output_tokens":99}}}`))
	if len(sampler.samples) != 1 {
		t.Fatalf("assistant metadata must not become generation: %#v", sampler.samples)
	}
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
	clock = clock.Add(200 * time.Millisecond)
	sampler.observe([]byte(`{"type":"content_block_delta","delta":{"type":"text_delta","text":"y"}}`))
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

	// Oracle rebuilt independently from the fixture: per response, concatenate
	// every non-empty delta of each content channel and remember the first and
	// last non-empty delta arrivals.
	type oracleResponse struct {
		id     string
		blocks map[string]*strings.Builder
		first  int64
		last   int64
	}
	var want []*oracleResponse
	var current *oracleResponse
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
		var record map[string]any
		if err := json.Unmarshal(row.Record, &record); err != nil {
			t.Fatal(err)
		}
		typ, _ := record["type"].(string)
		event, _ := record["event"].(map[string]any)
		if typ == "stream_event" || typ == "" {
			typ, _ = event["type"].(string)
		}
		switch typ {
		case "message_start":
			message, _ := event["message"].(map[string]any)
			id, _ := message["id"].(string)
			current = &oracleResponse{id: id, blocks: map[string]*strings.Builder{}}
		case "content_block_delta":
			if current == nil {
				t.Fatal("delta before message_start")
			}
			delta, _ := event["delta"].(map[string]any)
			deltaType, _ := delta["type"].(string)
			var text string
			switch deltaType {
			case "text_delta":
				text, _ = delta["text"].(string)
			case "thinking_delta":
				text, _ = delta["thinking"].(string)
			case "input_json_delta":
				text, _ = delta["partial_json"].(string)
			}
			if text == "" {
				continue
			}
			block := current.blocks[deltaType]
			if block == nil {
				block = &strings.Builder{}
				current.blocks[deltaType] = block
			}
			block.WriteString(text)
			if current.first == 0 {
				current.first = row.At
			}
			current.last = row.At
		case "message_stop":
			if current != nil {
				want = append(want, current)
				current = nil
			}
		}
	}
	if err := scanner.Err(); err != nil {
		t.Fatal(err)
	}
	var samples []any
	for _, e := range events {
		if e.Type == "turn_usage" {
			if e.Data["tps_sampling_contract"] != tokenizerTPSSamplingContract {
				t.Fatalf("missing tokenizer contract: %#v", e.Data)
			}
			samples, _ = e.Data["tps_samples"].([]any)
		}
	}
	if len(samples) != len(want) {
		t.Fatalf("want %d matched responses, got %#v", len(want), samples)
	}
	for i, raw := range samples {
		sample := raw.(map[string]any)
		expected := want[i]
		var tokens int64
		for _, block := range expected.blocks {
			tokens += wantTokens(t, block.String())
		}
		if sample["response_id"] != expected.id || sample["model"] != "deepseek-v4.1-flash-ioa" {
			t.Fatalf("sample %d identity = %v, want %s", i, sample, expected.id)
		}
		if sample["output_tokens"] != tokens {
			t.Fatalf("sample %d tokens = %v, want the concatenated count %d", i, sample["output_tokens"], tokens)
		}
		first, last := sample["first_token_at_ms"].(int64), sample["completed_at_ms"].(int64)
		if first != expected.first || last != expected.last {
			t.Fatalf("sample %d window = %d..%d, want %d..%d", i, first, last, expected.first, expected.last)
		}
		if last-first < tokenizerMinimumWindowMS {
			t.Fatalf("sample %d window %dms is below the observable minimum", i, last-first)
		}
	}
}
