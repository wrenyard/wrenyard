package change

import (
	"os"
	"path/filepath"
	"testing"
)

func TestApplyFileDeleteBacksUpBeforeRemoval(t *testing.T) {
	home := t.TempDir()
	t.Setenv("XDG_STATE_HOME", "")
	target := filepath.Join(home, "managed", "wrenyard.zsh")
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(target, []byte("generated\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	result := Apply(Plan{
		Name:    "retire-managed-file",
		Actions: []Action{{Type: "file_delete", File: &FileWrite{Path: target}}},
	}, false, Dependencies{
		Home:   home,
		Redact: func(value any) any { return value },
	})
	if !result.Succeeded {
		t.Fatalf("delete result should succeed: %#v", result)
	}
	if _, err := os.Stat(target); !os.IsNotExist(err) {
		t.Fatalf("target should be removed, stat error=%v", err)
	}
	backup, ok := result.Entries[0]["backup_path"].(string)
	if !ok || backup == "" {
		t.Fatalf("delete entry should record a backup path: %#v", result.Entries[0])
	}
	content, err := os.ReadFile(backup)
	if err != nil {
		t.Fatal(err)
	}
	if string(content) != "generated\n" {
		t.Fatalf("backup content=%q", content)
	}
}
