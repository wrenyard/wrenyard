package driver

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/protocol"
)

// Codex app-server transport tests.
//
// The notification tests drive handleNotification directly and always pair it
// with codexNormalizer, so the assertion is on the FINAL normalized event a
// consumer sees rather than on the intermediate exec-shaped record. Timing is
// injected through the sampler's clock, so no test depends on wall time or on
// two events landing in the same millisecond. The one RPC test uses a real
// net.Pipe connection, which exercises the same reader/dispatcher production
// uses instead of an in-memory peer stand-in.

// --- deterministic clock ---------------------------------------------------

// clockRef is the sampler clock shared with the bridge under test.
type clockRef struct{ at time.Time }

func (c *clockRef) advance(d time.Duration) { c.at = c.at.Add(d) }

// newHandlerBridge builds a bridge wired for pure notification handling: no
// process, no RPC connection, a deterministic clock, and a captured output
// buffer. thread and turn identity are pre-resolved exactly as run() resolves
// them from the thread/start and turn/start responses.
func newHandlerBridge(t *testing.T, threadID, turnID, model string) (*codexAppServerBridge, *clockRef, *bytes.Buffer) {
	t.Helper()
	clock := &clockRef{at: time.UnixMilli(1_700_000_000_000)}
	bridge := newCodexAppServerBridge(codexAppServerAuth{}, codexAppServerInvocation{Model: model})
	bridge.sampler = newResponseTPSSampler(func() time.Time { return clock.at })
	buffer := &bytes.Buffer{}
	bridge.output = buffer
	bridge.threadID = threadID
	bridge.turnID = turnID
	bridge.model = model
	return bridge, clock, buffer
}

func mustParams(t *testing.T, params map[string]any) json.RawMessage {
	t.Helper()
	body, err := json.Marshal(params)
	if err != nil {
		t.Fatalf("marshal notification params: %v", err)
	}
	return body
}

// notify dispatches one native notification through handleNotification.
func notify(t *testing.T, bridge *codexAppServerBridge, method string, params map[string]any) {
	t.Helper()
	bridge.handleNotification(codexAppServerMessage{Method: method, Params: mustParams(t, params)})
}

// --- record accessors ------------------------------------------------------

func bridgeRecords(t *testing.T, buffer *bytes.Buffer) []map[string]any {
	t.Helper()
	var records []map[string]any
	for _, line := range bytes.Split(bytes.TrimSpace(buffer.Bytes()), []byte("\n")) {
		if len(bytes.TrimSpace(line)) == 0 {
			continue
		}
		var record map[string]any
		if err := json.Unmarshal(line, &record); err != nil {
			t.Fatalf("decode record %q: %v", line, err)
		}
		records = append(records, record)
	}
	return records
}

func lastRecordOfType(t *testing.T, buffer *bytes.Buffer, typ string) map[string]any {
	t.Helper()
	var found map[string]any
	for _, record := range bridgeRecords(t, buffer) {
		if record["type"] == typ {
			found = record
		}
	}
	if found == nil {
		t.Fatalf("no %s record in %s", typ, buffer.String())
	}
	return found
}

func recordCount(buffer *bytes.Buffer, typ string) int {
	count := 0
	for _, line := range bytes.Split(bytes.TrimSpace(buffer.Bytes()), []byte("\n")) {
		var record map[string]any
		if json.Unmarshal(line, &record) == nil && record["type"] == typ {
			count++
		}
	}
	return count
}

// normalizedEvents runs every record through codexNormalizer, so a test asserts
// the events a consumer actually receives. It deliberately does not go through
// TPS post-processing, which would strip the trusted agent_turn_v1 claim.
func normalizedEvents(t *testing.T, buffer *bytes.Buffer) []protocol.Event {
	t.Helper()
	var events []protocol.Event
	for _, line := range bytes.Split(bytes.TrimSpace(buffer.Bytes()), []byte("\n")) {
		if len(bytes.TrimSpace(line)) == 0 {
			continue
		}
		events = append(events, codexNormalizer(line)...)
	}
	return events
}

func onlyEventOfType(t *testing.T, events []protocol.Event, typ string) protocol.Event {
	t.Helper()
	var found []protocol.Event
	for _, event := range events {
		if event.Type == typ {
			found = append(found, event)
		}
	}
	if len(found) != 1 {
		t.Fatalf("want exactly one %s event, got %v", typ, found)
	}
	return found[0]
}

func tpsSamples(t *testing.T, record map[string]any) []map[string]any {
	t.Helper()
	raw, present := record["tps_samples"]
	if !present {
		return nil
	}
	list, ok := raw.([]any)
	if !ok {
		t.Fatalf("tps_samples is not a list: %v", raw)
	}
	samples := make([]map[string]any, 0, len(list))
	for _, entry := range list {
		sample, ok := entry.(map[string]any)
		if !ok {
			t.Fatalf("tps sample is not an object: %v", entry)
		}
		samples = append(samples, sample)
	}
	return samples
}

// num reads a decoded JSON number. The bridge writes records through
// json.Marshal and the tests decode them back, so every number is a float64
// again; this helper keeps the assertions readable and type-agnostic.
func num(t *testing.T, value any) float64 {
	t.Helper()
	number, ok := value.(float64)
	if !ok {
		t.Fatalf("value %v (%T) is not a decoded JSON number", value, value)
	}
	return number
}

// wantNum asserts one numeric field of a decoded JSON object.
func wantNum(t *testing.T, label string, source map[string]any, key string, want float64) {
	t.Helper()
	if got := num(t, source[key]); got != want {
		t.Fatalf("%s %s = %v, want %v (record %v)", label, key, got, want, source)
	}
}

// --- fixture builders ------------------------------------------------------

func agentDeltaParams(threadID, turnID, text string) map[string]any {
	return map[string]any{"threadId": threadID, "turnId": turnID, "itemId": "item-1", "delta": text}
}

func reasoningDeltaParams(threadID, turnID, text string) map[string]any {
	return map[string]any{
		"threadId": threadID, "turnId": turnID, "itemId": "reason-1", "summaryIndex": 0, "delta": text,
	}
}

func turnStartedParams(threadID, turnID string) map[string]any {
	return map[string]any{
		"threadId": threadID,
		"turn":     map[string]any{"id": turnID, "status": "inProgress", "items": []any{}},
	}
}

// rawCompletedParams carries the exact usage breakdown of one upstream
// response, matching the native rawResponse/completed payload.
func rawCompletedParams(threadID, turnID, responseID string, input, output, cached int) map[string]any {
	params := map[string]any{
		"threadId": threadID, "turnId": turnID, "responseId": responseID,
	}
	if responseID != "" {
		params["usage"] = map[string]any{
			"inputTokens": input, "outputTokens": output,
			"cachedInputTokens": cached, "reasoningOutputTokens": 0,
			"totalTokens": input + output,
		}
	}
	return params
}

