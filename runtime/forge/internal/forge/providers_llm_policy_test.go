package forge

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func setupForgedHome(t *testing.T, home string) {
	t.Helper()
	t.Setenv("XDG_CONFIG_HOME", "")
	t.Setenv("XDG_DATA_HOME", filepath.Join(home, ".local", "share"))
	t.Setenv("FORGE_REPO_DIR", t.TempDir())
	_ = os.MkdirAll(filepath.Join(home, ".local", "share", "wrenyard", "runtime"), 0o755)
	_ = os.MkdirAll(filepath.Join(home, ".config", "wrenyard", "runtime"), 0o755)
}

func saveTempConfig(t *testing.T, home string, cfg ForgeConfig) {
	t.Helper()
	t.Setenv("XDG_CONFIG_HOME", "")
	t.Setenv("XDG_DATA_HOME", filepath.Join(home, ".local", "share"))
	t.Setenv("FORGE_REPO_DIR", t.TempDir())
	configDir := filepath.Join(home, ".config", "wrenyard", "runtime")
	_ = os.MkdirAll(configDir, 0o755)
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		t.Fatalf("marshal config: %v", err)
	}
	if err := os.WriteFile(filepath.Join(configDir, "config.json"), append(data, '\n'), 0o644); err != nil {
		t.Fatalf("write config: %v", err)
	}
}

func TestProfileCredentialAvailableEmptyProvider(t *testing.T) {
	p := profile{Name: "test", Provider: ""}
	if !profileCredentialAvailable(p) {
		t.Fatal("profile with empty provider should be available")
	}
}

func TestProfileCredentialAvailableNoCredential(t *testing.T) {
	home := t.TempDir()
	setupForgedHome(t, home)
	t.Setenv("HOME", home)

	p := profile{Name: "test", Provider: "nonexistent-provider"}
	if profileCredentialAvailable(p) {
		t.Fatal("profile with missing credential should NOT be available")
	}
}

func TestProfileCredentialAvailableCodexNative(t *testing.T) {
	home := t.TempDir()
	setupForgedHome(t, home)
	t.Setenv("HOME", home)

	// Create Codex auth.json with valid token.
	codexDir := filepath.Join(home, ".codex")
	if err := os.MkdirAll(codexDir, 0o755); err != nil {
		t.Fatal(err)
	}
	codexAuth := map[string]interface{}{
		"tokens": map[string]interface{}{
			"access_token": "codex-auth-token",
		},
	}
	data, _ := json.Marshal(codexAuth)
	if err := os.WriteFile(filepath.Join(codexDir, "auth.json"), data, 0o600); err != nil {
		t.Fatal(err)
	}

	p := profile{Name: "codex-sol", Client: "codex", Provider: "codex"}
	if !profileCredentialAvailable(p) {
		t.Fatal("codex profile should be credential-available with valid Codex auth.json")
	}
}

func TestProfileCredentialAvailableCodexNativeMissing(t *testing.T) {
	home := t.TempDir()
	setupForgedHome(t, home)
	t.Setenv("HOME", home)

	p := profile{Name: "codex-sol", Client: "codex", Provider: "codex"}
	if profileCredentialAvailable(p) {
		t.Fatal("codex profile should NOT be credential-available without Codex auth")
	}
}

func TestProfileCredentialAvailableCodexSpark(t *testing.T) {
	home := t.TempDir()
	setupForgedHome(t, home)
	t.Setenv("HOME", home)

	// Codex-spark also uses codex auth.
	codexDir := filepath.Join(home, ".codex")
	if err := os.MkdirAll(codexDir, 0o755); err != nil {
		t.Fatal(err)
	}
	codexAuth := map[string]interface{}{
		"tokens": map[string]interface{}{
			"access_token": "codex-spark-token",
		},
	}
	data, _ := json.Marshal(codexAuth)
	if err := os.WriteFile(filepath.Join(codexDir, "auth.json"), data, 0o600); err != nil {
		t.Fatal(err)
	}

	p := profile{Name: "codex-spark", Client: "codex", Provider: "codex-spark"}
	if !profileCredentialAvailable(p) {
		t.Fatal("codex-spark profile should be credential-available with valid Codex auth.json")
	}
}

