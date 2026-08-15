package driver

import (
	"encoding/json"
	"testing"
)

func TestEncodeClaudeStreamUserMessage(t *testing.T) {
	data, err := EncodeClaudeStreamUserMessage("say BANANA")
	if err != nil {
		t.Fatal(err)
	}
	if len(data) == 0 || data[len(data)-1] != '\n' {
		t.Fatalf("stream input must be newline-delimited JSON: %q", data)
	}
	var event map[string]any
	if err := json.Unmarshal(data, &event); err != nil {
		t.Fatal(err)
	}
	if event["type"] != "user" {
		t.Fatalf("type = %#v, want user", event["type"])
	}
	message, ok := event["message"].(map[string]any)
	if !ok {
		t.Fatalf("message = %#v, want object", event["message"])
	}
	if message["role"] != "user" || message["content"] != "say BANANA" {
		t.Fatalf("unexpected message payload: %#v", message)
	}
	parent, ok := event["parent_tool_use_id"]
	if !ok || parent != nil {
		t.Fatalf("parent_tool_use_id = %#v, want explicit null", parent)
	}
}