// turnCompletedParams builds turn/completed. The native notification carries
// only the turn: any usage was accumulated from rawResponse/completed.
func turnCompletedParams(threadID, turnID, status string, durationMS int) map[string]any {
	return map[string]any{
		"threadId": threadID,
		"turn": map[string]any{
			"id": turnID, "status": status, "durationMs": durationMS, "items": []any{},
		},
	}
}

// --- argument and environment contracts ------------------------------------

// TestCodexAppServerArgParsingKeepsConfigBeforeSubcommand verifies the internal
// argv contract: config overrides precede the app-server subcommand, a trailing
// stdin marker is tolerated, --search becomes a config override, and `exec`
// never appears.
func TestCodexAppServerArgParsingKeepsConfigBeforeSubcommand(t *testing.T) {
	inv, err := parseCodexAppServerArgs([]string{
		"--search", "--strict-config",
		"-c", "approval_policy=never",
		"-c", `model_reasoning_effort="high"`,
		"--model", "gpt-5.1-codex",
		"--sandbox", "workspace-write",
		"--output-last-message", "/tmp/last.txt",
		"-c", "k=v",
		"-",
	})
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if inv.Model != "gpt-5.1-codex" || inv.Sandbox != "workspace-write" {
		t.Fatalf("unexpected invocation: %+v", inv)
	}
	if inv.ReasoningEffort != "high" {
		t.Fatalf("ReasoningEffort = %q, want high", inv.ReasoningEffort)
	}
	if inv.AuthEnabled {
		t.Fatal("argv parsing must not infer native auth from the invocation alone")
	}

	// The child argv selects the stdio transport with --stdio, never --listen,
	// and never carries --model.
	authInv := inv
	authInv.AuthEnabled = true
	argv := codexAppServerCommandArgs(authInv)
	for _, arg := range argv {
		if arg == "exec" {
			t.Fatal("transport argv must never contain exec")
		}
		if arg == "--listen" || arg == "--model" {
			t.Fatalf("argv must not use %q: %v", arg, argv)
		}
	}
	if len(argv) < 2 || argv[len(argv)-2] != "app-server" || argv[len(argv)-1] != "--stdio" {
		t.Fatalf("argv must end with `app-server --stdio`, got %v", argv)
	}
	subIdx := indexOfArg(argv, "app-server")
	for _, override := range []string{
		`web_search="live"`, `approval_policy="never"`, `sandbox_mode="workspace-write"`,
		`cli_auth_credentials_store="ephemeral"`,
	} {
		idx := indexOfArg(argv, override)
		if idx < 0 {
			t.Fatalf("argv must carry %s: %v", override, argv)
		}
		if idx > subIdx {
			t.Fatalf("%s must precede the app-server subcommand: %v", override, argv)
		}
	}
	// A Gateway-routed run never injects the credential store override.
	if indexOfArg(codexAppServerCommandArgs(inv), `cli_auth_credentials_store="ephemeral"`) >= 0 {
		t.Fatalf("non-native argv must not select a credential store")
	}
}

func indexOfArg(args []string, target string) int {
	for index, arg := range args {
		if arg == target {
			return index
		}
	}
	return -1
}

// TestCodexAppServerEnvIsolatesCredentialStore verifies the child environment
// points CODEX_HOME at the isolated home with an ephemeral credential store and
// clears the API-key variables.
func TestCodexAppServerEnvIsolatesCredentialStore(t *testing.T) {
	isolated := t.TempDir()
	t.Setenv("CODEX_API_KEY", "leaked-key")
	t.Setenv("OPENAI_API_KEY", "leaked-key")

	auth := resolveCodexAppServerAuth(codexAppServerInvocation{})
	if !auth.Enabled {
		t.Fatalf("a native provider must resolve native auth: %+v", auth)
	}
	values := envValues(codexAppServerEnv(auth, isolated))
	if values["CODEX_HOME"] != isolated {
		t.Fatalf("child CODEX_HOME = %q, want the isolated home", values["CODEX_HOME"])
	}
	if indexOfArg(codexAppServerCommandArgs(codexAppServerInvocation{AuthEnabled: auth.Enabled}), `cli_auth_credentials_store="ephemeral"`) < 0 {
		t.Fatal("native child must configure the ephemeral credential store")
	}
	if values["CODEX_API_KEY"] != "" || values["OPENAI_API_KEY"] != "" {
		t.Fatalf("API-key variables must be cleared: %v", values)
	}

	// A Gateway-routed provider must not inject native auth at all.
	gateway := resolveCodexAppServerAuth(codexAppServerInvocation{RawConfig: []string{`model_provider="wrenyard"`}})
	if gateway.Enabled {
		t.Fatalf("provider override must skip native auth: %+v", gateway)
	}
	for _, entry := range codexAppServerEnv(gateway, isolated) {
		if strings.HasPrefix(entry, "cli_auth_credentials_store=") {
			t.Fatalf("provider override must not set a credential store")
		}
	}
}

func envValues(env []string) map[string]string {
	values := map[string]string{}
	for _, entry := range env {
		key, value, _ := strings.Cut(entry, "=")
		values[key] = value
	}
	return values
}

// TestCodexAppServerLastMessageKeepsFinalAgentText verifies output-last-message
// receives only the final agent message, never a reasoning delta.
func TestCodexAppServerLastMessageKeepsFinalAgentText(t *testing.T) {
	path := t.TempDir() + "/nested/last.txt"
	bridge, _, _ := newHandlerBridge(t, "thread-last", "turn-l", "gpt-5.1-codex")
	bridge.inv.OutputLastMessage = path

	notify(t, bridge, "item/agentMessage/delta", agentDeltaParams("thread-last", "turn-l", "first draft"))
	notify(t, bridge, "item/completed", map[string]any{
		"threadId": "thread-last", "turnId": "turn-l",
		"item": map[string]any{"id": "msg-1", "type": "agentMessage", "text": "first draft"},
	})
	notify(t, bridge, "item/completed", map[string]any{
		"threadId": "thread-last", "turnId": "turn-l",
		"item": map[string]any{"id": "msg-2", "type": "agentMessage", "text": "final answer"},
	})
	notify(t, bridge, "rawResponse/completed", rawCompletedParams("thread-last", "turn-l", "resp-l", 30, 6, 0))
	notify(t, bridge, "turn/completed", turnCompletedParams("thread-last", "turn-l", "completed", 900))

	bridge.writeLastMessage()
	if bridge.lastAgentMessage != "final answer" {
		t.Fatalf("last agent message = %q, want the final agentMessage text", bridge.lastAgentMessage)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read output-last-message: %v", err)
	}
	if string(data) != "final answer" {
		t.Fatalf("output-last-message = %q, want the final agent message only", string(data))
	}
}

// --- notification translation through codexNormalizer -----------------------

