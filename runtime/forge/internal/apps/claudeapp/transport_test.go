package claudeapp

import (
	"encoding/json"
	"testing"
)

func TestSSELineNormalizesEventAndDataLines(t *testing.T) {
	if got := normalizeSSELine("event:  message_start\n", "model"); got != "event: message_start\n" {
		t.Fatalf("event normalization = %q", got)
	}
	if got := normalizeSSELine("data:  ", "m"); got != "data: \n" {
		t.Fatalf("empty data = %q", got)
	}
	if got := normalizeSSELine("data:[DONE]", "m"); got != "data: [DONE]\n" {
		t.Fatalf("[DONE] data = %q", got)
	}
	if got := normalizeSSELine(":\n", "m"); got != ":\n" {
		t.Fatalf("comment line = %q", got)
	}
}

func TestNormalizeMessageJSONInjectsDefaults(t *testing.T) {
	input := []byte(`{"type":"message","content":[{"type":"text","text":"hi"}]}`)
	normalized := normalizeMessageJSON(input, sonnetID)
	payload := map[string]interface{}{}
	if err := json.Unmarshal(normalized, &payload); err != nil {
		t.Fatal(err)
	}
	if payload["model"] != sonnetID {
		t.Fatalf("expected model injected as %q, got %#v", sonnetID, payload["model"])
	}
	if payload["role"] != "assistant" {
		t.Fatalf("expected default role assistant, got %#v", payload["role"])
	}
	if _, ok := payload["usage"].(map[string]interface{}); !ok {
		t.Fatalf("expected usage object, got %#v", payload["usage"])
	}
}

func TestNormalizeMessageJSONPreservesErrorPayload(t *testing.T) {
	input := []byte(`{"type":"error","error":{"type":"overloaded_error","message":"boom"}}`)
	normalized := normalizeMessageJSON(input, sonnetID)
	if string(normalized) != string(input) {
		t.Fatalf("error payload should be unchanged, got %s", string(normalized))
	}
}

func TestNormalizeMessageSetsTerminalModelDefault(t *testing.T) {
	msg := map[string]interface{}{}
	normalizeMessage(msg, "")
	if msg["model"] != sonnetID {
		t.Fatalf("terminal model default = %#v, want %q", msg["model"], sonnetID)
	}
	if msg["type"] != "message" || msg["role"] != "assistant" {
		t.Fatalf("terminal message defaults not applied: %#v", msg)
	}
	if _, ok := msg["content"].([]interface{}); !ok {
		t.Fatalf("terminal content should be a list, got %#v", msg["content"])
	}
}
