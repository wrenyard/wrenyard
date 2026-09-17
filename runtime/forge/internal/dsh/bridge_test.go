package dsh

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// bridgeRun replays upstream DSH session events through the embedded plugin.
// The PluginSource is written to a temporary .mjs file, a fake Cordis ctx.on
// handler captures the registered session/event listener, and the listener is
// invoked for each supplied event. The plugin's process.stdout writes are the
// bridge JSONL lines under test. No real inference is executed.
func bridgeRun(t *testing.T, events []map[string]any) []map[string]any {
	t.Helper()
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node not available")
	}
	dir := t.TempDir()
	pluginPath := filepath.Join(dir, "forge-dsh-bridge.mjs")
	if err := os.WriteFile(pluginPath, []byte(PluginSource), 0o600); err != nil {
		t.Fatalf("write plugin: %v", err)
	}

	harness := `import { apply } from './forge-dsh-bridge.mjs';
import { readFileSync } from 'node:fs';

const events = JSON.parse(readFileSync(process.argv[2], 'utf8'));
let handler = null;
const ctx = { on: (name, fn) => { if (name === 'session/event') handler = fn; } };
apply(ctx);
if (!handler) { process.stderr.write('no session/event handler\n'); process.exit(2); }
const session = { id: 'root', header: { origin: 'root' } };
for (const e of events) handler(session, e);
`
	if err := os.WriteFile(filepath.Join(dir, "harness.mjs"), []byte(harness), 0o600); err != nil {
		t.Fatalf("write harness: %v", err)
	}
	eventsJSON, err := json.Marshal(events)
	if err != nil {
		t.Fatalf("marshal events: %v", err)
	}
	eventsPath := filepath.Join(dir, "events.json")
	if err := os.WriteFile(eventsPath, eventsJSON, 0o600); err != nil {
		t.Fatalf("write events: %v", err)
	}

	cmd := exec.CommandContext(context.Background(), node, "harness.mjs", eventsPath)
	cmd.Dir = dir
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		t.Fatalf("node harness: %v\nstderr: %s", err, stderr.String())
	}

	var out []map[string]any
	for _, line := range strings.Split(strings.TrimSpace(stdout.String()), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		var event map[string]any
		if err := json.Unmarshal([]byte(line), &event); err != nil {
			t.Fatalf("invalid bridge JSON %q: %v", line, err)
		}
		out = append(out, event)
	}
	return out
}

func findEvent(events []map[string]any, name string) map[string]any {
	for _, e := range events {
		if e["event"] == name {
			return e
		}
	}
	return nil
}

func findEventAll(events []map[string]any, name string) []map[string]any {
	var out []map[string]any
	for _, e := range events {
		if e["event"] == name {
			out = append(out, e)
		}
	}
	return out
}

func numValue(t *testing.T, m map[string]any, key string) float64 {
	t.Helper()
	v, ok := m[key].(float64)
	if !ok {
		t.Fatalf("expected numeric %q in %v", key, m)
	}
	return v
}

// realTurn is the verified real upstream sequence: request/header route,
// turn/start, step/start, a reasoning first token, streamed text deltas, an
// assistant/message final with usage partitions, and a completed turn/end.
func realTurn(seqBase int, model string, text string, outputTokens int) []map[string]any {
	return []map[string]any{
		{"type": "request/header", "seq": seqBase, "time": 1000, "data": map[string]any{"header": map[string]any{"config": map[string]any{"model": model}}}},
		{"type": "turn/start", "seq": seqBase + 1, "time": 1010, "data": map[string]any{"turn": 0}},
		{"type": "step/start", "seq": seqBase + 2, "time": 1012, "data": map[string]any{"turn": 0, "step": 0}},
		{"type": "assistant/chunk", "seq": seqBase + 3, "time": 1015, "data": map[string]any{"turn": 0, "step": 0, "chunk": map[string]any{"type": "reasoning-delta", "text": "r"}}},
		{"type": "assistant/chunk", "seq": seqBase + 4, "time": 1020, "data": map[string]any{"turn": 0, "step": 0, "chunk": map[string]any{"type": "text-delta", "text": "hel"}}},
		{"type": "assistant/chunk", "seq": seqBase + 5, "time": 1120, "data": map[string]any{"turn": 0, "step": 0, "chunk": map[string]any{"type": "text-delta", "text": "lo"}}},
		{"type": "assistant/message", "seq": seqBase + 6, "time": 1500, "data": map[string]any{"turn": 0, "step": 0, "message": map[string]any{"role": "assistant", "content": []any{map[string]any{"type": "text", "text": text}}}, "usage": map[string]any{"inputTokens": 10, "outputTokens": outputTokens}}},
		{"type": "turn/end", "seq": seqBase + 7, "time": 1510, "data": map[string]any{"turn": 0, "reason": map[string]any{"kind": "completed"}}},
	}
}