// TestCodexAppServerTextReasoningAndUsageNormalized verifies the happy path end
// to end: an agent message becomes a normalized assistant message, a reasoning
// delta opens the sampling window without ever becoming content, and the turn's
// usage is the SUM of the raw response completions with no native turn usage.
func TestCodexAppServerTextReasoningAndUsageNormalized(t *testing.T) {
	bridge, clock, buffer := newHandlerBridge(t, "thread-happy", "turn-h", "gpt-5.1-codex")

	notify(t, bridge, "thread/started", map[string]any{
		"thread": map[string]any{"id": "thread-happy", "modelProvider": "openai"},
	})
	notify(t, bridge, "turn/started", turnStartedParams("thread-happy", "turn-h"))
	clock.advance(10 * time.Millisecond)
	notify(t, bridge, "item/reasoning/summaryTextDelta",
		reasoningDeltaParams("thread-happy", "turn-h", "thinking about it"))
	clock.advance(40 * time.Millisecond)
	notify(t, bridge, "rawResponse/completed", rawCompletedParams("thread-happy", "turn-h", "resp-1", 90, 12, 4))
	notify(t, bridge, "item/completed", map[string]any{
		"threadId": "thread-happy", "turnId": "turn-h",
		"item": map[string]any{"id": "msg-1", "type": "agentMessage", "text": "the answer"},
	})
	notify(t, bridge, "turn/completed", turnCompletedParams("thread-happy", "turn-h", "completed", 1500))

	completed := lastRecordOfType(t, buffer, "turn.completed")
	// The usage is nested and summed from the response completions, because the
	// native turn/completed carries none.
	usage, _ := completed["usage"].(map[string]any)
	if usage == nil {
		t.Fatalf("turn.completed must carry nested usage: %v", completed)
	}
	wantNum(t, "turn.completed usage", usage, "input_tokens", 90)
	wantNum(t, "turn.completed usage", usage, "output_tokens", 12)
	wantNum(t, "turn.completed usage", usage, "cached_input_tokens", 4)
	if _, rootLevel := completed["input_tokens"]; rootLevel {
		t.Fatalf("usage must be nested, not at the record root: %v", completed)
	}
	wantNum(t, "turn.completed", completed, "duration_ms", 1500)
	if completed["tps_sampling_contract"] != responseTPSSamplingContract {
		t.Fatalf("missing paired TPS contract: %v", completed)
	}
	samples := tpsSamples(t, completed)
	if len(samples) != 1 {
		t.Fatalf("want exactly one TPS sample, got %v", samples)
	}
	if samples[0]["response_id"] != "resp-1" {
		t.Fatalf("unexpected TPS sample: %v", samples[0])
	}
	wantNum(t, "TPS sample", samples[0], "output_tokens", 12)
	if samples[0]["model"] != "gpt-5.1-codex" {
		t.Fatalf("sample model must be the resolved model: %v", samples[0])
	}
	if duration := num(t, samples[0]["completed_at_ms"]) - num(t, samples[0]["first_token_at_ms"]); duration != 40 {
		t.Fatalf("window = %vms, want the 40ms the injected clock advanced: %v", duration, samples[0])
	}

	// The FINAL normalized events are what a consumer sees.
	events := normalizedEvents(t, buffer)
	message := onlyEventOfType(t, events, "message")
	if message.Data["text"] != "the answer" || message.Data["role"] != "assistant" {
		t.Fatalf("normalized message wrong: %v", message.Data)
	}
	usageEvent := onlyEventOfType(t, events, "turn_usage")
	if usageEvent.Data["input_tokens"] != 90 || usageEvent.Data["output_tokens"] != 12 {
		t.Fatalf("normalized usage wrong: %v", usageEvent.Data)
	}
	if usageEvent.Data["cached_input_tokens"] != 4 {
		t.Fatalf("normalized cached usage wrong: %v", usageEvent.Data)
	}
	// A reasoning delta is timing evidence only: it must never surface as text.
	for _, event := range events {
		if text, ok := event.Data["text"].(string); ok && strings.Contains(text, "thinking about it") {
			t.Fatalf("reasoning text must not become normalized content: %v", event)
		}
	}
}

// TestCodexAppServerCommandMcpAndFileItemsNormalized verifies the native
// camelCase item types and payload fields translate into the exec schema far
// enough for codexNormalizer to produce tool_call/tool_result pairs, including
// the atomic file_change pair.
func TestCodexAppServerCommandMcpAndFileItemsNormalized(t *testing.T) {
	bridge, _, buffer := newHandlerBridge(t, "thread-items", "turn-i", "gpt-5.1-codex")

	// A command execution: started emits a tool_call, completed a tool_result
	// whose status comes from exitCode.
	notify(t, bridge, "item/started", map[string]any{
		"threadId": "thread-items", "turnId": "turn-i",
		"item": map[string]any{"id": "cmd-1", "type": "commandExecution", "command": "ls -la", "status": "inProgress"},
	})
	notify(t, bridge, "item/completed", map[string]any{
		"threadId": "thread-items", "turnId": "turn-i",
		"item": map[string]any{
			"id": "cmd-1", "type": "commandExecution", "command": "ls -la",
			"aggregatedOutput": "total 0", "exitCode": 0, "status": "completed",
		},
	})
	// An MCP tool call: its started boundary yields the tool_call and its
	// completion yields the tool_result.
	notify(t, bridge, "item/started", map[string]any{
		"threadId": "thread-items", "turnId": "turn-i",
		"item": map[string]any{
			"id": "mcp-1", "type": "mcpToolCall", "server": "local", "tool": "search",
			"status": "inProgress",
		},
	})
	notify(t, bridge, "item/completed", map[string]any{
		"threadId": "thread-items", "turnId": "turn-i",
		"item": map[string]any{
			"id": "mcp-1", "type": "mcpToolCall", "server": "local", "tool": "search",
			"arguments": map[string]any{"q": "go"}, "result": "ok", "status": "completed",
		},
	})
	// A file change is atomic: one completed item yields a paired call/result.
	notify(t, bridge, "item/completed", map[string]any{
		"threadId": "thread-items", "turnId": "turn-i",
		"item": map[string]any{
			"id": "file-1", "type": "fileChange", "status": "completed",
			"changes": []any{map[string]any{"path": "main.go"}},
		},
	})
	// A failed command maps to an error tool_result.
	notify(t, bridge, "item/completed", map[string]any{
		"threadId": "thread-items", "turnId": "turn-i",
		"item": map[string]any{
			"id": "cmd-2", "type": "commandExecution", "command": "false",
			"aggregatedOutput": "boom", "exitCode": 1, "status": "failed",
		},
	})

	events := normalizedEvents(t, buffer)
	var calls, results []protocol.Event
	for _, event := range events {
		switch event.Type {
		case "tool_call":
			calls = append(calls, event)
		case "tool_result":
			results = append(results, event)
		}
	}
	// cmd-1 (started), mcp-1 (started), file-1 (atomic pair) = 3 calls; cmd-2
	// only completes, so it contributes a result but no call.
	if len(calls) != 3 {
		t.Fatalf("want 3 normalized tool_calls, got %d: %v", len(calls), calls)
	}
	if calls[0].Data["name"] != "ls" || calls[0].Data["call_id"] != "cmd-1" {
		t.Fatalf("command tool_call wrong: %v", calls[0].Data)
	}
	// The mcp tool_call is named after the native tool, not the item type.
	var mcpCallFound bool
	for _, call := range calls {
		if call.Data["call_id"] == "mcp-1" {
			mcpCallFound = true
			if call.Data["name"] != "search" {
				t.Fatalf("mcp tool_call name = %v, want search", call.Data["name"])
			}
		}
	}
	if !mcpCallFound {
		t.Fatalf("the mcpToolCall item must normalize to a tool_call: %v", calls)
	}

	byCall := map[string]protocol.Event{}
	for _, result := range results {
		id, _ := result.Data["call_id"].(string)
		byCall[id] = result
	}
	if len(results) != 4 {
		t.Fatalf("want 4 normalized tool_results, got %d: %v", len(results), results)
	}
	if byCall["cmd-1"].Data["status"] != "ok" || byCall["cmd-1"].Data["output_tail"] != "total 0" {
		t.Fatalf("command tool_result wrong: %v", byCall["cmd-1"].Data)
	}
	if byCall["cmd-2"].Data["status"] != "error" {
		t.Fatalf("a nonzero exitCode must be an error result: %v", byCall["cmd-2"].Data)
	}
	if _, ok := byCall["file-1"]; !ok {
		t.Fatalf("fileChange must normalize to a tool_result: %v", results)
	}
	// item.started is emitted only for in-flight tool calls, so the command and
	// mcp items have a started record and the atomic items do not.
	if recordCount(buffer, "item.started") != 2 {
		t.Fatalf("want exactly two item.started records, got %d", recordCount(buffer, "item.started"))
	}
}

