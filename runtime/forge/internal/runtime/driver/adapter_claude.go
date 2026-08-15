package driver

import (
	"fmt"
	"strings"
)

type ClaudeAdapter struct{}

func (a *ClaudeAdapter) ParseSessionID(logPath string) (string, error) {
	events, err := readJSONLFile(logPath)
	if err != nil {
		return "", err
	}

	var fallback string
	for _, event := range events {
		typ, hasType := getString(event, "type")
		if !hasType {
			continue
		}

		if typ == "system" {
			if subtype, hasSubtype := getString(event, "subtype"); hasSubtype && subtype == "init" {
				if sessionID, ok := getString(event, "session_id"); ok {
					return sessionID, nil
				}
			}
			continue
		}

		if typ != "result" {
			continue
		}
		if isError, hasIsError := getBool(event, "is_error"); hasIsError && isError {
			continue
		}

		if sessionID, ok := getString(event, "session_id"); ok {
			fallback = sessionID
			continue
		}

		result, ok := event["result"].(map[string]any)
		if ok {
			if sessionID, ok := getString(result, "session_id"); ok {
				fallback = sessionID
			}
		}
	}

	if fallback == "" {
		return "", fmt.Errorf("no session id found in %s", logPath)
	}
	return fallback, nil
}

func (a *ClaudeAdapter) ParseResult(logPath string) (string, error) {
	events, err := readJSONLFile(logPath)
	if err != nil {
		return "", err
	}

	result := ""
	for _, event := range events {
		typ, hasType := getString(event, "type")

		// "result" events carry the session result and take precedence over
		// raw assistant text (which may be tool-lead-in fragments).
		if hasType && typ == "result" {
			if text, ok := getString(event, "result"); ok && text != "" {
				result = text
			}
			continue
		}

		if !hasType || typ != "assistant" {
			continue
		}

		message, ok := event["message"].(map[string]any)
		if !ok {
			continue
		}

		content, ok := message["content"].([]any)
		if !ok {
			continue
		}

		var blocks []string
		for _, raw := range content {
			block, ok := raw.(map[string]any)
			if !ok {
				continue
			}
			blockType, ok := getString(block, "type")
			if !ok || blockType != "text" {
				continue
			}

			text, ok := getString(block, "text")
			if ok {
				blocks = append(blocks, text)
			}
		}
		if len(blocks) > 0 {
			result = strings.Join(blocks, "")
		}
	}

	return result, nil
}