func generationList(t *testing.T, end map[string]any) []map[string]any {
	t.Helper()
	raw, ok := end["tps_generation"].([]any)
	if !ok {
		t.Fatalf("turn/end must carry a tps_generation list: %#v", end)
	}
	out := make([]map[string]any, 0, len(raw))
	for _, entry := range raw {
		generation, ok := entry.(map[string]any)
		if !ok {
			t.Fatalf("malformed generation entry: %#v", entry)
		}
		out = append(out, generation)
	}
	return out
}

func TestBridgeRealTurnGenerationAndText(t *testing.T) {
	out := bridgeRun(t, realTurn(0, "gpt-5", "ok", 100))

	chunks := findEventAll(out, "assistant/chunk")
	if len(chunks) != 2 {
		t.Fatalf("expected only the text-delta chunks to be surfaced, got %d: %v", len(chunks), chunks)
	}
	if chunks[0]["kind"] != "text" || chunks[0]["text"] != "hel" || chunks[1]["text"] != "lo" {
		t.Fatalf("text chunk mismatch: %v", chunks)
	}

	msg := findEvent(out, "assistant/message")
	if msg == nil || msg["text"] != "ok" {
		t.Fatalf("assistant/message text mismatch: %v", msg)
	}

	end := findEvent(out, "turn/end")
	if end == nil {
		t.Fatal("missing turn/end")
	}
	if duration, ok := end["duration"].(float64); !ok || duration <= 0 {
		t.Fatalf("complete usage must retain accounting duration: %#v", end)
	}
	if end["status"] != "complete" {
		t.Fatalf("status = %v, want complete", end["status"])
	}
	if _, ok := end["tps_sampling_contract"]; ok {
		t.Fatalf("bridge must not emit a sampling contract: %#v", end)
	}
	if _, ok := end["tps_samples"]; ok {
		t.Fatalf("bridge must not emit canonical samples: %#v", end)
	}
	generations := generationList(t, end)
	if len(generations) != 1 {
		t.Fatalf("expected exactly one generation, got %v", generations)
	}
	generation := generations[0]
	if generation["model"] != "gpt-5" {
		t.Fatalf("model = %v", generation["model"])
	}
	blocks, ok := generation["blocks"].(map[string]any)
	if !ok || blocks["text"] != "hello" {
		t.Fatalf("deltas must concatenate per block: %v", generation["blocks"])
	}
	// Observed reasoning contributes to speed but never to assistant text.
	if numValue(t, generation, "first_delta_at_ms") != 1015 {
		t.Fatalf("first_delta_at_ms = %v, want 1015", generation["first_delta_at_ms"])
	}
	if numValue(t, generation, "last_delta_at_ms") != 1120 {
		t.Fatalf("last_delta_at_ms = %v, want 1120", generation["last_delta_at_ms"])
	}

	usage := end["usage"].(map[string]any)
	if numValue(t, usage, "input_tokens") != 10 || numValue(t, usage, "output_tokens") != 100 {
		t.Fatalf("usage mismatch: %v", usage)
	}
	if _, ok := end["tps_sampling_gaps"]; ok {
		t.Fatalf("tps_sampling_gaps must not be emitted: %v", end["tps_sampling_gaps"])
	}
}

