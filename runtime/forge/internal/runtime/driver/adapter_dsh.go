package driver

import (
	"encoding/json"
	"fmt"
	"math"
	"strings"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/protocol"
)

// DSHAdapter parses the forge.dsh.stream.v1 JSONL transcript produced by the
// DSH bridge plugin under --forge-agent. Each line is one plugin event;
// trailing plain DSH stdout (non-JSON) is ignored. The adapter treats the
// assistant/message text as the authoritative final answer and accumulates
// assistant/chunk deltas only as a fallback (turn/end carries no text on the
// real wire), emitting the trusted agent_turn_v1 TPS contract only for
// complete usage with a positive duration on a successful turn.
type DSHAdapter struct{}

func (a *DSHAdapter) ParseSessionID(logPath string) (string, error) {
	events, err := readJSONLFile(logPath)
	if err != nil {
		return "", err
	}
	for _, event := range events {
		if id := dshSessionID(event); id != "" {
			return id, nil
		}
	}
	return "", fmt.Errorf("no DSH session id found in %s", logPath)
}

func (a *DSHAdapter) ParseResult(logPath string) (string, error) {
	events, err := readJSONLFile(logPath)
	if err != nil {
		return "", err
	}
	// The real bridge emits assistant/chunk deltas followed by an
	// authoritative assistant/message final answer; turn/end carries no text
	// on the real wire. Chunks are accumulated only as a fallback and an
	// assistant/message text is never appended to them, so the final answer
	// is never duplicated.
	finalText := ""
	accumulated := ""
	for _, event := range events {
		switch strings.ToLower(strings.TrimSpace(dshEventType(event))) {
		case "assistant/chunk":
			if dshIsReasoning(event) {
				continue
			}
			if text, ok := getString(event, "text"); ok && text != "" {
				accumulated += text
			}
		case "assistant/message":
			if dshIsReasoning(event) {
				continue
			}
			if text, ok := getString(event, "text"); ok && text != "" {
				// Authoritative final answer; do not append it to the chunk
				// accumulation so the answer is never duplicated.
				finalText = text
			}
		case "turn/end":
			// Defensive only: turn/end has no text on the real wire, but a
			// legacy transcript may still carry one and it still wins over
			// chunk accumulation.
			if finalText == "" {
				if text := dshBridgeFinalText(event); text != "" {
					finalText = text
				}
			}
		}
	}
	if strings.TrimSpace(finalText) != "" {
		return strings.TrimSpace(finalText), nil
	}
	return strings.TrimSpace(accumulated), nil
}

// dshNormalizer is the line codec routed from the dsh transcript family. It is
// deliberately stateless: per-line assistant content becomes message events,
// tool lifecycle records become tool_call/tool_result pairs, and a turn/end
// terminal emits usage then the normalized run_finished so the terminal event
// stays last for complete-success evidence.
func dshNormalizer(line []byte) []protocol.Event {
	var event map[string]any
	if err := json.Unmarshal(line, &event); err != nil {
		// Ignore trailing plain DSH stdout that is not JSON.
		return nil
	}
	typ := dshEventType(event)
	switch strings.ToLower(strings.TrimSpace(typ)) {
	case "turn/start":
		return nil
	case "assistant/chunk", "assistant/message":
		// Reasoning deltas (either typed or chunk kind=reasoning) are never
		// surfaced as transcript messages.
		if dshIsReasoning(event) {
			return nil
		}
		text, _ := getString(event, "text")
		if strings.TrimSpace(text) == "" {
			return nil
		}
		return []protocol.Event{{Type: "message", Data: map[string]any{"role": "assistant", "text": text}}}
	case "assistant/reasoning":
		return nil
	case "tool/call":
		return dshToolCallEvents(event)
	case "tool/result":
		return dshToolResultEvents(event)
	case "turn/end":
		return dshTurnEndEvents(event)
	case "error", "failed", "failure", "cancelled", "canceled":
		return []protocol.Event{normalizedFailureEvent(event)}
	default:
		return nil
	}
}

