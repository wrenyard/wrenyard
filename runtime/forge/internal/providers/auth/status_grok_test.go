package auth

import (
	"os"
	"path/filepath"
	"testing"
)

func TestGrokOAuthAuthStatusUsesShellThenOfficialDefault(t *testing.T) {
	root := t.TempDir()
	dataDir := filepath.Join(root, "data", "forge")
	home := filepath.Join(root, "home")
	shellAuth := filepath.Join(dataDir, "grok", "shell-grok", "auth.json")
	defaultAuth := filepath.Join(home, ".grok", "auth.json")
	for _, path := range []string{shellAuth, defaultAuth} {
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte("opaque OAuth bytes"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	resolver := NewProviderAuthStatusResolver(
		func(string) (CredentialResolverKind, bool) { return ResolverGrokOAuth, true },
		func() string { return dataDir },
		func() string { return home },
	)
	status := resolver.ProviderAuthStatus("xai")
	if !status.OK || status.SourcePath != shellAuth {
		t.Fatalf("shell OAuth status = %+v", status)
	}
	if credential, ok := resolver.Credential("xai"); ok || credential != nil {
		t.Fatal("native Grok OAuth must not be exposed as a Forge credential value")
	}
	if err := os.Remove(shellAuth); err != nil {
		t.Fatal(err)
	}
	status = resolver.ProviderAuthStatus("xai")
	if !status.OK || status.SourcePath != defaultAuth {
		t.Fatalf("default OAuth status = %+v", status)
	}
}
