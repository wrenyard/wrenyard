package grok

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"unicode/utf8"
)

func writeToolHistory(t *testing.T, home, nativeID string, data []byte) string {
	t.Helper()
	sessionDir := filepath.Join(home, "sessions", "encoded-workspace", nativeID)
	if err := os.MkdirAll(sessionDir, 0o700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(sessionDir, "chat_history.jsonl")
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func nativeToolCallLine(t *testing.T, recordType string, promptIndex *int, calls ...map[string]any) []byte {
	t.Helper()
	record := map[string]any{"type": recordType}
	if promptIndex != nil {
		record["prompt_index"] = *promptIndex
	}
	if calls != nil {
		record["tool_calls"] = calls
	}
	data, err := json.Marshal(record)
	if err != nil {
		t.Fatal(err)
	}
	return append(data, '\n')
}

func useToolFixture(t *testing.T, id, name string, input any) map[string]any {
	t.Helper()
	arguments, err := json.Marshal(map[string]any{"tool_name": name, "tool_input": input})
	if err != nil {
		t.Fatal(err)
	}
	return map[string]any{"id": id, "name": "use_tool", "arguments": string(arguments)}
}

func TestCurrentTurnToolCallsMatchesGrok02106Fixture(t *testing.T) {
	home := t.TempDir()
	nativeID := "019f8949-3de2-7ff3-95a0-d18f64323525"
	fixture, err := os.ReadFile(filepath.Join("testdata", "grok_0_2_106_tool_history.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	writeToolHistory(t, home, nativeID, fixture)

	calls, err := CurrentTurnToolCalls(home, nativeID)
	if err != nil {
		t.Fatal(err)
	}
	if len(calls) != 1 {
		t.Fatalf("calls = %+v, want one native use_tool call", calls)
	}
	got := calls[0]
	if got.Name != "ure__ure_probe" || got.CallID != "call-native-1" || got.InputSummary != `{"question":"probe"}` {
		t.Fatalf("call = %+v", got)
	}
	if strings.Contains(got.InputSummary, "PRIVATE_NATIVE_REASONING") || strings.Contains(got.Name, "search") {
		t.Fatalf("private reasoning or native search escaped: %+v", got)
	}
}

func TestCurrentTurnToolCallsResumeDoesNotReplayEarlierTurn(t *testing.T) {
	home := t.TempDir()
	nativeID := "resume-native"
	oldIndex, newIndex := 0, 1
	var history []byte
	history = append(history, nativeToolCallLine(t, "user", &oldIndex)...)
	history = append(history, nativeToolCallLine(t, "assistant", nil, useToolFixture(t, "old-call", "ure__old", map[string]any{"old": true}))...)
	history = append(history, nativeToolCallLine(t, "user", &newIndex)...)
	history = append(history, nativeToolCallLine(t, "reasoning", nil)...)
	history = append(history, nativeToolCallLine(t, "assistant", nil,
		map[string]any{"id": "search-call", "name": "search_tool", "arguments": `{"query":"ignored"}`},
		useToolFixture(t, "new-call", "ure__new", map[string]any{"fresh": true}),
		useToolFixture(t, "new-call", "ure__new", map[string]any{"duplicate": true}),
	)...)
	writeToolHistory(t, home, nativeID, history)

	calls, err := CurrentTurnToolCalls(home, nativeID)
	if err != nil {
		t.Fatal(err)
	}
	if len(calls) != 1 || calls[0].CallID != "new-call" || calls[0].Name != "ure__new" || strings.Contains(calls[0].InputSummary, "old") {
		t.Fatalf("calls = %+v, want only the final prompt turn", calls)
	}
}

func TestCurrentTurnToolCallsSanitizesAndBoundsUntrustedRecords(t *testing.T) {
	home := t.TempDir()
	nativeID := "bounded-native"
	index := 0
	privateThought := "DO_NOT_EXPOSE_NATIVE_THOUGHT"
	var history []byte
	history = append(history, nativeToolCallLine(t, "user", &index)...)
	reasoning, _ := json.Marshal(map[string]any{"type": "reasoning", "thought": privateThought})
	history = append(history, reasoning...)
	history = append(history, '\n')
	history = append(history, nativeToolCallLine(t, "assistant", nil,
		map[string]any{"id": "bad\ncall", "name": "use_tool", "arguments": `{"tool_name":"ure__bad","tool_input":{}}`},
		map[string]any{"id": "bad-arguments", "name": "use_tool", "arguments": `{`},
		map[string]any{"id": "inner-search", "name": "use_tool", "arguments": `{"tool_name":"search_tool","tool_input":{}}`},
		useToolFixture(t, "bounded-call", "ure__bounded", map[string]any{"text": strings.Repeat("界", 400), "control": "line\nnext"}),
	)...)
	writeToolHistory(t, home, nativeID, history)

	calls, err := CurrentTurnToolCalls(home, nativeID)
	if err != nil {
		t.Fatal(err)
	}
	if len(calls) != 1 || calls[0].CallID != "bounded-call" {
		t.Fatalf("calls = %+v", calls)
	}
	if len(calls[0].InputSummary) > maxToolInputSummaryBytes || !utf8.ValidString(calls[0].InputSummary) {
		t.Fatalf("summary is not a bounded UTF-8 value: len=%d value=%q", len(calls[0].InputSummary), calls[0].InputSummary)
	}
	if strings.Contains(calls[0].InputSummary, privateThought) || strings.ContainsRune(calls[0].InputSummary, '\n') {
		t.Fatalf("summary exposed private/native control content: %q", calls[0].InputSummary)
	}
}

func TestCurrentTurnToolCallsRejectsMalformedUnsafeOrWrongSessionHistory(t *testing.T) {
	t.Run("malformed JSONL", func(t *testing.T) {
		home := t.TempDir()
		writeToolHistory(t, home, "native", []byte("{\"type\":\"user\",\"prompt_index\":0}\n{\n"))
		if calls, err := CurrentTurnToolCalls(home, "native"); err == nil || len(calls) != 0 {
			t.Fatalf("calls=%+v err=%v", calls, err)
		}
	})

	t.Run("invalid UTF-8", func(t *testing.T) {
		home := t.TempDir()
		writeToolHistory(t, home, "native", []byte{'{', 0xff, '}'})
		if calls, err := CurrentTurnToolCalls(home, "native"); err == nil || len(calls) != 0 {
			t.Fatalf("calls=%+v err=%v", calls, err)
		}
	})

	t.Run("oversized file", func(t *testing.T) {
		home := t.TempDir()
		path := writeToolHistory(t, home, "native", []byte("{}"))
		if err := os.Truncate(path, maxToolHistoryBytes+1); err != nil {
			t.Fatal(err)
		}
		if calls, err := CurrentTurnToolCalls(home, "native"); err == nil || len(calls) != 0 {
			t.Fatalf("calls=%+v err=%v", calls, err)
		}
	})

	t.Run("requested session only", func(t *testing.T) {
		home := t.TempDir()
		index := 0
		secretHistory := append(nativeToolCallLine(t, "user", &index), nativeToolCallLine(t, "assistant", nil, useToolFixture(t, "secret", "ure__secret", map[string]any{}))...)
		writeToolHistory(t, home, "other-native", secretHistory)
		writeToolHistory(t, home, "current-native", nativeToolCallLine(t, "user", &index))
		calls, err := CurrentTurnToolCalls(home, "current-native")
		if err != nil || len(calls) != 0 {
			t.Fatalf("calls=%+v err=%v", calls, err)
		}
		if _, err := CurrentTurnToolCalls(home, "../other-native"); err == nil {
			t.Fatal("path-like native id unexpectedly resolved")
		}
	})

	t.Run("record limit", func(t *testing.T) {
		_, err := parseCurrentTurnToolCalls(bytes.Repeat([]byte("x"), maxToolHistoryRecordBytes+1))
		if err == nil {
			t.Fatal("oversized record unexpectedly parsed")
		}
	})
}
