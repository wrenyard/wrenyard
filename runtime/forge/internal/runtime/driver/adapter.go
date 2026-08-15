package driver

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"strings"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/catalog"
)

type CommandOptions struct {
	Clean      bool
	Permission catalog.PermissionMode
}

const maxJSONLLineBytes = 32 * 1024 * 1024

func readJSONLFile(path string) ([]map[string]any, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("open log file %q: %w", path, err)
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 0, 64*1024), maxJSONLLineBytes)

	var events []map[string]any
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}

		var event map[string]any
		if err := json.Unmarshal([]byte(line), &event); err != nil {
			continue
		}
		events = append(events, event)
	}

	if err := scanner.Err(); err != nil {
		return nil, err
	}
	return events, nil
}

func getString(data map[string]any, key string) (string, bool) {
	raw, ok := data[key]
	if !ok {
		return "", false
	}
	v, ok := raw.(string)
	return v, ok && v != ""
}

func getBool(data map[string]any, key string) (bool, bool) {
	raw, ok := data[key]
	if !ok {
		return false, false
	}
	v, ok := raw.(bool)
	return v, ok
}

func jsonStringValue(value any) string {
	if value == nil {
		return ""
	}
	if text, ok := value.(string); ok {
		return text
	}
	data, err := json.Marshal(value)
	if err != nil {
		return ""
	}
	return string(data)
}