// TestCodexAppServerToolOnlyCompletionOmittedFromSamples verifies a response
// with no delta still contributes its usage but produces no sampling window, so
// a tool gap between two text responses stays measurable. Both real reasoning
// delta method names are recognized as first-delta evidence.
func TestCodexAppServerToolOnlyCompletionOmittedFromSamples(t *testing.T) {
	bridge, clock, buffer := newHandlerBridge(t, "thread-gap", "turn-g", "gpt-5.1-codex")

	// First response: reasoning evidence then text, then its completion. A
	// second reasoning delta must not restart the window.
	clock.advance(10 * time.Millisecond)
	notify(t, bridge, "item/reasoning/summaryTextDelta",
		reasoningDeltaParams("thread-gap", "turn-g", "thinking"))
	clock.advance(5 * time.Millisecond)
	notify(t, bridge, "item/reasoning/textDelta", reasoningDeltaParams("thread-gap", "turn-g", "more"))
	clock.advance(15 * time.Millisecond)
	notify(t, bridge, "rawResponse/completed", rawCompletedParams("thread-gap", "turn-g", "resp-a", 10, 5, 0))

	// A tool-only response: no delta, but its usage belongs to the turn.
	clock.advance(30 * time.Millisecond)
	notify(t, bridge, "item/completed", map[string]any{
		"threadId": "thread-gap", "turnId": "turn-g",
		"item": map[string]any{
			"id": "cmd-1", "type": "commandExecution", "command": "pwd",
			"aggregatedOutput": "/tmp", "exitCode": 0, "status": "completed",
		},
	})
	clock.advance(10 * time.Millisecond)
	notify(t, bridge, "rawResponse/completed", rawCompletedParams("thread-gap", "turn-g", "resp-tool", 20, 7, 0))

	// Second response: its own delta opens a fresh window after the tool gap.
	clock.advance(20 * time.Millisecond)
	notify(t, bridge, "item/agentMessage/delta", agentDeltaParams("thread-gap", "turn-g", "second"))
	clock.advance(15 * time.Millisecond)
	notify(t, bridge, "rawResponse/completed", rawCompletedParams("thread-gap", "turn-g", "resp-b", 30, 9, 0))

	notify(t, bridge, "turn/completed", turnCompletedParams("thread-gap", "turn-g", "completed", 2200))

	completed := lastRecordOfType(t, buffer, "turn.completed")
	usage, _ := completed["usage"].(map[string]any)
	wantNum(t, "summed usage", usage, "input_tokens", 60)
	wantNum(t, "summed usage", usage, "output_tokens", 21)
	samples := tpsSamples(t, completed)
	if len(samples) != 2 {
		t.Fatalf("the tool-only response must produce no sample: %v", samples)
	}
	ids := map[string]bool{samples[0]["response_id"].(string): true, samples[1]["response_id"].(string): true}
	if !ids["resp-a"] || !ids["resp-b"] || ids["resp-tool"] {
		t.Fatalf("samples must be the two text responses only: %v", samples)
	}
	// The first window spans from the FIRST reasoning delta, not the repeat.
	wantNum(t, "first sample", samples[0], "first_token_at_ms", 1_700_000_000_010)
	wantNum(t, "first sample", samples[0], "completed_at_ms", 1_700_000_000_030)
	usageEvent := onlyEventOfType(t, normalizedEvents(t, buffer), "turn_usage")
	if usageEvent.Data["output_tokens"] != 21 {
		t.Fatalf("normalized usage must carry the tool-only response: %v", usageEvent.Data)
	}
}

