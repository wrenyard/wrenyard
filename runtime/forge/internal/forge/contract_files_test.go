package forge

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestEnsureGitignoreEntry(t *testing.T) {
	dir := t.TempDir()
	gitignorePath := filepath.Join(dir, ".gitignore")

	if err := ensureGitignoreEntry(gitignorePath, "data/secrets.json"); err != nil {
		t.Fatal(err)
	}
	content := readTextIfExists(gitignorePath)
	if !strings.Contains(content, "data/secrets.json") {
		t.Fatalf(".gitignore should contain data/secrets.json: %q", content)
	}

	if err := ensureGitignoreEntry(gitignorePath, "data/secrets.json"); err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(readTextIfExists(gitignorePath)), "\n")
	count := 0
	for _, line := range lines {
		if strings.TrimSpace(line) == "data/secrets.json" {
			count++
		}
	}
	if count != 1 {
		t.Fatalf("data/secrets.json should appear exactly once in .gitignore, got %d", count)
	}

	// Sub-case: existing .gitignore with content lacking a trailing newline.
	t.Run("no trailing newline", func(t *testing.T) {
		dir2 := t.TempDir()
		path := filepath.Join(dir2, ".gitignore")
		if err := os.WriteFile(path, []byte("*.log"), 0o644); err != nil {
			t.Fatal(err)
		}
		if err := ensureGitignoreEntry(path, "data/secrets.json"); err != nil {
			t.Fatal(err)
		}
		got := readTextIfExists(path)
		if !strings.Contains(got, "data/secrets.json") {
			t.Fatalf(".gitignore should contain data/secrets.json: %q", got)
		}
		if !strings.HasSuffix(got, "data/secrets.json\n") {
			t.Fatalf("data/secrets.json should be on its own line at end of .gitignore: %q", got)
		}
		lines := strings.Split(got, "\n")
		foundLog := false
		foundSecrets := false
		for _, line := range lines {
			line = strings.TrimSpace(line)
			if line == "*.log" {
				foundLog = true
			}
			if line == "data/secrets.json" {
				foundSecrets = true
			}
		}
		if !foundLog || !foundSecrets {
			t.Fatalf(".gitignore should preserve *.log and add data/secrets.json on its own line: %q", got)
		}
	})
}
