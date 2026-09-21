package shell

import (
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
