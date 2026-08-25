package auth

import (
	"database/sql"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/providers/cursor"
)

// cursorCatalogAuthResolver maps the "cursor" provider id to the Cursor
// native credential resolver.
func cursorCatalogAuthResolver(providerID string) (CredentialResolverKind, bool) {
	if providerID == "cursor" {
		return ResolverCursor, true
	}
	return "", false
}

// writeCursorStateDB creates a state.vscdb under home at the platform
// location resolved by the shared helper, storing value under the access-token
// key.
func writeCursorStateDB(t *testing.T, home, value string) string {
	t.Helper()
	path := cursor.StatePath(home)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT);"); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec("INSERT INTO ItemTable (key, value) VALUES (?, ?)", "cursorAuth/accessToken", value); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestProviderAuthStatusCursorAuthenticated(t *testing.T) {
	home := t.TempDir()
	writeCursorStateDB(t, home, "cursor-test-access-token")

	resolver := NewProviderAuthStatusResolver(
		cursorCatalogAuthResolver,
		func() string { return t.TempDir() },
		func() string { return home },
	)
	status := resolver.ProviderAuthStatus("cursor")
	if !status.OK {
		t.Fatalf("cursor should be authenticated, got status: %+v", status)
	}
	if status.Kind != ResolverCursor {
		t.Fatalf("expected cursor resolver, got %s", status.Kind)
	}
	// Status must never expose the token value.
	if strings.Contains(status.SourcePath, "cursor-test-access-token") {
		t.Fatalf("status leaked token via SourcePath: %q", status.SourcePath)
	}
	if strings.Contains(status.Detail, "cursor-test-access-token") {
		t.Fatalf("status leaked token via Detail: %q", status.Detail)
	}
}

func TestProviderAuthStatusCursorMissing(t *testing.T) {
	home := t.TempDir()
	resolver := NewProviderAuthStatusResolver(
		cursorCatalogAuthResolver,
		func() string { return t.TempDir() },
		func() string { return home },
	)
	status := resolver.ProviderAuthStatus("cursor")
	if status.OK {
		t.Fatal("cursor should NOT be authenticated without state.vscdb")
	}
	cred, ok := resolver.Credential("cursor")
	if ok {
		t.Fatalf("cursor credential should not resolve without state.vscdb, got: %+v", cred)
	}
	if cred != nil {
		t.Fatal("cursor credential pointer should be nil when ok is false")
	}
}

func TestProviderAuthStatusCursorCredentialOnlyValue(t *testing.T) {
	home := t.TempDir()
	writeCursorStateDB(t, home, "cursor-cred-value")

	resolver := NewProviderAuthStatusResolver(
		cursorCatalogAuthResolver,
		func() string { return t.TempDir() },
		func() string { return home },
	)
	cred, ok := resolver.Credential("cursor")
	if !ok {
		t.Fatal("cursor credential should be available")
	}
	if cred.Value != "cursor-cred-value" {
		t.Fatalf("cursor credential value = %q, want cursor-cred-value", cred.Value)
	}
	if cred.Headers != nil && len(cred.Headers) > 0 {
		t.Fatalf("cursor credential must carry no extra headers, got %v", cred.Headers)
	}
	headers := resolver.Headers("cursor")
	if headers.Get("Authorization") != "Bearer cursor-cred-value" {
		t.Fatalf("Authorization header = %q, want Bearer cursor-cred-value", headers.Get("Authorization"))
	}
}