func TestBridgeSecondResponseAfterToolWait(t *testing.T) {
	events := []map[string]any{
		{"type": "request/header", "seq": 0, "time": 1000, "data": map[string]any{"header": map[string]any{"config": map[string]any{"model": "gpt-5"}}}},
		{"type": "turn/start", "seq": 1, "time": 1010, "data": map[string]any{"turn": 0}},
		{"type": "assistant/chunk", "seq": 2, "time": 1015, "data": map[string]any{"turn": 0, "step": 0, "chunk": map[string]any{"type": "text-delta", "text": "a"}}},
		{"type": "assistant/chunk", "seq": 3, "time": 1115, "data": map[string]any{"turn": 0, "step": 0, "chunk": map[string]any{"type": "text-delta", "text": "b"}}},
		{"type": "assistant/message", "seq": 4, "time": 1200, "data": map[string]any{"turn": 0, "step": 0, "message": map[string]any{"content": []any{map[string]any{"type": "text", "text": "ab"}}}, "usage": map[string]any{"inputTokens": 5, "outputTokens": 50}}},
		// A long tool wait, then a second step response in the same turn.
		{"type": "assistant/chunk", "seq": 5, "time": 600000, "data": map[string]any{"turn": 0, "step": 1, "chunk": map[string]any{"type": "text-delta", "text": "c"}}},
		{"type": "assistant/chunk", "seq": 6, "time": 600100, "data": map[string]any{"turn": 0, "step": 1, "chunk": map[string]any{"type": "text-delta", "text": "d"}}},
		{"type": "assistant/message", "seq": 7, "time": 600500, "data": map[string]any{"turn": 0, "step": 1, "message": map[string]any{"content": []any{map[string]any{"type": "text", "text": "cd"}}}, "usage": map[string]any{"inputTokens": 7, "outputTokens": 70}}},
		{"type": "turn/end", "seq": 8, "time": 600510, "data": map[string]any{"turn": 0, "reason": map[string]any{"kind": "completed"}}},
	}
	out := bridgeRun(t, events)
	end := findEvent(out, "turn/end")
	generations := generationList(t, end)
	if len(generations) != 2 {
		t.Fatalf("expected two paired generations, got %v", generations)
	}
	windows := map[string][2]float64{}
	for _, generation := range generations {
		blocks := generation["blocks"].(map[string]any)
		windows[blocks["text"].(string)] = [2]float64{numValue(t, generation, "first_delta_at_ms"), numValue(t, generation, "last_delta_at_ms")}
	}
	// The tool wait must never stretch either response's own window, and
	// completion latency (message after the last delta) must stay excluded.
	if windows["ab"] != [2]float64{1015, 1115} || windows["cd"] != [2]float64{600000, 600100} {
		t.Fatalf("generation pairing wrong: %v", windows)
	}
	usage := end["usage"].(map[string]any)
	if numValue(t, usage, "input_tokens") != 12 || numValue(t, usage, "output_tokens") != 120 {
		t.Fatalf("usage sum mismatch: %v", usage)
	}
}

