package driver

import (
	"bufio"
	"fmt"
	"os"
	"strings"
)

type OpenCodeAdapter struct{}

// ParseSessionID extracts the latest non-empty top-level session identifier
// (sessionID / session_id / sessionId) from an OpenCode transcript. It does not
// enable or claim resume support: OpenCode's dialect is not resume-capable, so
// the returned id is truthful metadata only.
func (a *OpenCodeAdapter) ParseSessionID(logPath string) (string, error) {
	events, err := readJSONLFile(logPath)
	if err != nil {
		return "", err
	}
	var sessionID string
	for _, event := range events {
		if id := strings.TrimSpace(openCodeTopLevelSessionID(event)); id != "" {
			sessionID = id
		}
	}
	if sessionID == "" {
		return "", fmt.Errorf("no opencode session id found in %s", logPath)
	}
	return sessionID, nil
}

func (a *OpenCodeAdapter) ParseResult(logPath string) (string, error) {
	events, err := readJSONLFile(logPath)
	if err != nil {
		return "", err
	}
	var result string
	for _, event := range events {
		for _, key := range []string{"message", "text", "content", "output"} {
			if text, ok := getString(event, key); ok {
				result = strings.TrimSpace(text)
			}
		}
		if text, ok := openCodeEventText(event); ok {
			result = strings.TrimSpace(text)
		}
	}
	if result != "" {
		return result, nil
	}

	f, err := os.Open(logPath)
	if err != nil {
		return "", err
	}
	defer f.Close()

	var lines []string
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 0, 64*1024), maxJSONLLineBytes)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		if strings.Contains(line, `"type":"rendered_prompt"`) {
			continue
		}
		lines = append(lines, line)
	}
	if err := scanner.Err(); err != nil {
		return "", err
	}
	return strings.Join(lines, "\n"), nil
}

func openCodeEventText(event map[string]any) (string, bool) {
	part, ok := event["part"].(map[string]any)
	if !ok {
		return "", false
	}
	text, ok := getString(part, "text")
	return text, ok
}
