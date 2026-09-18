package forge

import (
	"os"
	"testing"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/providers/auth"
)

// DeepSeek uses one credential for both quota balance and inference: the
// managed auth.json API entry wins, with the user-owned environment keys as
// the compatibility fallback. These tests use injected values only; no live
// provider API is called and no token is printed.

func TestResolveDeepSeekQuotaTokenManaged(t *testing.T) {
	home := t.TempDir()
	setupForgedHome(t, home)
	t.Setenv("HOME", home)
	t.Setenv("FORGE_DEEPSEEK_API_KEY", "")
	t.Setenv("DEEPSEEK_API_KEY", "")

	if err := auth.Write(authPath(), map[string]auth.Entry{
		"deepseek": {Type: "api", Key: "managed-deepseek-key"},
	}); err != nil {
		t.Fatal(err)
	}
	got := resolveDeepSeekQuotaToken()
	if got != "managed-deepseek-key" {
		t.Fatalf("managed token = %q, want the configured managed key", got)
	}
	if os.Getenv("DEEPSEEK_API_KEY") == got {
		t.Fatal("test setup error: managed key must not come from a bare environment key")
	}
}

func TestResolveDeepSeekQuotaTokenManagedWinsOverEnv(t *testing.T) {
	home := t.TempDir()
	setupForgedHome(t, home)
	t.Setenv("HOME", home)
	t.Setenv("DEEPSEEK_API_KEY", "env-legacy-key")

	if err := auth.Write(authPath(), map[string]auth.Entry{
		"deepseek": {Type: "api", Key: "managed-wins"},
	}); err != nil {
		t.Fatal(err)
	}
	if got := resolveDeepSeekQuotaToken(); got != "managed-wins" {
		t.Fatalf("token = %q, want the managed key to win over the environment", got)
	}
}

func TestResolveDeepSeekQuotaTokenEnvOnlyFallback(t *testing.T) {
	home := t.TempDir()
	setupForgedHome(t, home)
	t.Setenv("HOME", home)
	t.Setenv("FORGE_DEEPSEEK_API_KEY", "env-forge-key")
	t.Setenv("DEEPSEEK_API_KEY", "env-legacy-key")

	// No auth.json entry at all: an already-configured environment key keeps
	// working without any store write.
	if got := resolveDeepSeekQuotaToken(); got != "env-forge-key" {
		t.Fatalf("token = %q, want FORGE_DEEPSEEK_API_KEY fallback", got)
	}
}

func TestResolveDeepSeekQuotaTokenLegacyEnvFallback(t *testing.T) {
	home := t.TempDir()
	setupForgedHome(t, home)
	t.Setenv("HOME", home)
	t.Setenv("FORGE_DEEPSEEK_API_KEY", "")
	t.Setenv("DEEPSEEK_API_KEY", "env-legacy-key")

	if got := resolveDeepSeekQuotaToken(); got != "env-legacy-key" {
		t.Fatalf("token = %q, want DEEPSEEK_API_KEY fallback", got)
	}
}

func TestResolveDeepSeekQuotaTokenMissing(t *testing.T) {
	home := t.TempDir()
	setupForgedHome(t, home)
	t.Setenv("HOME", home)
	t.Setenv("FORGE_DEEPSEEK_API_KEY", "")
	t.Setenv("DEEPSEEK_API_KEY", "")

	if got := resolveDeepSeekQuotaToken(); got != "" {
		t.Fatalf("token = %q, want empty when DeepSeek is unconfigured", got)
	}
}

func TestResolveDeepSeekQuotaTokenIgnoresNonAPIEntry(t *testing.T) {
	home := t.TempDir()
	setupForgedHome(t, home)
	t.Setenv("HOME", home)
	t.Setenv("FORGE_DEEPSEEK_API_KEY", "")
	t.Setenv("DEEPSEEK_API_KEY", "")

	// An entry that is neither api-typed nor an oauth access token (empty Key,
	// empty Access) must never be returned as a balance key.
	if err := auth.Write(authPath(), map[string]auth.Entry{
		"deepseek": {Type: "oauth"},
	}); err != nil {
		t.Fatal(err)
	}
	if got := resolveDeepSeekQuotaToken(); got != "" {
		t.Fatalf("token = %q, want empty for a credential-less managed entry", got)
	}
}
