package cursor

import (
	"database/sql"
	"os"
	"path/filepath"
	"strings"
	"testing"

	_ "modernc.org/sqlite"
)

// writeTestStateDB creates a state.vscdb in dir with an ItemTable row for the
// given key/value and returns its path.
func writeTestStateDB(t *testing.T, dir, value string) string {
	t.Helper()
	path := filepath.Join(dir, "state.vscdb")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT);"); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec("INSERT INTO ItemTable (key, value) VALUES (?, ?)", accessTokenKey, value); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestAccessTokenReadsStoredToken(t *testing.T) {
	path := writeTestStateDB(t, t.TempDir(), "cursor-test-token")
	got, err := AccessToken(path)
	if err != nil {
		t.Fatalf("AccessToken: %v", err)
	}
	if got != "cursor-test-token" {
		t.Fatalf("AccessToken = %q, want cursor-test-token", got)
	}
}

func TestAccessTokenMissingFile(t *testing.T) {
	_, err := AccessToken(filepath.Join(t.TempDir(), "does-not-exist.vscdb"))
	if err == nil {
		t.Fatal("expected error for missing state.vscdb")
	}
	if strings.Contains(err.Error(), "cursor-test-token") {
		t.Fatalf("error must not leak a token: %v", err)
	}
}

func TestAccessTokenEmptyPath(t *testing.T) {
	if _, err := AccessToken(""); err == nil {
		t.Fatal("expected error for empty state path")
	}
}

func TestAccessTokenMissingKey(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.vscdb")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT);"); err != nil {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	_, err = AccessToken(path)
	if err == nil {
		t.Fatal("expected error when access token key is absent")
	}
}

func TestAccessTokenErrorDoesNotLeakToken(t *testing.T) {
	// A malformed database must yield a sanitized error that never contains
	// the token material.
	path := filepath.Join(t.TempDir(), "state.vscdb")
	secret := "cursor-secret-token-xyz"
	if err := os.WriteFile(path, []byte(secret), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err := AccessToken(path)
	if err == nil {
		t.Fatal("expected error for malformed state.vscdb")
	}
	if strings.Contains(err.Error(), secret) {
		t.Fatalf("malformed-db error leaked token: %v", err)
	}
}

func TestStatePathHonorsHome(t *testing.T) {
	home := t.TempDir()
	path := StatePath(home)
	if !strings.Contains(path, home) {
		t.Fatalf("StatePath(%q) = %q, want it under home", home, path)
	}
	if !strings.HasSuffix(path, "state.vscdb") {
		t.Fatalf("StatePath = %q, want state.vscdb suffix", path)
	}
}