func TestProfileCredentialAvailableCodebuddyNative(t *testing.T) {
	home := t.TempDir()
	setupForgedHome(t, home)
	t.Setenv("HOME", home)

	// Create CodeBuddy auth file with valid token.
	cbDir := codebuddyTestAuthDir(t, home)
	if err := os.MkdirAll(cbDir, 0o755); err != nil {
		t.Fatal(err)
	}
	cbInfo := map[string]interface{}{
		"auth.accessToken": "codebuddy-bearer-token",
		"x-domain":         "tencent.com",
	}
	data, _ := json.Marshal(cbInfo)
	if err := os.WriteFile(filepath.Join(cbDir, "Tencent-Cloud.coding-copilot.info"), data, 0o600); err != nil {
		t.Fatal(err)
	}

	p := profile{Name: "cb-hy", Client: "codebuddy", Provider: "codebuddy"}
	if !profileCredentialAvailable(p) {
		t.Fatal("codebuddy profile should be credential-available with valid CodeBuddy native auth")
	}
}

func TestProfileCredentialAvailableCodebuddyNativeMissing(t *testing.T) {
	home := t.TempDir()
	setupForgedHome(t, home)
	t.Setenv("HOME", home)
	_ = codebuddyTestAuthDir(t, home)

	p := profile{Name: "cb-hy", Client: "codebuddy", Provider: "codebuddy"}
	if profileCredentialAvailable(p) {
		t.Fatal("codebuddy profile should NOT be credential-available without CodeBuddy native auth")
	}
}

// === Quota Floor Gate ===

func TestProfileQuotaAvailableNoQuotaProvider(t *testing.T) {
	p := profile{Name: "test"}
	if !profileQuotaAvailable(p, 90) {
		t.Fatal("profile without quota provider should be available")
	}
}

func TestProfileQuotaAvailableNoCacheFile(t *testing.T) {
	p := profile{
		Name: "test",
		Statusline: &statuslineConfig{
			QuotaProvider: "nonexistent-provider",
		},
	}
	if !profileQuotaAvailable(p, 90) {
		t.Fatal("profile with no cache should be available")
	}
}