// TestCodexAppServerWindowResetRules verifies the per-response window rules: an
// empty delta never opens one, a completion with no id closes one, a present
// but unusable usage contributes nothing and closes one, and a turn whose
// responses carried no usage reports no usage at all rather than zeroes.
func TestCodexAppServerWindowResetRules(t *testing.T) {
	// An empty delta is not first-token evidence, so the
	// usable usage that follows still produces no sample.
	empty, emptyClock, emptyBuffer := newHandlerBridge(t, "thread-empty", "turn-e", "gpt-5.1-codex")
	emptyClock.advance(10 * time.Millisecond)
	notify(t, empty, "item/agentMessage/delta", agentDeltaParams("thread-empty", "turn-e", ""))
	emptyClock.advance(40 * time.Millisecond)
	notify(t, empty, "rawResponse/completed", rawCompletedParams("thread-empty", "turn-e", "resp-empty", 40, 8, 0))
	notify(t, empty, "turn/completed", turnCompletedParams("thread-empty", "turn-e", "completed", 700))

	emptyCompleted := lastRecordOfType(t, emptyBuffer, "turn.completed")
	if samples := tpsSamples(t, emptyCompleted); len(samples) != 0 {
		t.Fatalf("an empty delta must not open a window: %v", samples)
	}
	if _, claimed := emptyCompleted["tps_sampling_contract"]; claimed {
		t.Fatalf("no window means no sampling contract: %v", emptyCompleted)
	}
	emptyUsage, _ := emptyCompleted["usage"].(map[string]any)
	wantNum(t, "usage after empty deltas", emptyUsage, "input_tokens", 40)
	wantNum(t, "usage after empty deltas", emptyUsage, "output_tokens", 8)

	// A completion with no response id closes the window instead of letting a
	// stale first delta pair with the response that follows it.
	noID, noIDClock, noIDBuffer := newHandlerBridge(t, "thread-noid", "turn-n", "gpt-5.1-codex")
	noIDClock.advance(10 * time.Millisecond)
	notify(t, noID, "item/agentMessage/delta", agentDeltaParams("thread-noid", "turn-n", "text"))
	noIDClock.advance(10 * time.Millisecond)
	notify(t, noID, "rawResponse/completed", map[string]any{"threadId": "thread-noid", "turnId": "turn-n"})
	noIDClock.advance(10 * time.Millisecond)
	notify(t, noID, "rawResponse/completed", rawCompletedParams("thread-noid", "turn-n", "resp-after", 10, 5, 0))
	notify(t, noID, "turn/completed", turnCompletedParams("thread-noid", "turn-n", "completed", 300))
	if samples := tpsSamples(t, lastRecordOfType(t, noIDBuffer, "turn.completed")); len(samples) != 0 {
		t.Fatalf("a completion with no id must reset the window: %v", samples)
	}

	// A present usage object with no usable token count contributes nothing and
	// resets the window, while the NEXT valid response is counted exactly.
	badUse, badClock, badBuffer := newHandlerBridge(t, "thread-baduse", "turn-b", "gpt-5.1-codex")
	badClock.advance(10 * time.Millisecond)
	notify(t, badUse, "item/agentMessage/delta", agentDeltaParams("thread-baduse", "turn-b", "text"))
	badClock.advance(10 * time.Millisecond)
	notify(t, badUse, "rawResponse/completed", map[string]any{
		"threadId": "thread-baduse", "turnId": "turn-b", "responseId": "resp-bad",
		"usage": map[string]any{"outputTokens": "unknown"},
	})
	if badUse.responseUsageObserved {
		t.Fatal("an unusable usage must not mark usage observed")
	}
	badClock.advance(10 * time.Millisecond)
	notify(t, badUse, "rawResponse/completed", rawCompletedParams("thread-baduse", "turn-b", "resp-later", 10, 6, 0))
	notify(t, badUse, "turn/completed", turnCompletedParams("thread-baduse", "turn-b", "completed", 300))
	badCompleted := lastRecordOfType(t, badBuffer, "turn.completed")
	if samples := tpsSamples(t, badCompleted); len(samples) != 0 {
		t.Fatalf("an unusable usage object must reset the window: %v", samples)
	}
	badUsage, _ := badCompleted["usage"].(map[string]any)
	wantNum(t, "usage after an unusable response", badUsage, "input_tokens", 10)
	wantNum(t, "usage after an unusable response", badUsage, "output_tokens", 6)

	// A turn whose responses carried no usage reports no usage, no fabricated
	// zeroes, and no TPS claim.
	none, noneClock, noneBuffer := newHandlerBridge(t, "thread-none", "turn-none", "gpt-5.1-codex")
	noneClock.advance(10 * time.Millisecond)
	notify(t, none, "item/agentMessage/delta", agentDeltaParams("thread-none", "turn-none", "text only"))
	noneClock.advance(20 * time.Millisecond)
	notify(t, none, "rawResponse/completed", map[string]any{
		"threadId": "thread-none", "turnId": "turn-none", "responseId": "resp-none",
	})
	notify(t, none, "turn/completed", turnCompletedParams("thread-none", "turn-none", "completed", 400))

	noneCompleted := lastRecordOfType(t, noneBuffer, "turn.completed")
	if usage, present := noneCompleted["usage"]; present && usage != nil {
		t.Fatalf("a usage-less turn must not invent usage: %v", usage)
	}
	if _, present := noneCompleted["input_tokens"]; present {
		t.Fatalf("a usage-less turn must not invent token fields: %v", noneCompleted)
	}
	if _, present := noneCompleted["tps_samples"]; present {
		t.Fatalf("a usage-less response must produce no sample: %v", noneCompleted)
	}
	// The normalized turn_usage loses the trusted agent_turn_v1 claim because
	// the usage is incomplete, but the duration is still reported.
	usageEvent := onlyEventOfType(t, normalizedEvents(t, noneBuffer), "turn_usage")
	if _, claimed := usageEvent.Data["tps_contract"]; claimed {
		t.Fatalf("an incomplete usage must not claim agent_turn_v1: %v", usageEvent.Data)
	}
	if usageEvent.Data["duration_ms"] != 400 {
		t.Fatalf("duration must still be reported: %v", usageEvent.Data)
	}
}

// TestCodexAppServerDuplicateCompletionKeepsNextWindow verifies a
// retransmitted completion id is counted once and does not erase the timing of
// the response that followed it.
func TestCodexAppServerDuplicateCompletionKeepsNextWindow(t *testing.T) {
	bridge, clock, buffer := newHandlerBridge(t, "thread-dup", "turn-d", "gpt-5.1-codex")

	clock.advance(10 * time.Millisecond)
	notify(t, bridge, "item/agentMessage/delta", agentDeltaParams("thread-dup", "turn-d", " "))
	clock.advance(20 * time.Millisecond)
	notify(t, bridge, "rawResponse/completed", rawCompletedParams("thread-dup", "turn-d", "resp-one", 10, 2, 0))

	// The duplicate arrives while the NEXT response's window is open.
	clock.advance(30 * time.Millisecond)
	notify(t, bridge, "item/agentMessage/delta", agentDeltaParams("thread-dup", "turn-d", "two"))
	notify(t, bridge, "rawResponse/completed", rawCompletedParams("thread-dup", "turn-d", "resp-one", 10, 2, 0))
	clock.advance(20 * time.Millisecond)
	notify(t, bridge, "rawResponse/completed", rawCompletedParams("thread-dup", "turn-d", "resp-two", 30, 6, 0))
	notify(t, bridge, "turn/completed", turnCompletedParams("thread-dup", "turn-d", "completed", 900))

	completed := lastRecordOfType(t, buffer, "turn.completed")
	usage, _ := completed["usage"].(map[string]any)
	wantNum(t, "deduplicated usage", usage, "input_tokens", 40)
	wantNum(t, "deduplicated usage", usage, "output_tokens", 8)
	samples := tpsSamples(t, completed)
	if len(samples) != 2 {
		t.Fatalf("the second response must still be sampled: %v", samples)
	}
	ids := map[string]bool{samples[0]["response_id"].(string): true, samples[1]["response_id"].(string): true}
	if !ids["resp-one"] || !ids["resp-two"] {
		t.Fatalf("both responses must be sampled: %v", samples)
	}
	if samples[0]["first_token_at_ms"] == samples[0]["completed_at_ms"] {
		t.Fatalf("a sample must never have a zero-length window: %v", samples[0])
	}
}

