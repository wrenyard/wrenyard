package grok

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"unicode"
	"unicode/utf8"
)

const (
	maxToolHistoryBytes       = 32 * 1024 * 1024
	maxToolHistoryRecordBytes = 8 * 1024 * 1024
	maxToolCallsPerTurn       = 256
	maxToolIdentifierBytes    = 256
	maxToolInputSummaryBytes  = 512
)

// ToolCall is the public-safe subset of a native Grok use_tool record. Grok
// 0.2.106 does not emit these records on its streaming-json stdout, but does
// persist them in the current native session's chat_history.jsonl.
type ToolCall struct {
	Name         string
	CallID       string
	InputSummary string
}

// CurrentTurnToolCalls reads only the requested native session under the
// supplied per-run Grok Home and returns use_tool calls after the final user
// record carrying a prompt_index. This turn boundary prevents restored resume
// history from being replayed. Callers should treat any error as best-effort
// extraction failure and leave the child result unchanged.
func CurrentTurnToolCalls(runHome, nativeSessionID string) ([]ToolCall, error) {
	id, err := normalizeNativeSessionID(nativeSessionID)
	if err != nil {
		return nil, err
	}
	location, err := findRunHomeSession(runHome, id)
	if err != nil {
		return nil, err
	}
	historyPath := filepath.Join(location.sessionDir, "chat_history.jsonl")
	if err := validateRegularFile(historyPath); err != nil {
		return nil, fmt.Errorf("invalid current Grok chat history: %w", err)
	}

	file, err := os.Open(historyPath)
	if err != nil {
		return nil, fmt.Errorf("open current Grok chat history: %w", err)
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() <= 0 || info.Size() > maxToolHistoryBytes {
		return nil, fmt.Errorf("current Grok chat history has invalid size or type")
	}
	data, err := io.ReadAll(io.LimitReader(file, maxToolHistoryBytes+1))
	if err != nil || len(data) == 0 || len(data) > maxToolHistoryBytes {
		return nil, fmt.Errorf("read current Grok chat history within limit")
	}
	if !utf8.Valid(data) {
		return nil, fmt.Errorf("current Grok chat history is not valid UTF-8")
	}

	return parseCurrentTurnToolCalls(data)
}

func parseCurrentTurnToolCalls(data []byte) ([]ToolCall, error) {
	scanner := bufio.NewScanner(bytes.NewReader(data))
	scanner.Buffer(make([]byte, 0, 64*1024), maxToolHistoryRecordBytes)
	seenPrompt := false
	seenCallIDs := map[string]bool{}
	var calls []ToolCall
	lineNumber := 0
	for scanner.Scan() {
		lineNumber++
		line := bytes.TrimSpace(scanner.Bytes())
		if len(line) == 0 {
			continue
		}
		if !utf8.Valid(line) {
			return nil, fmt.Errorf("current Grok chat history record %d is not valid UTF-8", lineNumber)
		}
		var record map[string]json.RawMessage
		if err := json.Unmarshal(line, &record); err != nil || record == nil {
			return nil, fmt.Errorf("current Grok chat history record %d is malformed", lineNumber)
		}
		var recordType string
		if err := json.Unmarshal(record["type"], &recordType); err != nil {
			continue
		}
		if recordType == "user" && validPromptIndex(record["prompt_index"]) {
			// A restored session contains earlier complete turns. Reset at each
			// prompt marker so only the final prompt turn can escape the native
			// history boundary.
			seenPrompt = true
			calls = nil
			seenCallIDs = map[string]bool{}
			continue
		}
		if !seenPrompt || recordType != "assistant" {
			continue
		}
		toolCallsRaw, ok := record["tool_calls"]
		if !ok || bytes.Equal(bytes.TrimSpace(toolCallsRaw), []byte("null")) {
			continue
		}
		var nativeCalls []json.RawMessage
		if err := json.Unmarshal(toolCallsRaw, &nativeCalls); err != nil {
			return nil, fmt.Errorf("current Grok chat history record %d has malformed tool_calls", lineNumber)
		}
		if len(nativeCalls) > maxToolCallsPerTurn {
			return nil, fmt.Errorf("current Grok chat history record %d exceeds tool call limit", lineNumber)
		}
		for _, rawCall := range nativeCalls {
			call, ok := parseNativeUseToolCall(rawCall)
			if !ok || seenCallIDs[call.CallID] {
				continue
			}
			if len(calls) >= maxToolCallsPerTurn {
				return nil, fmt.Errorf("current Grok prompt turn exceeds tool call limit")
			}
			seenCallIDs[call.CallID] = true
			calls = append(calls, call)
		}
	}
	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("scan current Grok chat history: %w", err)
	}
	if !seenPrompt {
		return nil, fmt.Errorf("current Grok chat history has no prompt turn marker")
	}
	return calls, nil
}