func TestBridgeInheritedModelNextTurn(t *testing.T) {
	events := []map[string]any{
		{"type": "request/header", "seq": 0, "time": 1000, "data": map[string]any{"header": map[string]any{"config": map[string]any{"model": "gpt-5"}}}},
		{"type": "turn/start", "seq": 1, "time": 1010, "data": map[string]any{"turn": 0}},
		{"type": "assistant/chunk", "seq": 2, "time": 1015, "data": map[string]any{"turn": 0, "step": 0, "chunk": map[string]any{"type": "text-delta", "text": "a"}}},
		{"type": "assistant/chunk", "seq": 3, "time": 1115, "data": map[string]any{"turn": 0, "step": 0, "chunk": map[string]any{"type": "text-delta", "text": "a"}}},
		{"type": "assistant/message", "seq": 4, "time": 1200, "data": map[string]any{"turn": 0, "step": 0, "message": map[string]any{"content": []any{map[string]any{"type": "text", "text": "aa"}}}, "usage": map[string]any{"inputTokens": 5, "outputTokens": 50}}},
		{"type": "turn/end", "seq": 5, "time": 1210, "data": map[string]any{"turn": 0, "reason": map[string]any{"kind": "completed"}}},
		// Next turn with no changed header must still inherit the route model.
		{"type": "turn/start", "seq": 6, "time": 2000, "data": map[string]any{"turn": 1}},
		{"type": "assistant/chunk", "seq": 7, "time": 2005, "data": map[string]any{"turn": 1, "step": 0, "chunk": map[string]any{"type": "text-delta", "text": "b"}}},
		{"type": "assistant/chunk", "seq": 8, "time": 2105, "data": map[string]any{"turn": 1, "step": 0, "chunk": map[string]any{"type": "text-delta", "text": "b"}}},
		{"type": "assistant/message", "seq": 9, "time": 2300, "data": map[string]any{"turn": 1, "step": 0, "message": map[string]any{"content": []any{map[string]any{"type": "text", "text": "bb"}}}, "usage": map[string]any{"inputTokens": 6, "outputTokens": 60}}},
		{"type": "turn/end", "seq": 10, "time": 2310, "data": map[string]any{"turn": 1, "reason": map[string]any{"kind": "completed"}}},
	}
	out := bridgeRun(t, events)
	ends := findEventAll(out, "turn/end")
	if len(ends) != 2 {
		t.Fatalf("expected two turn/end, got %d", len(ends))
	}
	second := generationList(t, ends[1])
	if len(second) != 1 {
		t.Fatalf("second turn should have one generation, got %v", second)
	}
	if second[0]["model"] != "gpt-5" {
		t.Fatalf("inherited model missing: %v", second[0])
	}
}

func TestBridgeReasoningNeverText(t *testing.T) {
	events := []map[string]any{
		{"type": "request/header", "seq": 0, "time": 1000, "data": map[string]any{"header": map[string]any{"config": map[string]any{"model": "gpt-5"}}}},
		{"type": "turn/start", "seq": 1, "time": 1010, "data": map[string]any{"turn": 0}},
		{"type": "assistant/chunk", "seq": 2, "time": 1015, "data": map[string]any{"turn": 0, "step": 0, "chunk": map[string]any{"type": "reasoning-delta", "text": "secret reasoning"}}},
		{"type": "assistant/message", "seq": 3, "time": 1500, "data": map[string]any{"turn": 0, "step": 0, "message": map[string]any{"content": []any{map[string]any{"type": "reasoning", "text": "secret reasoning"}, map[string]any{"type": "text", "text": "visible"}}}, "usage": map[string]any{"inputTokens": 10, "outputTokens": 100}}},
		{"type": "turn/end", "seq": 4, "time": 1510, "data": map[string]any{"turn": 0, "reason": map[string]any{"kind": "completed"}}},
	}
	out := bridgeRun(t, events)
	if chunk := findEvent(out, "assistant/chunk"); chunk != nil {
		t.Fatalf("reasoning chunk must not surface as text: %v", chunk)
	}
	msg := findEvent(out, "assistant/message")
	if msg == nil || msg["text"] != "visible" {
		t.Fatalf("reasoning block leaked into final text: %v", msg)
	}
	end := findEvent(out, "turn/end")
	if generations := generationList(t, end); len(generations) != 0 {
		t.Fatalf("reasoning-only deltas must not forward generation content: %v", generations)
	}
	// Hidden reasoning must never appear anywhere in the bridge output.
	for _, event := range out {
		encoded, err := json.Marshal(event)
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(encoded), "secret reasoning") {
			t.Fatalf("hidden reasoning leaked into bridge output: %s", encoded)
		}
	}
}