// TestCodexAppServerForeignNotificationsIgnored verifies a resumed session's
// replayed history for another thread or turn cannot corrupt the live turn.
func TestCodexAppServerForeignNotificationsIgnored(t *testing.T) {
	bridge, clock, buffer := newHandlerBridge(t, "thread-live", "turn-live", "gpt-5.1-codex")

	notify(t, bridge, "item/completed", map[string]any{
		"threadId": "thread-other", "turnId": "turn-old",
		"item": map[string]any{"id": "old-1", "type": "agentMessage", "text": "stale"},
	})
	notify(t, bridge, "item/agentMessage/delta", agentDeltaParams("thread-other", "turn-old", "stale delta"))
	notify(t, bridge, "rawResponse/completed", rawCompletedParams("thread-other", "turn-old", "resp-old", 9999, 999, 0))
	notify(t, bridge, "turn/completed", turnCompletedParams("thread-other", "turn-old", "completed", 9999))

	clock.advance(10 * time.Millisecond)
	notify(t, bridge, "item/agentMessage/delta", agentDeltaParams("thread-live", "turn-live", "fresh"))
	clock.advance(20 * time.Millisecond)
	notify(t, bridge, "rawResponse/completed", rawCompletedParams("thread-live", "turn-live", "resp-live", 11, 4, 0))
	notify(t, bridge, "turn/completed", turnCompletedParams("thread-live", "turn-live", "completed", 300))

	// The foreign turn/completed must not have terminated the live turn.
	completed := lastRecordOfType(t, buffer, "turn.completed")
	if num(t, completed["duration_ms"]) != 300 {
		t.Fatalf("the foreign turn must be ignored: %v", completed)
	}
	usage, _ := completed["usage"].(map[string]any)
	wantNum(t, "live usage", usage, "input_tokens", 11)
	wantNum(t, "live usage", usage, "output_tokens", 4)
	samples := tpsSamples(t, completed)
	if len(samples) != 1 || samples[0]["response_id"] != "resp-live" {
		t.Fatalf("foreign response leaked into the samples: %v", samples)
	}
	events := normalizedEvents(t, buffer)
	if len(events) != 1 || events[0].Type != "turn_usage" {
		t.Fatalf("a foreign thread must produce no normalized content: %v", events)
	}
}

// TestCodexAppServerFailedTurnsNormalized verifies every terminal failure shape
// ends the turn nonzero and reports no success, without inventing a
// turn/failed notification that the real protocol does not have:
//
//   - turn/completed with status failed carries the native turn error and
//     normalizes to run_finished with status failed
//   - turn/completed with status interrupted names the interrupted status
//   - a non-retryable error notification ends the turn, while a retryable one
//     leaves it open so the retry can complete
func TestCodexAppServerFailedTurnsNormalized(t *testing.T) {
	cases := []struct {
		name    string
		status  string
		native  map[string]any
		message string
	}{
		{
			name: "failed status", status: "failed", message: "model overloaded",
			native: map[string]any{
				"id": "turn-f", "status": "failed", "items": []any{},
				"error": map[string]any{"message": "model overloaded"},
			},
		},
		{
			name: "interrupted status", status: "interrupted", message: "interrupted",
			native: map[string]any{"id": "turn-f", "status": "interrupted", "items": []any{}},
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			bridge, _, buffer := newHandlerBridge(t, "thread-fail", "turn-f", "gpt-5.1-codex")
			notify(t, bridge, "item/agentMessage/delta", agentDeltaParams("thread-fail", "turn-f", "partial"))
			notify(t, bridge, "turn/completed", map[string]any{
				"threadId": "thread-fail", "turn": testCase.native,
			})

			failed := lastRecordOfType(t, buffer, "turn.failed")
			if message, _ := failed["error"].(string); !strings.Contains(message, testCase.message) {
				t.Fatalf("turn.failed must carry %q, got %v", testCase.message, failed)
			}
			if recordCount(buffer, "turn.completed") != 0 {
				t.Fatal("a failed turn must not also report completion")
			}
			if !bridge.turnFailed || !bridge.terminal {
				t.Fatalf("failTurn must mark the run terminal: %+v", bridge)
			}
			if exit := bridge.finalize(); exit == 0 {
				t.Fatal("a failed turn must not finalize as exit 0")
			}
			// The normalized result is a single run_finished failure: no usage
			// is reported for a turn that never completed.
			events := normalizedEvents(t, buffer)
			if len(events) != 1 || events[0].Type != protocol.EventRunFinished {
				t.Fatalf("a failed turn must normalize to one run_finished: %v", events)
			}
			if events[0].Data["status"] != "failed" {
				t.Fatalf("normalized failure status wrong: %v", events[0].Data)
			}
		})
	}

	// A retryable error is a transient stream event: the turn stays open and
	// still completes normally.
	retrying, clock, retryBuffer := newHandlerBridge(t, "thread-retry", "turn-ry", "gpt-5.1-codex")
	notify(t, retrying, "error", map[string]any{
		"threadId": "thread-retry", "turnId": "turn-ry", "willRetry": true,
		"error": map[string]any{"message": "stream disconnected"},
	})
	if retrying.turnFailed {
		t.Fatal("a retryable error must not end the turn")
	}
	clock.advance(10 * time.Millisecond)
	notify(t, retrying, "item/agentMessage/delta", agentDeltaParams("thread-retry", "turn-ry", "recovered"))
	clock.advance(20 * time.Millisecond)
	notify(t, retrying, "rawResponse/completed", rawCompletedParams("thread-retry", "turn-ry", "resp-ry", 11, 6, 0))
	notify(t, retrying, "turn/completed", turnCompletedParams("thread-retry", "turn-ry", "completed", 800))

	if recordCount(retryBuffer, "turn.failed") != 0 {
		t.Fatalf("a retryable error must not emit turn.failed: %s", retryBuffer.String())
	}
	if recordCount(retryBuffer, "turn.completed") != 1 {
		t.Fatalf("the turn must still complete after a retry: %s", retryBuffer.String())
	}
	if exit := retrying.finalize(); exit != 0 {
		t.Fatalf("a recovered turn must finalize as exit 0, got %d", exit)
	}

	// A non-retryable error ends the turn.
	fatal, _, fatalBuffer := newHandlerBridge(t, "thread-fatal", "turn-fatal", "gpt-5.1-codex")
	notify(t, fatal, "error", map[string]any{
		"threadId": "thread-fatal", "turnId": "turn-fatal", "willRetry": false,
		"error": map[string]any{"message": "quota exhausted"},
	})
	failed := lastRecordOfType(t, fatalBuffer, "turn.failed")
	if message, _ := failed["error"].(string); !strings.Contains(message, "quota exhausted") {
		t.Fatalf("turn.failed must carry the error message: %v", failed)
	}
	if exit := fatal.finalize(); exit == 0 {
		t.Fatal("a non-retryable error must not finalize as exit 0")
	}
}

