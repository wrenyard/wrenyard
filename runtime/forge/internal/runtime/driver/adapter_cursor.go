package driver

import (
	"fmt"
	"strings"
)

// CursorAdapter parses the installed Cursor agent stream-json transcript.
type CursorAdapter struct{}

func (a *CursorAdapter) ParseSessionID(logPath string) (string, error) {
	events, err := readJSONLFile(logPath)
	if err != nil {
		return "", err
	}
	var sessionID string
	for _, event := range events {
		if id := cursorSessionID(event); id != "" {
			sessionID = id
		}
	}
	if sessionID == "" {
		return "", fmt.Errorf("no Cursor session id found in %s", logPath)
	}
	return sessionID, nil
}

func (a *CursorAdapter) ParseResult(logPath string) (string, error) {
	events, err := readJSONLFile(logPath)
	if err != nil {
		return "", err
	}
	var result strings.Builder
	for _, event := range events {
		// Aggregate assistant text, but only surface a bounded final result so
		// native payload details never leak wholesale into the summary.
		for _, normalized := range cursorNormalizerMap(event) {
			if normalized.Type != "message" {
				continue
			}
			if text, ok := normalized.Data["text"].(string); ok && text != "" {
				result.WriteString(text)
			}
		}
	}
	return strings.TrimSpace(result.String()), nil
}