// dshTurnEndEvents normalizes the terminal bridge event. The bridge final text
// (preferred over accumulated deltas) becomes the final assistant message; a
// successful turn with complete usage and a positive native duration claims
// the trusted agent_turn_v1 contract; every other case stays unscoped. The
// run_finished terminal is always emitted last.
func dshTurnEndEvents(event map[string]any) []protocol.Event {
	var out []protocol.Event
	if text := dshBridgeFinalText(event); text != "" {
		out = append(out, protocol.Event{Type: "message", Data: map[string]any{"role": "assistant", "text": text}})
	}

	status := "done"
	if isError, _ := getBool(event, "is_error"); isError {
		status = "failed"
	}
	if s, ok := getString(event, "status"); ok {
		switch strings.ToLower(strings.TrimSpace(s)) {
		case "done", "success", "ok", "completed":
			status = "done"
		case "error", "failed", "failure", "cancelled", "canceled":
			status = "failed"
		}
	}

	if usage, ok := event["usage"].(map[string]any); ok {
		durationMs := dshDurationMS(event)
		usageData := map[string]any{
			"input_tokens":  dshUsageInt(usage, "input_tokens", "inputTokens"),
			"output_tokens": dshUsageInt(usage, "output_tokens", "outputTokens"),
			"duration_ms":   durationMs,
		}
		// Cache partitions are forwarded only when the bridge actually
		// reported them; missing partitions are never fabricated.
		if cacheRead, ok := dshUsageToken(usage, "cache_read_input_tokens", "cacheReadInputTokens"); ok {
			usageData["cache_read_input_tokens"] = cacheRead
		}
		if cacheWrite, ok := dshUsageToken(usage, "cache_creation_input_tokens", "cacheCreationInputTokens"); ok {
			usageData["cache_creation_input_tokens"] = cacheWrite
		}
		if status == "done" && durationMs > 0 {
			if _, _, ok := dshCompleteUsageTokens(usage); ok {
				applyTrustedAgentTurnContract(usageData)
			}
		}
		if status == "done" {
			if samples, ok := dshTokenizerGenerationSamples(event); ok {
				usageData["tps_sampling_contract"] = tokenizerTPSSamplingContract
				usageData["tps_samples"] = samples
			}
		}
		out = append(out, protocol.Event{Type: "turn_usage", Data: usageData})
	}

	data := map[string]any{"status": status}
	if status == "failed" {
		if errValue := dshErrorValue(event); errValue != nil {
			data["error"] = errValue
		}
	}
	if sessionID := dshSessionID(event); sessionID != "" {
		data["native_session_id"] = sessionID
	}
	out = append(out, protocol.Event{Type: protocol.EventRunFinished, Data: data})
	return out
}

func dshToolCallEvents(event map[string]any) []protocol.Event {
	callID := dshCallID(event)
	if callID == "" {
		return nil
	}
	name, _ := getString(event, "name")
	if strings.TrimSpace(name) == "" {
		name, _ = getString(event, "tool")
	}
	if strings.TrimSpace(name) == "" {
		name = "tool_call"
	}
	data := map[string]any{
		"name":          name,
		"input_summary": truncateHead(jsonStringValue(event["input"]), inputSummaryMaxBytes),
		"call_id":       callID,
	}
	if sessionID := dshSessionID(event); sessionID != "" {
		data["native_session_id"] = sessionID
	}
	return []protocol.Event{{Type: "tool_call", Data: data}}
}