// TestCodexAppServerUnknownMethodsIgnored verifies the transport reacts only to
// the real protocol: made-up reasoning delta and turn/failed method names carry
// no meaning and must not be mistaken for protocol events.
func TestCodexAppServerUnknownMethodsIgnored(t *testing.T) {
	bridge, clock, buffer := newHandlerBridge(t, "thread-invented", "turn-i", "gpt-5.1-codex")

	notify(t, bridge, "item/reasoning/delta", map[string]any{
		"threadId": "thread-invented", "turnId": "turn-i", "delta": "made up",
	})
	notify(t, bridge, "turn/failed", map[string]any{
		"threadId": "thread-invented", "turnId": "turn-i", "error": map[string]any{"message": "made up"},
	})
	clock.advance(10 * time.Millisecond)
	notify(t, bridge, "item/agentMessage/delta", agentDeltaParams("thread-invented", "turn-i", "real"))
	clock.advance(20 * time.Millisecond)
	notify(t, bridge, "rawResponse/completed", rawCompletedParams("thread-invented", "turn-i", "resp-i", 10, 4, 0))
	notify(t, bridge, "turn/completed", turnCompletedParams("thread-invented", "turn-i", "completed", 300))

	if recordCount(buffer, "turn.failed") != 0 {
		t.Fatalf("an invented turn/failed must be ignored: %s", buffer.String())
	}
	completed := lastRecordOfType(t, buffer, "turn.completed")
	// Only the real delta opened a window, so exactly one sample.
	if samples := tpsSamples(t, completed); len(samples) != 1 {
		t.Fatalf("only the real delta must open a window: %v", samples)
	}
}

// --- cancellation ----------------------------------------------------------

// TestCodexAppServerCancelTurnReportsFailure verifies a cancelled turn reports
// a failure and discards any half-open sampling window without reporting
// usage as a completed turn.
func TestCodexAppServerCancelTurnReportsFailure(t *testing.T) {
	bridge, clock, buffer := newHandlerBridge(t, "thread-cancel", "turn-c", "gpt-5.1-codex")

	clock.advance(10 * time.Millisecond)
	notify(t, bridge, "item/agentMessage/delta", agentDeltaParams("thread-cancel", "turn-c", "partial"))
	// A response completed, so a sample exists before the cancellation.
	clock.advance(20 * time.Millisecond)
	notify(t, bridge, "rawResponse/completed", rawCompletedParams("thread-cancel", "turn-c", "resp-c", 15, 5, 0))

	bridge.cancelTurn()

	if recordCount(buffer, "turn.completed") != 0 {
		t.Fatal("a cancelled turn must not report completion")
	}
	failed := lastRecordOfType(t, buffer, "turn.failed")
	if message, _ := failed["error"].(string); message != "turn cancelled" {
		t.Fatalf("cancellation message = %q", message)
	}
	if len(bridge.sampler.samples) != 0 {
		t.Fatalf("cancellation must discard the sampling window: %v", bridge.sampler.samples)
	}
	if exit := bridge.finalize(); exit == 0 {
		t.Fatal("a cancelled turn must not finalize as exit 0")
	}
	// A cancellation after a completed turn is a no-op.
	done, _, doneBuffer := newHandlerBridge(t, "thread-done", "turn-d", "gpt-5.1-codex")
	notify(t, done, "turn/completed", turnCompletedParams("thread-done", "turn-d", "completed", 100))
	done.cancelTurn()
	if recordCount(doneBuffer, "turn.failed") != 0 {
		t.Fatal("cancelling a completed turn must not add a failure")
	}
}

// --- JSON-RPC transport ----------------------------------------------------