func TestBridgeToolArgsOnlyDeltasAndEmptyMessage(t *testing.T) {
	events := []map[string]any{
		{"type": "request/header", "seq": 0, "time": 1000, "data": map[string]any{"header": map[string]any{"config": map[string]any{"model": "gpt-5"}}}},
		{"type": "turn/start", "seq": 1, "time": 1010, "data": map[string]any{"turn": 0}},
		{"type": "assistant/chunk", "seq": 2, "time": 1015, "data": map[string]any{"turn": 0, "step": 0, "chunk": map[string]any{"type": "tool-call-delta", "argumentsDelta": "{\"a\":"}}},
		// A name-only tool delta carries no arguments and must not count.
		{"type": "assistant/chunk", "seq": 3, "time": 1030, "data": map[string]any{"turn": 0, "step": 0, "chunk": map[string]any{"type": "tool-call-delta", "name": "Bash"}}},
		{"type": "assistant/chunk", "seq": 4, "time": 1115, "data": map[string]any{"turn": 0, "step": 0, "chunk": map[string]any{"type": "tool-call-delta", "argumentsDelta": "1}"}}},
		{"type": "assistant/message", "seq": 5, "time": 1500, "data": map[string]any{"turn": 0, "step": 0, "message": map[string]any{"content": []any{}}, "usage": map[string]any{"inputTokens": 10, "outputTokens": 100}}},
		{"type": "turn/end", "seq": 6, "time": 1510, "data": map[string]any{"turn": 0, "reason": map[string]any{"kind": "completed"}}},
	}
	out := bridgeRun(t, events)
	if msg := findEvent(out, "assistant/message"); msg != nil {
		t.Fatalf("empty final message must not emit a message event: %v", msg)
	}
	end := findEvent(out, "turn/end")
	generations := generationList(t, end)
	if len(generations) != 1 {
		t.Fatalf("tool-arguments stream must still forward a generation, got %v", generations)
	}
	blocks, ok := generations[0]["blocks"].(map[string]any)
	if !ok || blocks["tool"] != "{\"a\":1}" {
		t.Fatalf("argument fragments must concatenate per arguments stream: %v", generations[0]["blocks"])
	}
	if numValue(t, generations[0], "first_delta_at_ms") != 1015 || numValue(t, generations[0], "last_delta_at_ms") != 1115 {
		t.Fatalf("name-only delta must not open or extend the window: %v", generations[0])
	}
}

func TestBridgeDuplicateSeqIgnored(t *testing.T) {
	events := []map[string]any{
		{"type": "request/header", "seq": 0, "time": 1000, "data": map[string]any{"header": map[string]any{"config": map[string]any{"model": "gpt-5"}}}},
		{"type": "turn/start", "seq": 1, "time": 1010, "data": map[string]any{"turn": 0}},
		{"type": "assistant/chunk", "seq": 2, "time": 1015, "data": map[string]any{"turn": 0, "step": 0, "chunk": map[string]any{"type": "text-delta", "text": "a"}}},
		{"type": "assistant/chunk", "seq": 3, "time": 1115, "data": map[string]any{"turn": 0, "step": 0, "chunk": map[string]any{"type": "text-delta", "text": "b"}}},
		// Duplicate of seq 2 must be ignored entirely.
		{"type": "assistant/chunk", "seq": 2, "time": 1116, "data": map[string]any{"turn": 0, "step": 0, "chunk": map[string]any{"type": "text-delta", "text": "a"}}},
		{"type": "assistant/message", "seq": 4, "time": 1500, "data": map[string]any{"turn": 0, "step": 0, "message": map[string]any{"content": []any{map[string]any{"type": "text", "text": "ab"}}}, "usage": map[string]any{"inputTokens": 10, "outputTokens": 100}}},
		{"type": "turn/end", "seq": 5, "time": 1510, "data": map[string]any{"turn": 0, "reason": map[string]any{"kind": "completed"}}},
	}
	out := bridgeRun(t, events)
	if chunks := findEventAll(out, "assistant/chunk"); len(chunks) != 2 {
		t.Fatalf("duplicate seq must be ignored, got %d chunks", len(chunks))
	}
	end := findEvent(out, "turn/end")
	if usage := end["usage"].(map[string]any); numValue(t, usage, "output_tokens") != 100 {
		t.Fatalf("duplicate must not double count usage: %v", usage)
	}
	generations := generationList(t, end)
	if len(generations) != 1 {
		t.Fatalf("duplicate seq must not split or drop the generation: %v", generations)
	}
	blocks, ok := generations[0]["blocks"].(map[string]any)
	if !ok || blocks["text"] != "ab" {
		t.Fatalf("duplicate must not double accumulate generation content: %v", generations[0]["blocks"])
	}
	if numValue(t, generations[0], "last_delta_at_ms") != 1115 {
		t.Fatalf("duplicate timestamp must not extend the window: %v", generations[0])
	}
}

