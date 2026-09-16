package driver

import "strings"

// App-server item translation. The interactive protocol uses camelCase item
// types and field names, while normalize.go's codexNormalizer consumes the
// one-shot `codex exec` wire schema (snake_case). This file is the only place
// that converts between them, so the normalizer stays the single source of
// normalized content and both transports produce identical records.

// codexAppServerItemTypes maps every native app-server item type onto its exec
// schema equivalent. Unknown types are passed through lower-cased so a future
// native type still degrades to a jsonStringValue tool_result rather than
// disappearing.
var codexAppServerItemTypes = map[string]string{
	"agentMessage":      "agent_message",
	"commandExecution":  "command_execution",
	"mcpToolCall":       "mcp_tool_call",
	"fileChange":        "file_change",
	"webSearch":         "web_search",
	"reasoning":         "reasoning",
	"todoList":          "todo_list",
	"error":             "error",
	"localShellCall":    "local_shell_call",
	"customToolCall":    "custom_tool_call",
	"customToolCallOut": "custom_tool_call_output",
}

// codexExecItemType translates one native item type. A type already in the exec
// schema is returned unchanged so a mixed-version peer still works.
func codexExecItemType(nativeType string) string {
	nativeType = strings.TrimSpace(nativeType)
	if nativeType == "" {
		return ""
	}
	if translated, ok := codexAppServerItemTypes[nativeType]; ok {
		return translated
	}
	if strings.Contains(nativeType, "_") {
		return nativeType
	}
	return camelToSnake(nativeType)
}

// camelToSnake lowercases an identifier and inserts underscores at camelCase
// boundaries. Consecutive capitals (acronyms) stay grouped.
func camelToSnake(value string) string {
	var out strings.Builder
	out.Grow(len(value) + 4)
	for index, r := range value {
		if r >= 'A' && r <= 'Z' {
			if index > 0 {
				previous := rune(value[index-1])
				nextIsLower := index+1 < len(value) && value[index+1] >= 'a' && value[index+1] <= 'z'
				if previous >= 'a' && previous <= 'z' || previous >= '0' && previous <= '9' || nextIsLower {
					out.WriteByte('_')
				}
			}
			out.WriteRune(r + ('a' - 'A'))
			continue
		}
		out.WriteRune(r)
	}
	return out.String()
}

// translateAppServerItem rewrites one native item into the exec schema.
// Field names that the normalizer reads (command, aggregatedOutput, exitCode,
// changes, results, arguments, ...) are renamed to their snake_case forms; the
// id and the translated type are preserved.
func translateAppServerItem(item map[string]any) map[string]any {
	if item == nil {
		return nil
	}
	translated := make(map[string]any, len(item)+2)
	for key, value := range item {
		translated[key] = value
	}
	nativeType, _ := item["type"].(string)
	if execType := codexExecItemType(nativeType); execType != "" {
		translated["type"] = execType
	}
	// Alias the camelCase payload fields onto the exec schema names the
	// normalizer reads. The originals are left in place so an unrecognised
	// payload still serialises without loss.
	codexAliasField(item, translated, "aggregatedOutput", "aggregated_output")
	codexAliasField(item, translated, "exitCode", "exit_code")
	codexAliasField(item, translated, "toolName", "tool_name")
	codexAliasField(item, translated, "partialJson", "partial_json")
	codexAliasField(item, translated, "mimeType", "mime_type")
	codexAliasField(item, translated, "outputText", "output_text")
	// status is translated from the native lifecycle vocabulary when the
	// normalizer would otherwise treat it as unknown.
	if status, ok := item["status"].(string); ok {
		translated["status"] = codexExecStatus(status)
	}
	return translated
}

func codexAliasField(item, translated map[string]any, nativeKey, execKey string) {
	if _, exists := translated[execKey]; exists {
		return
	}
	if value, ok := item[nativeKey]; ok {
		translated[execKey] = value
	}
}

// codexExecStatus maps native lifecycle status words onto the exec schema.
func codexExecStatus(status string) string {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "inprogress", "in_progress", "running", "started", "pending":
		return "in_progress"
	case "completed", "complete", "success", "succeeded", "done":
		return "completed"
	case "failed", "error", "errored":
		return "failed"
	case "cancelled", "canceled", "aborted", "interrupted":
		return "cancelled"
	case "declined", "rejected":
		return "declined"
	default:
		return status
	}
}

// translateAppServerItemPayload rewrites a whole notification's item. When the
// payload has no item (thread-level or turn-level notifications) the params are
// returned unchanged.
func translateAppServerItemPayload(params map[string]any) map[string]any {
	item, ok := params["item"].(map[string]any)
	if !ok {
		return params
	}
	translated := make(map[string]any, len(params))
	for key, value := range params {
		translated[key] = value
	}
	translated["item"] = translateAppServerItem(item)
	return translated
}