func dshToolResultEvents(event map[string]any) []protocol.Event {
	callID := dshCallID(event)
	if callID == "" {
		return nil
	}
	status := "ok"
	if isError, _ := getBool(event, "is_error"); isError {
		status = "error"
	}
	if s, ok := getString(event, "status"); ok {
		switch strings.ToLower(strings.TrimSpace(s)) {
		case "done", "success", "ok", "completed":
			status = "ok"
		case "error", "failed", "failure", "cancelled", "canceled":
			status = "error"
		}
	}
	output := jsonStringValue(event["output"])
	if output == "" {
		output = jsonStringValue(event["result"])
	}
	if output == "" {
		output = jsonStringValue(event["error"])
	}
	data := map[string]any{
		"call_id":     callID,
		"status":      status,
		"output_tail": truncateTail(output, outputTailMaxBytes),
	}
	if sessionID := dshSessionID(event); sessionID != "" {
		data["native_session_id"] = sessionID
	}
	return []protocol.Event{{Type: "tool_result", Data: data}}
}

// dshBridgeFinalText extracts the final answer text from a bridge event. It
// prefers explicit final-text fields over nested message content so the bridge
// final text wins over accumulated deltas.
func dshBridgeFinalText(event map[string]any) string {
	for _, key := range []string{"text", "result", "final_text", "output", "message"} {
		if text, ok := getString(event, key); ok {
			text = strings.TrimSpace(text)
			if text != "" {
				return text
			}
		}
	}
	if msg, ok := event["message"].(map[string]any); ok {
		for _, key := range []string{"text", "content"} {
			if text, ok := getString(msg, key); ok {
				text = strings.TrimSpace(text)
				if text != "" {
					return text
				}
			}
		}
	}
	return ""
}

// dshEventType returns the bridge event type from the primary event field,
// falling back to the legacy type field. Fallbacks are defensive only.
func dshEventType(event map[string]any) string {
	if typ, ok := getString(event, "event"); ok {
		if strings.TrimSpace(typ) != "" {
			return typ
		}
	}
	typ, _ := getString(event, "type")
	return typ
}

// dshIsReasoning reports whether a chunk/message is a reasoning delta, either
// because it is a legacy assistant/reasoning record or because its chunk kind
// is reasoning.
func dshIsReasoning(event map[string]any) bool {
	if kind, ok := getString(event, "kind"); ok {
		if strings.EqualFold(strings.TrimSpace(kind), "reasoning") {
			return true
		}
	}
	return false
}

// dshDurationMS returns the native duration in ms from the primary duration
// field, falling back to the legacy duration_ms field. Fallbacks are defensive
// only; the trusted contract still requires a positive duration.
func dshDurationMS(event map[string]any) int {
	if d := intValue(event["duration"]); d > 0 {
		return d
	}
	return intValue(event["duration_ms"])
}

// dshCallID returns the tool call id from the primary callId field, falling
// back to the legacy id and call_id fields. Fallbacks are defensive only.
func dshCallID(event map[string]any) string {
	for _, key := range []string{"callId", "id", "call_id"} {
		if id, ok := getString(event, key); ok {
			if id = strings.TrimSpace(id); id != "" {
				return id
			}
		}
	}
	return ""
}

func dshSessionID(event map[string]any) string {
	for _, key := range []string{"session_id", "sessionId", "native_session_id", "conversation_id"} {
		if id, ok := getString(event, key); ok {
			if strings.TrimSpace(id) != "" {
				return strings.TrimSpace(id)
			}
		}
	}
	for _, container := range []string{"session", "metadata"} {
		if nested, ok := event[container].(map[string]any); ok {
			for _, key := range []string{"session_id", "id", "conversation_id"} {
				if id, ok := getString(nested, key); ok {
					return strings.TrimSpace(id)
				}
			}
		}
	}
	return ""
}

func dshErrorValue(event map[string]any) any {
	for _, key := range []string{"error", "message", "detail"} {
		if value, ok := event[key]; ok {
			if normalized := normalizedErrorValue(value); normalized != nil && normalized != "" {
				return normalized
			}
		}
	}
	return "DSH runtime failed"
}

const dshMaxSafeInteger = 9007199254740991