func TestBridgeMissingHeaderNoModelNoGeneration(t *testing.T) {
	events := []map[string]any{
		{"type": "turn/start", "seq": 0, "time": 1010, "data": map[string]any{"turn": 0}},
		{"type": "assistant/chunk", "seq": 1, "time": 1015, "data": map[string]any{"turn": 0, "step": 0, "chunk": map[string]any{"type": "text-delta", "text": "a"}}},
		{"type": "assistant/chunk", "seq": 2, "time": 1115, "data": map[string]any{"turn": 0, "step": 0, "chunk": map[string]any{"type": "text-delta", "text": "a"}}},
		{"type": "assistant/message", "seq": 3, "time": 1500, "data": map[string]any{"turn": 0, "step": 0, "message": map[string]any{"content": []any{map[string]any{"type": "text", "text": "ok"}}}, "usage": map[string]any{"inputTokens": 10, "outputTokens": 100}}},
		{"type": "turn/end", "seq": 4, "time": 1510, "data": map[string]any{"turn": 0, "reason": map[string]any{"kind": "completed"}}},
	}
	out := bridgeRun(t, events)
	end := findEvent(out, "turn/end")
	if generations := generationList(t, end); len(generations) != 0 {
		t.Fatalf("a response without model evidence must not be forwarded, got %v", generations)
	}
}

func TestBridgeMissingUsageStillForwardsGeneration(t *testing.T) {
	events := []map[string]any{
		{"type": "request/header", "seq": 0, "time": 1000, "data": map[string]any{"header": map[string]any{"config": map[string]any{"model": "gpt-5"}}}},
		{"type": "turn/start", "seq": 1, "time": 1010, "data": map[string]any{"turn": 0}},
		{"type": "assistant/chunk", "seq": 2, "time": 1015, "data": map[string]any{"turn": 0, "step": 0, "chunk": map[string]any{"type": "text-delta", "text": "a"}}},
		{"type": "assistant/chunk", "seq": 3, "time": 1115, "data": map[string]any{"turn": 0, "step": 0, "chunk": map[string]any{"type": "text-delta", "text": "a"}}},
		{"type": "assistant/message", "seq": 4, "time": 1500, "data": map[string]any{"turn": 0, "step": 0, "message": map[string]any{"content": []any{map[string]any{"type": "text", "text": "aa"}}}}},
		{"type": "turn/end", "seq": 5, "time": 1510, "data": map[string]any{"turn": 0, "reason": map[string]any{"kind": "completed"}}},
	}
	out := bridgeRun(t, events)
	end := findEvent(out, "turn/end")
	// Approximate speed no longer depends on billing usage partitions.
	if generations := generationList(t, end); len(generations) != 1 {
		t.Fatalf("missing usage must not suppress the generation, got %v", generations)
	}
	if _, ok := end["usage"]; ok {
		t.Fatalf("missing usage must not be fabricated: %v", end)
	}
}

func TestBridgeInterruptedMessageNotSampled(t *testing.T) {
	events := []map[string]any{
		{"type": "request/header", "seq": 0, "time": 1000, "data": map[string]any{"header": map[string]any{"config": map[string]any{"model": "gpt-5"}}}},
		{"type": "turn/start", "seq": 1, "time": 1010, "data": map[string]any{"turn": 0}},
		{"type": "assistant/chunk", "seq": 2, "time": 1015, "data": map[string]any{"turn": 0, "step": 0, "chunk": map[string]any{"type": "text-delta", "text": "a"}}},
		{"type": "assistant/message", "seq": 3, "time": 1500, "data": map[string]any{"turn": 0, "step": 0, "interrupted": true, "message": map[string]any{"content": []any{map[string]any{"type": "text", "text": "partial"}}}, "usage": map[string]any{"inputTokens": 10, "outputTokens": 100}}},
		{"type": "turn/end", "seq": 4, "time": 1510, "data": map[string]any{"turn": 0, "reason": map[string]any{"kind": "completed"}}},
	}
	out := bridgeRun(t, events)
	if msg := findEvent(out, "assistant/message"); msg != nil {
		t.Fatalf("interrupted message must not be sampled or surfaced: %v", msg)
	}
	end := findEvent(out, "turn/end")
	if generations := generationList(t, end); len(generations) != 0 {
		t.Fatalf("interrupted message must not forward a generation, got %v", generations)
	}
}

