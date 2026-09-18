package auth

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

// withAtomicWrite wires the SafeAtomicWrite callback the same way the root
// forge package does, so the auth store can persist during unit tests.
func withAtomicWrite(t *testing.T) {
	t.Helper()
	previous := SafeAtomicWrite
	SafeAtomicWrite = func(target string, data []byte, perm os.FileMode) error {
		return os.WriteFile(target, data, perm)
	}
	t.Cleanup(func() { SafeAtomicWrite = previous })
}

func writeAuthFixture(t *testing.T, entries map[string]Entry) string {
	t.Helper()
	withAtomicWrite(t)
	path := filepath.Join(t.TempDir(), "auth.json")
	if err := Write(path, entries); err != nil {
		t.Fatal(err)
	}
	return path
}

func readAuthFixture(t *testing.T, path string) map[string]Entry {
	t.Helper()
	entries, err := Read(path)
	if err != nil {
		t.Fatal(err)
	}
	return entries
}

func TestMigrateLegacyProviderIDsMovesAPIKeyOnly(t *testing.T) {
	path := writeAuthFixture(t, map[string]Entry{
		"anthropic-api": {Type: "api", Key: "legacy-api-key"},
	})
	migrated, err := MigrateLegacyProviderIDs(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(migrated) != 1 || migrated[0] != "anthropic" {
		t.Fatalf("migrated = %v, want [anthropic]", migrated)
	}
	entries := readAuthFixture(t, path)
	if _, ok := entries["anthropic-api"]; ok {
		t.Fatal("legacy anthropic-api entry must be removed")
	}
	if got := entries["anthropic"]; got.Key != "legacy-api-key" || got.Type != "api" {
		t.Fatalf("anthropic entry = %#v, want the migrated api key", got)
	}
	if _, ok := entries["claude-coding"]; ok {
		t.Fatal("subscription identity must never be created from the API id")
	}
}

func TestMigrateLegacyProviderIDsNeverOverwritesCanonical(t *testing.T) {
	path := writeAuthFixture(t, map[string]Entry{
		"anthropic-api": {Type: "api", Key: "legacy-api-key"},
		"anthropic":     {Type: "api", Key: "new-api-key"},
	})
	migrated, err := MigrateLegacyProviderIDs(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(migrated) != 0 {
		t.Fatalf("migrated = %v, want none when the canonical entry exists", migrated)
	}
	entries := readAuthFixture(t, path)
	if got := entries["anthropic"].Key; got != "new-api-key" {
		t.Fatalf("anthropic key = %q, want the existing new-api-key", got)
	}
}

func TestMigrateLegacyProviderIDsNeverConvertsOAuthToAPIKey(t *testing.T) {
	path := writeAuthFixture(t, map[string]Entry{
		"anthropic-api": {Type: "oauth", Access: "oauth-access", Refresh: "oauth-refresh"},
	})
	migrated, err := MigrateLegacyProviderIDs(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(migrated) != 0 {
		t.Fatalf("migrated = %v, want none for a subscription oauth entry", migrated)
	}
	entries := readAuthFixture(t, path)
	if _, ok := entries["anthropic"]; ok {
		t.Fatal("an oauth credential must never become an anthropic API key")
	}
	if got := entries["anthropic-api"]; got.Type != "oauth" || got.Access != "oauth-access" {
		t.Fatalf("legacy oauth entry = %#v, want preserved", got)
	}
}

func TestMigrateLegacyProviderIDsRenamesOpencodeNative(t *testing.T) {
	path := writeAuthFixture(t, map[string]Entry{
		"opencode-native": {Type: "api", Key: "zen-key"},
	})
	migrated, err := MigrateLegacyProviderIDs(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(migrated) != 1 || migrated[0] != "opencode-zen" {
		t.Fatalf("migrated = %v, want [opencode-zen]", migrated)
	}
	if got := readAuthFixture(t, path)["opencode-zen"].Key; got != "zen-key" {
		t.Fatalf("opencode-zen key = %q, want zen-key", got)
	}
}

func TestMigrateLegacyProviderIDsIsIdempotentAndPreservesPerms(t *testing.T) {
	path := writeAuthFixture(t, map[string]Entry{
		"anthropic-api": {Type: "api", Key: "legacy-api-key"},
	})
	if _, err := MigrateLegacyProviderIDs(path); err != nil {
		t.Fatal(err)
	}
	// A second run must be a no-op.
	migrated, err := MigrateLegacyProviderIDs(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(migrated) != 0 {
		t.Fatalf("second migration = %v, want none", migrated)
	}
	if runtime.GOOS != "windows" {
		info, statErr := os.Stat(path)
		if statErr != nil {
			t.Fatal(statErr)
		}
		if info.Mode().Perm() != 0o600 {
			t.Fatalf("auth.json perms = %o, want 600", info.Mode().Perm())
		}
	}
}