func validPromptIndex(raw json.RawMessage) bool {
	if len(raw) == 0 {
		return false
	}
	var index int64
	return json.Unmarshal(raw, &index) == nil && index >= 0
}

func parseNativeUseToolCall(raw json.RawMessage) (ToolCall, bool) {
	var nativeCall map[string]json.RawMessage
	if err := json.Unmarshal(raw, &nativeCall); err != nil || nativeCall == nil {
		return ToolCall{}, false
	}
	var wrapperName string
	if err := json.Unmarshal(nativeCall["name"], &wrapperName); err != nil || wrapperName != "use_tool" {
		// In particular, Grok's native search_tool is not an MCP tool call and
		// must not be projected onto Forge's public tool_call protocol.
		return ToolCall{}, false
	}
	var callID, arguments string
	if err := json.Unmarshal(nativeCall["id"], &callID); err != nil {
		return ToolCall{}, false
	}
	if err := json.Unmarshal(nativeCall["arguments"], &arguments); err != nil {
		return ToolCall{}, false
	}
	callID, ok := sanitizeToolIdentifier(callID)
	if !ok {
		return ToolCall{}, false
	}

	var decoded map[string]json.RawMessage
	if err := json.Unmarshal([]byte(arguments), &decoded); err != nil || decoded == nil {
		return ToolCall{}, false
	}
	var toolName string
	if err := json.Unmarshal(decoded["tool_name"], &toolName); err != nil {
		return ToolCall{}, false
	}
	toolName, ok = sanitizeToolIdentifier(toolName)
	if !ok || toolName == "search_tool" {
		return ToolCall{}, false
	}
	toolInput, ok := decoded["tool_input"]
	if !ok || len(bytes.TrimSpace(toolInput)) == 0 {
		return ToolCall{}, false
	}
	summary, ok := sanitizedToolInputSummary(toolInput)
	if !ok {
		return ToolCall{}, false
	}
	return ToolCall{Name: toolName, CallID: callID, InputSummary: summary}, true
}

func sanitizeToolIdentifier(value string) (string, bool) {
	value = strings.TrimSpace(value)
	if value == "" || len(value) > maxToolIdentifierBytes || !utf8.ValidString(value) {
		return "", false
	}
	for _, r := range value {
		if unicode.IsControl(r) {
			return "", false
		}
	}
	return value, true
}

func sanitizedToolInputSummary(raw json.RawMessage) (string, bool) {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return "", false
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return "", false
	}
	encoded, err := json.Marshal(value)
	if err != nil || !utf8.Valid(encoded) {
		return "", false
	}
	if len(encoded) > maxToolInputSummaryBytes {
		encoded = validUTF8Prefix(encoded, maxToolInputSummaryBytes)
	}
	return string(encoded), true
}

func validUTF8Prefix(value []byte, maxBytes int) []byte {
	if len(value) <= maxBytes {
		return value
	}
	end := maxBytes
	for end > 0 && !utf8.Valid(value[:end]) {
		end--
	}
	return value[:end]
}