func TestBridgeAbortedTurnNotSuccess(t *testing.T) {
	for _, kind := range []string{"aborted", "error", "blocked", "interrupted", "max-tokens"} {
		events := []map[string]any{
			{"type": "request/header", "seq": 0, "time": 1000, "data": map[string]any{"header": map[string]any{"config": map[string]any{"model": "gpt-5"}}}},
			{"type": "turn/start", "seq": 1, "time": 1010, "data": map[string]any{"turn": 0}},
			{"type": "assistant/chunk", "seq": 2, "time": 1015, "data": map[string]any{"turn": 0, "step": 0, "chunk": map[string]any{"type": "text-delta", "text": "a"}}},
			{"type": "assistant/message", "seq": 3, "time": 1500, "data": map[string]any{"turn": 0, "step": 0, "message": map[string]any{"content": []any{map[string]any{"type": "text", "text": "a"}}}, "usage": map[string]any{"inputTokens": 10, "outputTokens": 100}}},
			{"type": "turn/end", "seq": 4, "time": 1510, "data": map[string]any{"turn": 0, "reason": map[string]any{"kind": kind}}},
		}
		out := bridgeRun(t, events)
		end := findEvent(out, "turn/end")
		if end["status"] != "failed" {
			t.Fatalf("reason %q must be failed, got %v", kind, end["status"])
		}
		if generations := generationList(t, end); len(generations) != 0 {
			t.Fatalf("reason %q must not forward generations, got %v", kind, generations)
		}
	}
}

func TestBridgeChildIgnored(t *testing.T) {
	events := []map[string]any{
		{"type": "request/header", "seq": 0, "time": 1000, "data": map[string]any{"header": map[string]any{"config": map[string]any{"model": "gpt-5"}}}},
		{"type": "turn/start", "seq": 1, "time": 1010, "data": map[string]any{"turn": 0}},
	}
	// A child session event must be ignored by the root-only bridge.
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node not available")
	}
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "forge-dsh-bridge.mjs"), []byte(PluginSource), 0o600); err != nil {
		t.Fatalf("write plugin: %v", err)
	}
	eventsJSON, _ := json.Marshal(events)
	if err := os.WriteFile(filepath.Join(dir, "events.json"), eventsJSON, 0o600); err != nil {
		t.Fatalf("write events: %v", err)
	}
	harness := `import { apply } from './forge-dsh-bridge.mjs';
import { readFileSync } from 'node:fs';
const events = JSON.parse(readFileSync(process.argv[2], 'utf8'));
let handler = null;
const ctx = { on: (name, fn) => { if (name === 'session/event') handler = fn; } };
apply(ctx);
const child = { id: 'child', header: { origin: 'subagent' } };
for (const e of events) handler(child, e);
`
	if err := os.WriteFile(filepath.Join(dir, "harness.mjs"), []byte(harness), 0o600); err != nil {
		t.Fatalf("write harness: %v", err)
	}
	cmd := exec.CommandContext(context.Background(), node, "harness.mjs", filepath.Join(dir, "events.json"))
	cmd.Dir = dir
	var stdout bytes.Buffer
	cmd.Stdout = &stdout
	if err := cmd.Run(); err != nil {
		t.Fatalf("node harness: %v", err)
	}
	if strings.TrimSpace(stdout.String()) != "" {
		t.Fatalf("child session must be ignored, got %q", stdout.String())
	}
}

