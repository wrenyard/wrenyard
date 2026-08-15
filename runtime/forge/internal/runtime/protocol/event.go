// Package protocol owns Forge's normalized execution and wire protocol types.
package protocol

import (
	"encoding/json"
	"fmt"
)

const (
	EventRunStarted      = "run_started"
	EventAttemptStarted  = "attempt_started"
	EventAttemptFinished = "attempt_finished"
	EventRetryScheduled  = "retry_scheduled"
	EventCircuitOpened   = "circuit_opened"
	EventCircuitUnlocked = "circuit_unlocked"
	EventPolicyFallback  = "policy_fallback"
	EventRunFinished     = "run_finished"
)

// Common normalized content event types emitted by every first-class client
// codec. Adapters normalize native output into exactly these types; the
// validator below rejects any event outside this closed set so a malformed or
// unknown native record can never leak into the public stream.
const (
	EventMessage    = "message"
	EventToolCall   = "tool_call"
	EventToolResult = "tool_result"
	EventTurnUsage  = "turn_usage"
)

// knownEventTypes is the complete closed set of Forge Agent Stream v1 event
// types. Any type outside this set fails validation.
var knownEventTypes = map[string]bool{
	EventRunStarted: true, EventAttemptStarted: true, EventAttemptFinished: true,
	EventRetryScheduled: true, EventCircuitOpened: true, EventCircuitUnlocked: true,
	EventPolicyFallback: true, EventRunFinished: true,
	EventMessage: true, EventToolCall: true, EventToolResult: true, EventTurnUsage: true,
}

// Event is a client-independent event normalized from native client output.
type Event struct {
	Type string         `json:"type"`
	Data map[string]any `json:"data"`
}

// ValidateEvent applies the centralized Forge Agent Stream v1 schema to a
// normalized event. It is the single authority the event sink consults so
// every emitted common event has a known type and the required structural
// fields for its type. Malformed or unknown adapter events return an error;
// the sink converts that into a privacy-safe failed attempt rather than
// leaking the offending native payload.
func ValidateEvent(event Event) error {
	if event.Type == "" {
		return fmt.Errorf("event missing type")
	}
	if !knownEventTypes[event.Type] {
		return fmt.Errorf("unknown event type %q", event.Type)
	}
	switch event.Type {
	case EventMessage:
		return validateMessage(event.Data)
	case EventToolCall:
		return validateToolCall(event.Data)
	case EventToolResult:
		return validateToolResult(event.Data)
	case EventTurnUsage:
		return validateTurnUsage(event.Data)
	case EventRunFinished:
		return validateRunFinished(event.Data)
	default:
		// Lifecycle types are owned and emitted by the orchestrator; they pass
		// type-membership validation here without further per-field checks.
		return nil
	}
}

func validateMessage(data map[string]any) error {
	text, ok := data["text"].(string)
	if !ok || text == "" {
		return fmt.Errorf("message missing non-empty text")
	}
	return nil
}

func validateToolCall(data map[string]any) error {
	name, ok := data["name"].(string)
	if !ok || name == "" {
		return fmt.Errorf("tool_call missing non-empty name")
	}
	callID, ok := data["call_id"].(string)
	if !ok || callID == "" {
		return fmt.Errorf("tool_call missing non-empty call_id")
	}
	return nil
}

func validateToolResult(data map[string]any) error {
	callID, ok := data["call_id"].(string)
	if !ok || callID == "" {
		return fmt.Errorf("tool_result missing non-empty call_id")
	}
	status, ok := data["status"].(string)
	if !ok || (status != "ok" && status != "error") {
		return fmt.Errorf("tool_result status must be ok or error")
	}
	return nil
}

func validateTurnUsage(data map[string]any) error {
	if data == nil {
		return fmt.Errorf("turn_usage missing data")
	}
	// Every emitted turn_usage must structurally carry nonnegative
	// input_tokens, output_tokens, and duration_ms. Additive metadata fields
	// (reasoning_output_tokens, total_tokens, tps_contract, scopes) are left
	// unchecked so the contract stays forward-compatible.
	if _, ok := nonnegativeIntField(data, "input_tokens"); !ok {
		return fmt.Errorf("turn_usage missing non-negative input_tokens")
	}
	if _, ok := nonnegativeIntField(data, "output_tokens"); !ok {
		return fmt.Errorf("turn_usage missing non-negative output_tokens")
	}
	if _, ok := nonnegativeIntField(data, "duration_ms"); !ok {
		return fmt.Errorf("turn_usage missing non-negative duration_ms")
	}
	return nil
}

func validateRunFinished(data map[string]any) error {
	status, ok := data["status"].(string)
	if !ok || (status != "done" && status != "failed") {
		return fmt.Errorf("run_finished status must be done or failed")
	}
	return nil
}

// nonnegativeIntField reports whether data[key] is present as a JSON-numeric
// whole nonnegative value, returning the int form. It accepts the types a
// generic map[string]any decoded from JSON (float64, json.Number) plus the
// concrete int forms codecs attach directly.
func nonnegativeIntField(data map[string]any, key string) (int, bool) {
	switch v := data[key].(type) {
	case int:
		if v >= 0 {
			return v, true
		}
	case int64:
		if v >= 0 {
			return int(v), true
		}
	case float64:
		if v >= 0 && v == float64(int(v)) {
			return int(v), true
		}
	case json.Number:
		if n, err := v.Int64(); err == nil && n >= 0 {
			return int(n), true
		}
	}
	return 0, false
}