func TestProfileQuotaAvailableBelowFloor(t *testing.T) {
	home := t.TempDir()
	setupForgedHome(t, home)
	t.Setenv("HOME", home)

	quotaDir := filepath.Join(forgeDataDir(), "quota")
	if err := os.MkdirAll(quotaDir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	entry := map[string]interface{}{
		"quota": map[string]interface{}{
			"used":  float64(500),
			"total": float64(1000),
		},
		"fetched_at": "2026-01-01T00:00:00Z",
	}
	data, _ := json.Marshal(entry)
	if err := os.WriteFile(filepath.Join(quotaDir, "test-quota.json"), append(data, '\n'), 0o600); err != nil {
		t.Fatalf("write quota cache: %v", err)
	}

	p := profile{
		Name: "test",
		Statusline: &statuslineConfig{
			QuotaProvider: "test-quota",
		},
	}

	if !profileQuotaAvailable(p, 90) {
		t.Fatal("profile with 50% usage should be available with floor=90")
	}
}

func TestProfileQuotaAvailableAboveFloor(t *testing.T) {
	home := t.TempDir()
	setupForgedHome(t, home)
	t.Setenv("HOME", home)

	quotaDir := filepath.Join(forgeDataDir(), "quota")
	if err := os.MkdirAll(quotaDir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	entry := map[string]interface{}{
		"quota": map[string]interface{}{
			"used":  float64(950),
			"total": float64(1000),
		},
		"fetched_at": "2026-01-01T00:00:00Z",
	}
	data, _ := json.Marshal(entry)
	if err := os.WriteFile(filepath.Join(quotaDir, "zhipu-coding.json"), append(data, '\n'), 0o600); err != nil {
		t.Fatalf("write quota cache: %v", err)
	}

	p := profile{
		Name: "test", Provider: "zhipu-coding",
	}

	if profileQuotaAvailable(p, 90) {
		t.Fatal("profile with 95% usage should NOT be available with floor=90")
	}
}

func TestProvidersListReportsStoredAuthAndKimiLoginReachesAuthFlow(t *testing.T) {
	home := t.TempDir()
	setupForgedHome(t, home)
	t.Setenv("HOME", home)
	if err := writeAuth(map[string]AuthEntry{
		"kimi-coding": {Type: "api", Key: "stored-kimi-key"},
	}); err != nil {
		t.Fatal(err)
	}

	out := captureStdout(t, func() {
		if code := providersCommand([]string{"list", "--json"}); code != 0 {
			t.Fatalf("providers list returned %d", code)
		}
	})
	var entries []struct {
		ID     string `json:"id"`
		AuthOK bool   `json:"auth_ok"`
	}
	if err := json.Unmarshal([]byte(out), &entries); err != nil {
		t.Fatalf("parse providers list: %v\n%s", err, out)
	}
	found := false
	for _, entry := range entries {
		if entry.ID == "kimi-coding" {
			found = true
			if !entry.AuthOK {
				t.Fatal("kimi-coding auth_ok should reflect the stored auth.json credential")
			}
		}
	}
	if !found {
		t.Fatal("kimi-coding missing from providers list")
	}

	stderr := captureStderr(t, func() {
		if code := providersCommand([]string{"auth", "login", "kimi-coding"}); code != 1 {
			t.Fatalf("non-TTY providers auth login returned %d, want 1", code)
		}
	})
	if strings.Contains(stderr, "does not support auth") || !strings.Contains(stderr, "TTY") {
		t.Fatalf("kimi login should reach the interactive auth flow, stderr: %s", stderr)
	}
}

func TestProvidersListExposesPublicAPIProviderDirectory(t *testing.T) {
	home := t.TempDir()
	setupForgedHome(t, home)
	t.Setenv("HOME", home)
	out := captureStdout(t, func() {
		if code := providersCommand([]string{"list", "--json"}); code != 0 {
			t.Fatalf("providers list returned %d", code)
		}
	})
	var entries []struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal([]byte(out), &entries); err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	for _, entry := range entries {
		seen[entry.ID] = true
	}
	for _, id := range []string{"anthropic-api", "minimax", "minimax-coding", "moonshot", "openai", "qwen", "qwen-coding", "tokenhub", "volcengine", "zhipu"} {
		if !seen[id] {
			t.Fatalf("public provider directory missing %q", id)
		}
	}
}

func TestProfilesListShowsProfilesAndPoliciesWithoutTarget(t *testing.T) {
	home := t.TempDir()
	setupForgedHome(t, home)
	t.Setenv("HOME", home)
	out := captureStdout(t, func() {
		if code := profilesCommand([]string{"list"}); code != 0 {
			t.Fatalf("profiles list returned %d", code)
		}
	})
	if !strings.Contains(out, "Profiles:\n") || !strings.Contains(out, "Policies:\n") {
		t.Fatalf("profiles list should show both sections:\n%s", out)
	}
	if !strings.Contains(out, "general:") {
		t.Fatalf("profiles list should include policies:\n%s", out)
	}
}

func TestProfilesListIncludesAvailableGrokProfiles(t *testing.T) {
	home := t.TempDir()
	setupForgedHome(t, home)
	t.Setenv("HOME", home)
	setFakeClientsOnPath(t, "grok")
	setTestAuth(t, "zhipu-coding", "zhipu-test")
	setTestAuth(t, "kimi-coding", "kimi-test")
	oauthPath := filepath.Join(home, ".grok", "auth.json")
	if err := os.MkdirAll(filepath.Dir(oauthPath), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(oauthPath, []byte(`{"oauth":"opaque"}`), 0o600); err != nil {
		t.Fatal(err)
	}

	out := captureStdout(t, func() {
		if code := profilesCommand([]string{"list", "profile"}); code != 0 {
			t.Fatalf("profiles list profile returned %d", code)
		}
	})
	for _, id := range []string{"gk-glm", "gk-glmf", "gk-kimi", "gk-grok"} {
		if !strings.Contains(out, id+" (") {
			t.Fatalf("available Grok profile %s missing from list:\n%s", id, out)
		}
	}
}
