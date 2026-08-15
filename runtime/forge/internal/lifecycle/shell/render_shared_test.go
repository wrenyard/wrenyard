package shell

import (
	"encoding/json"
	"reflect"
	"testing"
)

func TestClaudeShortcutCommandIncludesInteractiveArgs(t *testing.T) {
	p := Profile{
		Client: "claude",
		Launcher: map[string]interface{}{
			"command":          "claude",
			"interactive_args": []interface{}{"agents", "--permission-mode", "bypassPermissions"},
		},
	}

	got := claudeShortcutCommand(p)
	want := []string{"claude", "agents", "--permission-mode", "bypassPermissions"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("claudeShortcutCommand() = %#v, want %#v", got, want)
	}
}

// TestClaudeSettingsIncludeStatusLineCommand is a regression test for the
// managed Claude settings generation: generated settings must include a
// statusLine block of type "command" whose command is exactly
// "forge statusline --claude-code".
func TestClaudeSettingsIncludeStatusLineCommand(t *testing.T) {
	p := Profile{Name: "cc-kimi"}
	got := claudeSettingsJSON(p, map[string]string{"FORGE_PROFILE": "cc-kimi"})

	var probe struct {
		StatusLine struct {
			Type    string `json:"type"`
			Command string `json:"command"`
		} `json:"statusLine"`
	}
	if err := json.Unmarshal([]byte(got), &probe); err != nil {
		t.Fatalf("claudeSettingsJSON produced invalid JSON: %v\n%s", err, got)
	}
	if probe.StatusLine.Type != "command" {
		t.Fatalf("claude settings statusLine.type = %q, want %q", probe.StatusLine.Type, "command")
	}
	if probe.StatusLine.Command != "forge statusline --claude-code" {
		t.Fatalf("claude settings statusLine.command = %q, want %q", probe.StatusLine.Command, "forge statusline --claude-code")
	}
}