func TestBridgeModelSwitchInvalidatesSample(t *testing.T) {
	events := []map[string]any{
		{"type": "request/header", "seq": 0, "time": 1000, "data": map[string]any{"header": map[string]any{"config": map[string]any{"model": "gpt-5"}}}},
		{"type": "turn/start", "seq": 1, "time": 1010, "data": map[string]any{"turn": 0}},
		{"type": "assistant/chunk", "seq": 2, "time": 1015, "data": map[string]any{"turn": 0, "step": 0, "chunk": map[string]any{"type": "text-delta", "text": "a"}}},
		// Model changes mid-response; the streamed response must be invalidated.
		{"type": "request/context", "seq": 3, "time": 1016, "data": map[string]any{"model": "gpt-6"}},
		{"type": "assistant/message", "seq": 4, "time": 1500, "data": map[string]any{"turn": 0, "step": 0, "message": map[string]any{"content": []any{map[string]any{"type": "text", "text": "a"}}}, "usage": map[string]any{"inputTokens": 10, "outputTokens": 100}}},
		{"type": "turn/end", "seq": 5, "time": 1510, "data": map[string]any{"turn": 0, "reason": map[string]any{"kind": "completed"}}},
	}
	out := bridgeRun(t, events)
	end := findEvent(out, "turn/end")
	if generations := generationList(t, end); len(generations) != 0 {
		t.Fatalf("mid-stream model switch must invalidate the generation, got %v", generations)
	}
}

func TestBridgeBufferedWindowSkippedAlone(t *testing.T) {
	events := []map[string]any{
		{"type": "request/header", "seq": 0, "time": 1000, "data": map[string]any{"header": map[string]any{"config": map[string]any{"model": "gpt-5"}}}},
		{"type": "turn/start", "seq": 1, "time": 1010, "data": map[string]any{"turn": 0}},
		// Step 0 arrives buffered: every delta shares one timestamp, so the
		// window is unobservable and must be skipped...
		{"type": "assistant/chunk", "seq": 2, "time": 1015, "data": map[string]any{"turn": 0, "step": 0, "chunk": map[string]any{"type": "text-delta", "text": "buf"}}},
		{"type": "assistant/chunk", "seq": 3, "time": 1015, "data": map[string]any{"turn": 0, "step": 0, "chunk": map[string]any{"type": "text-delta", "text": "fered"}}},
		{"type": "assistant/message", "seq": 4, "time": 1016, "data": map[string]any{"turn": 0, "step": 0, "message": map[string]any{"content": []any{map[string]any{"type": "text", "text": "buffered"}}}, "usage": map[string]any{"inputTokens": 4, "outputTokens": 40}}},
		// ...without poisoning step 1's complete valid window.
		{"type": "assistant/chunk", "seq": 5, "time": 2000, "data": map[string]any{"turn": 0, "step": 1, "chunk": map[string]any{"type": "text-delta", "text": "val"}}},
		{"type": "assistant/chunk", "seq": 6, "time": 2100, "data": map[string]any{"turn": 0, "step": 1, "chunk": map[string]any{"type": "text-delta", "text": "id"}}},
		{"type": "assistant/message", "seq": 7, "time": 2200, "data": map[string]any{"turn": 0, "step": 1, "message": map[string]any{"content": []any{map[string]any{"type": "text", "text": "valid"}}}, "usage": map[string]any{"inputTokens": 6, "outputTokens": 60}}},
		{"type": "turn/end", "seq": 8, "time": 2210, "data": map[string]any{"turn": 0, "reason": map[string]any{"kind": "completed"}}},
	}
	out := bridgeRun(t, events)
	end := findEvent(out, "turn/end")
	generations := generationList(t, end)
	if len(generations) != 1 {
		t.Fatalf("only the observable window must be forwarded, got %v", generations)
	}
	blocks, ok := generations[0]["blocks"].(map[string]any)
	if !ok || blocks["text"] != "valid" {
		t.Fatalf("unexpected generation content: %v", generations[0])
	}
	if numValue(t, generations[0], "first_delta_at_ms") != 2000 || numValue(t, generations[0], "last_delta_at_ms") != 2100 {
		t.Fatalf("valid window timestamps wrong: %v", generations[0])
	}
	usage := end["usage"].(map[string]any)
	if numValue(t, usage, "input_tokens") != 10 || numValue(t, usage, "output_tokens") != 100 {
		t.Fatalf("skipped window must not change billing: %v", usage)
	}
}
