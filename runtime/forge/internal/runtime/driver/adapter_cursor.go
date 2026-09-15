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
	// The installed CLI replays accumulated assistant text as aggregate
	// summary flushes after the partial deltas. The same shared lookahead
	// helper the streaming Tee uses observes every parsed record and owns all
	// text reconstruction, so a --stream-partial-output transcript never
	// doubles its text.
	var deduper cursorAssistantTextDeduper
	for _, event := range events {
		result.WriteString(deduper.observe(event))
	}
	// Flush text still held pending for a truncated transcript.
	result.WriteString(deduper.finish())
	return strings.TrimSpace(result.String()), nil
}