func dshUsageInt(usage map[string]any, keys ...string) int {
	for _, key := range keys {
		if value, ok := usage[key]; ok {
			switch number := value.(type) {
			case int:
				return number
			case int64:
				return int(number)
			case float64:
				if number >= 0 && number <= dshMaxSafeInteger && math.Trunc(number) == number {
					return int(number)
				}
			}
		}
	}
	return 0
}

func dshCompleteUsageTokens(usage map[string]any) (int, int, bool) {
	input, inputOK := dshUsageToken(usage, "input_tokens", "inputTokens")
	output, outputOK := dshUsageToken(usage, "output_tokens", "outputTokens")
	return input, output, inputOK && outputOK
}

func dshUsageToken(usage map[string]any, keys ...string) (int, bool) {
	for _, key := range keys {
		value, ok := usage[key]
		if !ok {
			continue
		}
		switch number := value.(type) {
		case int:
			if number >= 0 {
				return number, true
			}
		case int64:
			if number >= 0 {
				return int(number), true
			}
		case float64:
			if number >= 0 && number <= dshMaxSafeInteger && math.Trunc(number) == number {
				return int(number), true
			}
		}
	}
	return 0, false
}

// dshTokenizerGenerationSamples converts the bridge's transient
// tps_generation payload into canonical tokenizer_v1 samples. Tokens are
// counted with the shared fixed cl100k tokenizer over only the actually
// observed generation blocks, and the speed window is the first-to-last
// delta, so completion latency, tool waits, tool output and summaries never
// contribute. Observed reasoning counts only for speed. Raw strings stay in this
// function: only the canonical samples reach the persisted usage event. A
// window the bridge could not observe (a single timestamp, under 100ms, or
// no content) skips only its own sample; a malformed payload is rejected
// outright. Legacy response_v1 payloads are skipped, never relabeled.
func dshTokenizerGenerationSamples(event map[string]any) ([]any, bool) {
	raw, ok := event["tps_generation"].([]any)
	if !ok {
		return nil, false
	}
	samples := make([]any, 0, len(raw))
	for _, value := range raw {
		generation, ok := value.(map[string]any)
		if !ok {
			return nil, false
		}
		responseID, responseOK := generation["response_id"].(string)
		model, modelOK := generation["model"].(string)
		blocks, blocksOK := generation["blocks"].(map[string]any)
		if !responseOK || strings.TrimSpace(responseID) == "" || !modelOK || strings.TrimSpace(model) == "" || !blocksOK {
			return nil, false
		}
		if len(blocks) == 0 {
			continue
		}
		first, firstOK := dshFiniteNumber(generation["first_delta_at_ms"])
		last, lastOK := dshFiniteNumber(generation["last_delta_at_ms"])
		if !firstOK || !lastOK || last <= first || last-first < float64(tokenizerMinimumWindowMS) {
			continue
		}
		var tokens int64
		for _, rawBlock := range blocks {
			text, ok := rawBlock.(string)
			if !ok {
				return nil, false
			}
			count, ok := countTPSTokens(text)
			if !ok {
				return nil, false
			}
			tokens += count
		}
		if tokens <= 0 {
			continue
		}
		samples = append(samples, map[string]any{
			"response_id": responseID,
			"model":       model,
			// Approximate cl100k count of observed generation content, never
			// billed usage. completed_at_ms is the last observed delta, not
			// the message completion, so completion latency stays excluded.
			"output_tokens":     tokens,
			"first_token_at_ms": first,
			"completed_at_ms":   last,
		})
	}
	if len(samples) == 0 {
		return nil, false
	}
	return samples, true
}

func dshFiniteNumber(value any) (float64, bool) {
	switch number := value.(type) {
	case int:
		return float64(number), true
	case int64:
		return float64(number), true
	case float64:
		return number, !math.IsNaN(number) && !math.IsInf(number, 0)
	default:
		return 0, false
	}
}