// TestCodexAppServerConnMatchesResponseAndHandlesServerRequests verifies the
// real JSON-RPC client: a server-initiated request arriving while a call is
// outstanding is dispatched through the handler, and the call still returns its
// own matching response.
//
// The client and the peer run concurrently over a real duplex connection, and
// the peer must be free to write both messages even while the client is still
// answering the server request: a bare net.Pipe is synchronous, so a peer
// blocked mid-write would deadlock a legitimate answer.
func TestCodexAppServerConnMatchesResponseAndHandlesServerRequests(t *testing.T) {
	clientSide, serverSide := net.Pipe()
	defer clientSide.Close()
	defer serverSide.Close()

	// The client writes answers on the same connection it reads: reads are
	// serialised through one lock because a net.Conn read is not safe against
	// a concurrent writer being sampled.
	var writeMu sync.Mutex
	clientConn := &lockingConn{Conn: clientSide, writeMu: &writeMu}

	conn := newCodexAppServerConn(clientConn, clientSide)

	serverDone := make(chan struct{})
	var approvalAnswer json.RawMessage
	var answerID string
	var seen []string

	go func() {
		defer close(serverDone)
		decoder := json.NewDecoder(serverSide)
		encoder := json.NewEncoder(serverSide)
		answered := false
		for {
			var msg codexAppServerMessage
			if err := decoder.Decode(&msg); err != nil {
				return
			}
			if msg.Method == "" {
				if msg.hasID() && !answered {
					answered = true
					answerID = string(msg.ID)
					approvalAnswer = msg.Result
				}
				continue
			}
			seen = append(seen, msg.Method)
			// The server request arrives while the client is still waiting for
			// its own response, so the client must answer it from inside the
			// call pump.
			serverRequestID := json.RawMessage(`9001`)
			_ = encoder.Encode(codexAppServerMessage{
				ID: serverRequestID, Method: "item/commandExecution/requestApproval",
				Params: json.RawMessage(`{"command":"rm -rf /tmp/x"}`),
			})
			// Only then the matching response to the in-flight call.
			_ = encoder.Encode(codexAppServerMessage{
				ID: msg.ID, Result: json.RawMessage(`{"turn":{"id":"turn-rpc"}}`),
			})
		}
	}()

	dispatched := make(chan string, 1)
	raw, err := conn.call(context.Background(), "turn/start", map[string]any{"threadId": "thread-rpc"},
		func(msg codexAppServerMessage) error {
			if msg.Method == "" {
				return nil
			}
			dispatched <- msg.Method
			// Answer exactly as the bridge's dispatcher does.
			return conn.respond(msg.ID, map[string]any{"decision": "accept"})
		})
	if err != nil {
		t.Fatalf("call: %v", err)
	}
	if string(raw) != `{"turn":{"id":"turn-rpc"}}` {
		t.Fatalf("call returned %s, want the matching response result", raw)
	}
	select {
	case method := <-dispatched:
		if method != "item/commandExecution/requestApproval" {
			t.Fatalf("handler saw %q, want the approval request", method)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the server request was never dispatched to the handler")
	}

	// Close the client side so the peer's decode loop ends, then inspect what
	// it observed. Both assertions are read after the peer has stopped.
	_ = clientSide.Close()
	select {
	case <-serverDone:
	case <-time.After(2 * time.Second):
		t.Fatal("the peer did not finish")
	}
	if len(seen) != 1 || seen[0] != "turn/start" {
		t.Fatalf("the peer must have seen exactly the turn/start request: %v", seen)
	}
	if answerID != `9001` {
		t.Fatalf("the answer must carry the server request id, got %q", answerID)
	}
	var decision map[string]any
	if err := json.Unmarshal(approvalAnswer, &decision); err != nil {
		t.Fatalf("decode approval answer %s: %v", approvalAnswer, err)
	}
	if decision["decision"] != "accept" {
		t.Fatalf("approval answer = %v, want accept", decision)
	}
}

// lockingConn serialises writes onto a net.Conn whose reads and writes would
// otherwise interleave.
type lockingConn struct {
	net.Conn
	writeMu *sync.Mutex
}

func (c *lockingConn) Write(p []byte) (int, error) {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	return c.Conn.Write(p)
}

// TestCodexAppServerConnErrorsAndTruncation verifies the transport surfaces a
// JSON-RPC error and a truncated stream instead of hanging or reporting a
// clean end of stream.
func TestCodexAppServerConnErrorsAndTruncation(t *testing.T) {
	// A named JSON-RPC error is returned as a typed request error.
	clientSide, serverSide := net.Pipe()
	defer clientSide.Close()
	defer serverSide.Close()
	conn := newCodexAppServerConn(clientSide, clientSide)

	go func() {
		decoder := json.NewDecoder(serverSide)
		var msg codexAppServerMessage
		if err := decoder.Decode(&msg); err != nil {
			return
		}
		body := []byte(`{"id":` + string(msg.ID) + `,"error":{"code":-32000,"message":"boom"}}` + "\n")
		_, _ = serverSide.Write(body)
	}()

	_, err := conn.call(context.Background(), "thread/start", map[string]any{}, nil)
	if err == nil {
		t.Fatal("a JSON-RPC error response must not be reported as success")
	}
	var requestErr *codexAppServerRequestError
	if !errors.As(err, &requestErr) {
		t.Fatalf("error = %v, want a codexAppServerRequestError", err)
	}
	if requestErr.Code != -32000 || requestErr.Method != "thread/start" {
		t.Fatalf("request error = %+v", requestErr)
	}

	// A malformed line is a hard failure wrapping the malformed marker, never
	// a silent skip.
	badSide, badServerSide := net.Pipe()
	defer badSide.Close()
	badConn := newCodexAppServerConn(badSide, badSide)
	go func() {
		decoder := json.NewDecoder(badServerSide)
		var msg codexAppServerMessage
		if err := decoder.Decode(&msg); err != nil {
			return
		}
		_, _ = badServerSide.Write([]byte("{not valid json\n"))
	}()
	if _, err := badConn.call(context.Background(), "thread/start", map[string]any{}, nil); !errors.Is(err, errCodexAppServerMalformed) {
		t.Fatalf("error = %v, want the malformed marker", err)
	}

	// A closed stream is a truncation, never a clean success.
	cutSide, cutServerSide := net.Pipe()
	defer cutSide.Close()
	cutConn := newCodexAppServerConn(cutSide, cutSide)
	go func() {
		decoder := json.NewDecoder(cutServerSide)
		var msg codexAppServerMessage
		if err := decoder.Decode(&msg); err != nil {
			return
		}
		_ = cutServerSide.Close()
	}()
	if _, err := cutConn.call(context.Background(), "thread/start", map[string]any{}, nil); !errors.Is(err, errCodexAppServerClosed) {
		t.Fatalf("error = %v, want the closed-stream marker", err)
	}
}

// TestCodexAppServerConnRoundTripsStringRequestIDs verifies a server request
// carrying a string id is answered with that same string id, and that a string
// id never collides with the client's own numeric request id.
func TestCodexAppServerConnRoundTripsStringRequestIDs(t *testing.T) {
	clientSide, serverSide := net.Pipe()
	defer clientSide.Close()
	defer serverSide.Close()

	var writeMu sync.Mutex
	clientConn := &lockingConn{Conn: clientSide, writeMu: &writeMu}
	conn := newCodexAppServerConn(clientConn, clientSide)

	serverDone := make(chan struct{})
	var answerID string
	var dispatched string

	go func() {
		defer close(serverDone)
		decoder := json.NewDecoder(serverSide)
		encoder := json.NewEncoder(serverSide)
		answered := false
		for {
			var msg codexAppServerMessage
			if err := decoder.Decode(&msg); err != nil {
				return
			}
			if msg.Method == "" {
				if msg.hasID() && !answered {
					answered = true
					answerID = string(msg.ID)
				}
				continue
			}
			if answered {
				continue
			}
			// A server request whose id is a string, never a number.
			_ = encoder.Encode(codexAppServerMessage{
				ID: json.RawMessage(`"req-abc"`), Method: "item/fileChange/requestApproval",
				Params: json.RawMessage(`{}`),
			})
			_ = encoder.Encode(codexAppServerMessage{
				ID: msg.ID, Result: json.RawMessage(`{"turn":{"id":"turn-str"}}`),
			})
		}
	}()

	raw, err := conn.call(context.Background(), "turn/start", map[string]any{"threadId": "thread-str"},
		func(msg codexAppServerMessage) error {
			if msg.Method == "" {
				return nil
			}
			dispatched = msg.Method
			return conn.respond(msg.ID, map[string]any{"decision": "accept"})
		})
	if err != nil {
		t.Fatalf("call: %v", err)
	}
	// The string id must not have been mistaken for the numeric response id,
	// so the call still resolves on its own matching response.
	if string(raw) != `{"turn":{"id":"turn-str"}}` {
		t.Fatalf("call returned %s, want the matching response result", raw)
	}
	if dispatched != "item/fileChange/requestApproval" {
		t.Fatalf("handler saw %q, want the string-id approval request", dispatched)
	}

	_ = clientSide.Close()
	select {
	case <-serverDone:
	case <-time.After(2 * time.Second):
		t.Fatal("the peer did not finish")
	}
	if answerID != `"req-abc"` {
		t.Fatalf("the answer must echo the string id verbatim, got %s", answerID)
	}
}

// TestCodexAppServerConnCloseReleasesFullBufferReader verifies close releases
// the reader goroutine even when the stream buffer is already full, so a
// teardown can never leak the reader.
func TestCodexAppServerConnCloseReleasesFullBufferReader(t *testing.T) {
	reader, writer := io.Pipe()
	defer reader.Close()
	defer writer.Close()
	conn := newCodexAppServerConn(discardWriteCloser{}, reader)

	// Overflow the stream buffer without consuming any of it, so the reader
	// goroutine is parked on a send when close arrives.
	payload := strings.Repeat(`{"method":"thread/started"}`+"\n", cap(conn.stream)+1)
	go func() { _, _ = writer.Write([]byte(payload)) }()

	// Wait until the buffer is genuinely full: only then is the reader blocked
	// on a send rather than on the pipe.
	for len(conn.stream) != cap(conn.stream) {
		time.Sleep(time.Millisecond)
	}

	conn.close()

	// Draining after close must still terminate, which is only possible if the
	// reader goroutine gave up its pending send instead of blocking forever.
	drained := make(chan struct{})
	go func() {
		defer close(drained)
		for range conn.stream {
		}
	}()
	select {
	case <-drained:
	case <-time.After(2 * time.Second):
		t.Fatal("close must release the reader goroutine even with a full buffer")
	}
}

// discardWriteCloser stands in for the child's stdin on a peer with no writes.
type discardWriteCloser struct{}

func (discardWriteCloser) Write(p []byte) (int, error) { return len(p), nil }
func (discardWriteCloser) Close() error                { return nil }
