package forge

import "testing"

func TestShellExecRetired(t *testing.T) {
	if code := shellCommand([]string{"exec", "cc-kimi", "--", "claude"}); code != 2 {
		t.Fatalf("shellCommand returned %d, want 2 for retired Agent shell exec", code)
	}
}
