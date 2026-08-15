package driver

import (
	"fmt"
	"strings"
)

// GrokAdapter parses the installed Grok Build streaming-json transcript.
type GrokAdapter struct{}

func (a *GrokAdapter) ParseSessionID(logPath string) (string, error) {
	events, err := readJSONLFile(logPath)
	if err != nil {
		return "", err
	}
	var sessionID string
	for _, event := range events {
		if id := grokSessionID(event); id != "" {
			sessionID = id
		}
	}
	if sessionID == "" {
		return "", fmt.Errorf("no Grok session id found in %s", logPath)
	}
	return sessionID, nil
}

func (a *GrokAdapter) ParseResult(logPath string) (string, error) {
	events, err := readJSONLFile(logPath)
	if err != nil {
		return "", err
	}
	result := ""
	for _, event := range events {
		typ, _ := getString(event, "type")
		typ = strings.ToLower(strings.TrimSpace(typ))
		for _, normalized := range grokNormalizerMap(event) {
			if normalized.Type == "message" {
				if text, ok := normalized.Data["text"].(string); ok && text != "" {
					switch typ {
					case "result", "run_finished", "done", "complete", "completed":
						result = text
					default:
						result += text
					}
				}
			}
		}
	}
	return strings.TrimSpace(result), nil
}
