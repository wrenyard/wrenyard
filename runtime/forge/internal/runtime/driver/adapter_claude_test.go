package driver

import (
	"os"
	"path/filepath"
	"testing"
)

func TestClaudeAdapterParseSessionID(t *testing.T) {
	path := writeAdapterLog(t, `{"type":"assistant","message":{"content":[{"type":"text","text":"nope"}]}}
not-json
{"type":"system","subtype":"init","session_id":"session-init"}
{"type":"result","result":{"session_id":"session-result"}}
`)

	sessionID, err := (&ClaudeAdapter{}).ParseSessionID(path)
	if err != nil {
		t.Fatal(err)
	}
	if sessionID != "session-init" {
		t.Fatalf("session id = %q, want session-init", sessionID)
	}
}

func TestClaudeAdapterParseSessionIDResultFallback(t *testing.T) {
	path := writeAdapterLog(t, `{"type":"result","session_id":"sess-error","is_error":true}
{"type":"result","session_id":"sess-abc","is_error":false}`)

	sessionID, err := (&ClaudeAdapter{}).ParseSessionID(path)
	if err != nil {
		t.Fatal(err)
	}
	if sessionID != "sess-abc" {
		t.Fatalf("session id = %q, want sess-abc", sessionID)
	}
}

func TestClaudeAdapterParseSessionIDMissing(t *testing.T) {
	path := writeAdapterLog(t, `not-json
{"type":"system","subtype":"other","session_id":"not-the-session"}`)
	if _, err := (&ClaudeAdapter{}).ParseSessionID(path); err == nil {
		t.Fatal("expected missing session id to fail")
	}
}

func TestClaudeAdapterParseResultUsesLatestAssistantText(t *testing.T) {
	path := writeAdapterLog(t, `{"type":"assistant","message":{"content":[{"type":"text","text":"old answer"}]}}
{"type":"assistant","message":{"content":[{"type":"tool_use","name":"x"}]}}
{"type":"assistant","message":{"content":[{"type":"text","text":"latest "},{"type":"text","text":"answer"}]}}`)

	result, err := (&ClaudeAdapter{}).ParseResult(path)
	if err != nil {
		t.Fatal(err)
	}
	if result != "latest answer" {
		t.Fatalf("result = %q, want latest answer", result)
	}
}

func TestClaudeAdapterParseResultPrefersFinalResultEvent(t *testing.T) {
	path := writeAdapterLog(t, `{"type":"assistant","message":{"content":[{"type":"text","text":"Let me read the file..."}]}}
{"type":"assistant","message":{"content":[{"type":"tool_use","name":"x"}]}}
{"type":"result","result":"Task completed: fixed 3 bugs"}
`)

	result, err := (&ClaudeAdapter{}).ParseResult(path)
	if err != nil {
		t.Fatal(err)
	}
	if result != "Task completed: fixed 3 bugs" {
		t.Fatalf("result = %q, want final result event", result)
	}
}

func writeAdapterLog(t *testing.T, content string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "session.log")
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}
