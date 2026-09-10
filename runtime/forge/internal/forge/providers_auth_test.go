package forge

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/providers/auth"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/providers/cursor"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/catalog"
)

func TestAuthHelpDoesNotAdvertiseNativeOpenAIProvider(t *testing.T) {
	stdout := captureStdout(t, printAuthHelp)
	lower := strings.ToLower(stdout)
	for _, forbidden := range []string{"openai", "sk-abc123"} {
		if strings.Contains(lower, forbidden) {
			t.Fatalf("auth help should not mention %q after native OpenAI provider removal:\n%s", forbidden, stdout)
		}
	}
}

func TestKimiCodingProviderUsesAuthStoreOnlyAtRuntime(t *testing.T) {
	repo := t.TempDir()
	home := t.TempDir()
	t.Setenv("FORGE_REPO_DIR", repo)
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("XDG_CONFIG_HOME", "")
	t.Setenv("XDG_DATA_HOME", t.TempDir())

	if !IsManagedProvider("kimi-coding") {
		t.Fatal("kimi-coding should be a Forge-managed provider")
	}
	for _, key := range []string{
		"kimi-coding-api-key",
		"kimi-api-key",
		"moonshot-api-key",
		"FORGE_KIMI_CODING_API_KEY",
		"KIMI_CODING_API_KEY",
		"MOONSHOT_API_KEY",
	} {
		if got := legacyKeyToProviderID(key); got != "kimi-coding" {
			t.Fatalf("legacyKeyToProviderID(%q) = %q, want kimi-coding", key, got)
		}
	}

	userPath := userSecretsPath()
	if err := os.MkdirAll(filepath.Dir(userPath), 0o700); err != nil {
		t.Fatal(err)
	}
	userSecrets := map[string]string{"moonshot-api-key": "legacy-kimi-key"}
	data, _ := json.MarshalIndent(userSecrets, "", "  ")
	if err := os.WriteFile(userPath, append(data, '\n'), 0o600); err != nil {
		t.Fatal(err)
	}
	cred, ok := ResolveCredential("kimi-coding")
	if ok || cred != "" {
		t.Fatalf("ResolveCredential(kimi-coding) = %q/%v, want empty/false before setup migration", cred, ok)
	}

	migrated, err := MigrateAuthFromSecrets()
	if err != nil {
		t.Fatal(err)
	}
	if len(migrated) != 1 || migrated[0] != "kimi-coding" {
		t.Fatalf("MigrateAuthFromSecrets() = %v, want [kimi-coding]", migrated)
	}
	cred, ok = ResolveCredential("kimi-coding")
	if !ok || cred != "legacy-kimi-key" {
		t.Fatalf("ResolveCredential(kimi-coding) after migration = %q/%v, want legacy-kimi-key/true", cred, ok)
	}
}

func TestRedactMapSlices(t *testing.T) {
	fakeCredential := "AI" + "za" + strings.Repeat("1", 24)
	payload := map[string]interface{}{
		"actions": []map[string]interface{}{{"content": "GOOGLE_API_KEY=" + fakeCredential}},
	}
	redacted := redact(payload).(map[string]interface{})
	actions := redacted["actions"].([]interface{})
	content := actions[0].(map[string]interface{})["content"].(string)
	if strings.Contains(content, fakeCredential) {
		t.Fatalf("secret in []map was not redacted: %s", content)
	}
	if !strings.Contains(content, redactionPlaceholder) {
		t.Fatalf("redaction placeholder missing: %s", content)
	}
}

func TestRedactScalarSecretKeys(t *testing.T) {
	input := map[string]interface{}{
		"authorization": "Bearer sk-real-secret-abc123",
		"api-key":       "sk-abcdef123456",
		"token":         "tok-xyz-789",
		"password":      "super-secret-password",
		"safe-key":      "some-valid-data",
	}
	redacted := redact(input).(map[string]interface{})
	for _, key := range []string{"authorization", "api-key", "token", "password"} {
		if v, ok := redacted[key]; !ok || v != redactionPlaceholder {
			t.Fatalf("key %q should be redacted to %s, got %v", key, redactionPlaceholder, v)
		}
	}
	if v, ok := redacted["safe-key"]; !ok || v == redactionPlaceholder {
		t.Fatalf("safe-key should not be redacted, got %v", v)
	}
}

func TestRedactNestedArraysAndMaps(t *testing.T) {
	input := map[string]interface{}{
		"headers": []interface{}{
			map[string]interface{}{"authorization": "Bearer real-token"},
			map[string]string{"x-api-key": "sk-ant-secret"},
		},
		"nested": map[string]string{
			"api_key": "sk-abc-def",
		},
	}
	redacted := redact(input).(map[string]interface{})
	headers := redacted["headers"].([]interface{})
	if h1, ok := headers[0].(map[string]interface{}); !ok || h1["authorization"] != redactionPlaceholder {
		t.Fatalf("nested authorization not redacted: %v", headers[0])
	}
	if h2, ok := headers[1].(map[string]interface{}); !ok || h2["x-api-key"] != redactionPlaceholder {
		t.Fatalf("nested x-api-key not redacted: %v", headers[1])
	}
	nested := redacted["nested"].(map[string]interface{})
	if nested["api_key"] != redactionPlaceholder {
		t.Fatalf("nested api_key not redacted: %v", nested["api_key"])
	}
}

func TestRedactMapStringSlice(t *testing.T) {
	input := map[string][]string{
		"authorization": {"Bearer tok-abc-123", "Bearer tok-xyz-789"},
		"safe-header":   {"value1", "value2"},
	}
	redacted := redact(input).(map[string]interface{})
	if redacted["authorization"] != redactionPlaceholder {
		t.Fatalf("[]string authorization should be fully redacted, got %v", redacted["authorization"])
	}
	vals := redacted["safe-header"].([]interface{})
	if len(vals) != 2 || vals[0] != "value1" || vals[1] != "value2" {
		t.Fatalf("safe-header should be untouched, got %v", vals)
	}
}

func TestRedactHttpHeader(t *testing.T) {
	// http.Header has its own Redact case (returns http.Header, not map[string]interface{}).
	// Secret-key arrays are entirely replaced with []string{"<REDACTED>"};
	// non-secret values are sanitized but preserved.
	input := map[string]interface{}{
		"req_headers": http.Header{
			"Authorization":    {"Bearer tok-secret"},
			"X-Api-Key":        {"sk-secret-key"},
			"Content-Type":     {"application/json"},
			"X-Requested-With": {"XMLHttpRequest"},
		},
	}
	redacted := redact(input).(map[string]interface{})
	rh, ok := redacted["req_headers"].(http.Header)
	if !ok {
		t.Fatalf("req_headers should be http.Header, got %T", redacted["req_headers"])
	}
	// Secret keys are entirely replaced with a single "<REDACTED>" entry.
	for _, key := range []string{"Authorization", "X-Api-Key"} {
		vals := rh[key]
		if len(vals) != 1 || vals[0] != redactionPlaceholder {
			t.Fatalf("key %q should have exactly one redacted entry, got %v", key, vals)
		}
	}
	// Non-secret values are preserved (sanitized but no secrets present).
	if got := rh.Get("Content-Type"); got != "application/json" {
		t.Fatalf("Content-Type should be preserved, got %q", got)
	}
	if got := rh.Get("X-Requested-With"); got != "XMLHttpRequest" {
		t.Fatalf("X-Requested-With should be preserved, got %q", got)
	}
}

func TestSecretResolutionUserFirst(t *testing.T) {
	repo := t.TempDir()
	home := t.TempDir()
	t.Setenv("FORGE_REPO_DIR", repo)
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", "")

	if err := os.MkdirAll(filepath.Join(repo, "data"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(repo, "data", "secrets.json"), []byte(`{"test-key":"repo-value"}`), 0o644); err != nil {
		t.Fatal(err)
	}

	userPath := userSecretsPath()
	if err := os.MkdirAll(filepath.Dir(userPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(userPath, []byte(`{"test-key":"user-value"}`), 0o600); err != nil {
		t.Fatal(err)
	}

	if got := userSecret("test-key"); got != "user-value" {
		t.Fatalf("userSecret should return user-value, got %q", got)
	}
	if got := repoSecret("test-key"); got != "repo-value" {
		t.Fatalf("repoSecret should still return repo-value, got %q", got)
	}
	if got := firstRepoSecret("test-key"); got != "user-value" {
		t.Fatalf("firstRepoSecret should return user-value first, got %q", got)
	}

	if err := os.WriteFile(userPath, []byte(`{"test-key":"user-value","user-only":"secret"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := firstRepoSecret("user-only"); got != "secret" {
		t.Fatalf("firstRepoSecret should find user-only key, got %q", got)
	}
}

func TestSecretResolutionRepoFallback(t *testing.T) {
	repo := t.TempDir()
	home := t.TempDir()
	t.Setenv("FORGE_REPO_DIR", repo)
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", "")

	if err := os.MkdirAll(filepath.Join(repo, "data"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(repo, "data", "secrets.json"), []byte(`{"test-key":"repo-value"}`), 0o644); err != nil {
		t.Fatal(err)
	}

	if got := firstRepoSecret("test-key"); got != "repo-value" {
		t.Fatalf("firstRepoSecret should fall back to repo, got %q", got)
	}
	if got := userSecret("test-key"); got != "" {
		t.Fatalf("userSecret should return empty when file missing, got %q", got)
	}
}

func TestResolveSecretRepoRefUsesUserFirst(t *testing.T) {
	repo := t.TempDir()
	home := t.TempDir()
	t.Setenv("FORGE_REPO_DIR", repo)
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", "")

	if err := os.MkdirAll(filepath.Join(repo, "data"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(repo, "data", "secrets.json"), []byte(`{"my-key":"repo-secret"}`), 0o644); err != nil {
		t.Fatal(err)
	}

	userPath := userSecretsPath()
	if err := os.MkdirAll(filepath.Dir(userPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(userPath, []byte(`{"my-key":"user-secret"}`), 0o600); err != nil {
		t.Fatal(err)
	}

	ref := "repo:my-key"
	secret, err := resolveSecret(&ref)
	if err != nil {
		t.Fatal(err)
	}
	if secret == nil || *secret != "user-secret" {
		t.Fatalf("resolveSecret should prefer user secrets, got %v", secret)
	}

	if err := os.Remove(userPath); err != nil {
		t.Fatal(err)
	}
	secret, err = resolveSecret(&ref)
	if err != nil {
		t.Fatal(err)
	}
	if secret == nil || *secret != "repo-secret" {
		t.Fatalf("resolveSecret should fall back to repo, got %v", secret)
	}
}

func TestSecretsMigrationIdempotent(t *testing.T) {
	repo := t.TempDir()
	home := t.TempDir()
	t.Setenv("FORGE_REPO_DIR", repo)
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", "")

	if err := os.MkdirAll(filepath.Join(repo, "data"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(repo, "data", "secrets.json"), []byte(`{"kimi-coding-api-key":"val1","moonshot-api-key":"val2"}`), 0o644); err != nil {
		t.Fatal(err)
	}

	migrated, err := MigrateAuthFromSecrets()
	if err != nil {
		t.Fatalf("first migration should succeed: %v", err)
	}
	if len(migrated) != 1 || migrated[0] != "kimi-coding" {
		t.Fatalf("expected 1 migrated provider [kimi-coding], got %v", migrated)
	}

	authData, err := readAuth()
	if err != nil {
		t.Fatalf("read auth: %v", err)
	}
	if authData == nil || authData["kimi-coding"].Key != "val1" {
		t.Fatalf("kimi-coding auth key should be val1, got %v", authData)
	}

	// Modify auth manually to simulate user changes.
	authData["kimi-coding"] = AuthEntry{Type: "api", Key: "user-modified"}
	authData["user-only"] = AuthEntry{Type: "api", Key: "user-only-key"}
	if err := auth.Write(authPath(), authData); err != nil {
		t.Fatal(err)
	}

	migrated, err = MigrateAuthFromSecrets()
	if err != nil {
		t.Fatalf("second migration should succeed: %v", err)
	}

	authData, err = readAuth()
	if err != nil {
		t.Fatalf("read auth after second migration: %v", err)
	}
	if authData == nil || authData["kimi-coding"].Key != "user-modified" {
		t.Fatalf("migration should not overwrite existing user auth key, got %q", authData["kimi-coding"].Key)
	}
	if authData["user-only"].Key != "user-only-key" {
		t.Fatalf("migration should preserve user-only key, got %q", authData["user-only"].Key)
	}
}

func TestSecretsMigrationEmptyRepo(t *testing.T) {
	repo := t.TempDir()
	home := t.TempDir()
	t.Setenv("FORGE_REPO_DIR", repo)
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", "")

	migrated, err := MigrateAuthFromSecrets()
	if err != nil {
		t.Fatalf("migration with no repo secrets should succeed: %v", err)
	}
	if len(migrated) != 0 {
		t.Fatalf("expected no migrated providers for empty repo, got %v", migrated)
	}
}

// TestProviderLoginRejectsNonTTY verifies that providerLogin rejects non-TTY stdin.
func TestProviderLoginRejectsNonTTY(t *testing.T) {
	home := t.TempDir()
	repo := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("FORGE_REPO_DIR", repo)
	t.Setenv("XDG_CONFIG_HOME", "")

	err := providerLogin("zhipu-coding")
	if err == nil {
		t.Fatal("providerLogin should fail for non-TTY")
	}
	if !strings.Contains(err.Error(), "TTY") {
		t.Fatalf("expected TTY error, got: %v", err)
	}
}

// TestProviderLoginRejectsNonTTYNoEcho verifies non-TTY rejection doesn't echo input.
func TestProviderLoginRejectsNonTTYNoEcho(t *testing.T) {
	home := t.TempDir()
	repo := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("FORGE_REPO_DIR", repo)
	t.Setenv("XDG_CONFIG_HOME", "")

	origStderr := os.Stderr
	r, w, _ := os.Pipe()
	os.Stderr = w
	err := providerLogin("zhipu-coding")
	w.Close()
	var buf strings.Builder
	io.Copy(&buf, r)
	os.Stderr = origStderr

	if err == nil {
		t.Fatal("providerLogin should fail for non-TTY")
	}
	output := buf.String()
	if strings.Contains(output, "zhipu-coding") {
		t.Fatalf("output should not echo provider id: %q", output)
	}
}

// TestMigrateAuthFromSecretsDeterministic verifies deterministic ordered precedence.
func TestMigrateAuthFromSecretsDeterministic(t *testing.T) {
	repo := t.TempDir()
	home := t.TempDir()
	t.Setenv("FORGE_REPO_DIR", repo)
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", "")
	t.Setenv("USERPROFILE", home)

	userPath := userSecretsPath()
	if err := os.MkdirAll(filepath.Dir(userPath), 0o700); err != nil {
		t.Fatal(err)
	}
	userSecrets := map[string]string{
		"glm-anthropic-auth-token":      "key-from-anthropic",
		"glm-Tencent-auth-token":        "key-from-tencent",
		"glm-api-key":                   "key-from-api",
		"zhipu-api-key":                 "key-from-zhipu",
		"deepseek-anthropic-auth-token": "deepseek-key",
		"openai-api-key":                "openai-key-that-should-be-ignored",
	}
	data, _ := json.MarshalIndent(userSecrets, "", "  ")
	if err := os.WriteFile(userPath, append(data, '\n'), 0o600); err != nil {
		t.Fatal(err)
	}

	migrated, err := MigrateAuthFromSecrets()
	if err != nil {
		t.Fatal(err)
	}

	if len(migrated) != 2 {
		t.Fatalf("expected 2 migrated providers, got %d: %v", len(migrated), migrated)
	}

	auth, err := readAuth()
	if err != nil {
		t.Fatal(err)
	}

	zhipuEntry, ok := auth["zhipu-coding"]
	if !ok {
		t.Fatal("zhipu-coding should be migrated from secrets")
	}
	if zhipuEntry.Key != "key-from-anthropic" {
		t.Fatalf("zhipu-coding should use glm-anthropic-auth-token (first in precedence), got key: %s", maskKey(zhipuEntry.Key))
	}

	dsEntry, ok := auth["deepseek"]
	if !ok {
		t.Fatal("deepseek should be migrated from secrets")
	}
	if dsEntry.Key != "deepseek-key" {
		t.Fatalf("deepseek should have deepseek-key, got: %s", dsEntry.Key)
	}

	if _, ok := auth["openai"]; ok {
		t.Fatalf("openai should not be migrated from legacy secrets: %#v", auth["openai"])
	}
}

// TestResolveCredentialRequiresSetupMigration verifies legacy repo secrets are
// not runtime credential sources but setup migration can import them.
func TestResolveCredentialRequiresSetupMigration(t *testing.T) {
	repo := t.TempDir()
	home := t.TempDir()
	t.Setenv("FORGE_REPO_DIR", repo)
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", "")

	if err := os.MkdirAll(filepath.Join(repo, "data"), 0o755); err != nil {
		t.Fatal(err)
	}
	repoSecrets := map[string]string{
		"glm-anthropic-auth-token": "repo-glm-key",
	}
	data, _ := json.MarshalIndent(repoSecrets, "", "  ")
	if err := os.WriteFile(filepath.Join(repo, "data", "secrets.json"), append(data, '\n'), 0o644); err != nil {
		t.Fatal(err)
	}

	cred, ok := ResolveCredential("zhipu-coding")
	if ok || cred != "" {
		t.Fatalf("ResolveCredential before migration = %q/%v, want empty/false", cred, ok)
	}
	migrated, err := MigrateAuthFromSecrets()
	if err != nil {
		t.Fatal(err)
	}
	if len(migrated) != 1 || migrated[0] != "zhipu-coding" {
		t.Fatalf("migration = %v, want [zhipu-coding]", migrated)
	}
	cred, ok = ResolveCredential("zhipu-coding")
	if !ok || cred != "repo-glm-key" {
		t.Fatalf("ResolveCredential after migration = %q/%v, want repo-glm-key/true", cred, ok)
	}

	// Regression: GLM legacy secret keys must map to the canonical
	// zhipu-coding provider ID.
	for _, key := range []string{
		"glm-anthropic-auth-token",
		"glm-Tencent-auth-token",
		"glm-api-key",
		"zhipu-api-key",
		"FORGE_GLM_ANTHROPIC_AUTH_TOKEN",
		"GLM_ANTHROPIC_AUTH_TOKEN",
	} {
		if got := legacyKeyToProviderID(key); got != "zhipu-coding" {
			t.Fatalf("legacyKeyToProviderID(%q) = %q, want zhipu-coding", key, got)
		}
	}
}

// TestZhipuCodingCanonicalMigratesGLMLegacySecrets verifies that setup imports
// GLM legacy keys under the canonical provider id.
func TestZhipuCodingCanonicalMigratesGLMLegacySecrets(t *testing.T) {
	repo := t.TempDir()
	home := t.TempDir()
	t.Setenv("FORGE_REPO_DIR", repo)
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", "")

	if err := os.MkdirAll(filepath.Join(repo, "data"), 0o755); err != nil {
		t.Fatal(err)
	}
	repoSecrets := map[string]string{
		"glm-api-key": "canonical-glm-key",
	}
	data, _ := json.MarshalIndent(repoSecrets, "", "  ")
	if err := os.WriteFile(filepath.Join(repo, "data", "secrets.json"), append(data, '\n'), 0o644); err != nil {
		t.Fatal(err)
	}

	migrated, err := MigrateAuthFromSecrets()
	if err != nil {
		t.Fatal(err)
	}
	if len(migrated) != 1 || migrated[0] != "zhipu-coding" {
		t.Fatalf("migration = %v, want [zhipu-coding]", migrated)
	}
	cred, ok := ResolveCredential("zhipu-coding")
	if !ok || cred != "canonical-glm-key" {
		t.Fatalf("ResolveCredential after migration = %q/%v, want canonical-glm-key/true", cred, ok)
	}
}

// TestKimiCodingMissingCredential verifies that ResolveCredential for
// kimi-coding returns false when no auth or secret is present.
func TestKimiCodingMissingCredential(t *testing.T) {
	repo := t.TempDir()
	home := t.TempDir()
	t.Setenv("FORGE_REPO_DIR", repo)
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", "")

	cred, ok := ResolveCredential("kimi-coding")
	if ok || cred != "" {
		t.Fatalf("ResolveCredential should return empty/false when kimi-coding has no credential, got: %q / %v", cred, ok)
	}
}

// === SSOT ProviderAuthStatus Tests ===

func TestProviderAuthStatusForgeManaged(t *testing.T) {
	home := t.TempDir()
	setupForgedHome(t, home)
	t.Setenv("HOME", home)

	// Write auth.json with kimi-coding credential.
	authData := map[string]auth.Entry{
		"kimi-coding": {Type: "api", Key: "test-kimi-key"},
	}
	if err := auth.Write(authPath(), authData); err != nil {
		t.Fatal(err)
	}

	resolver := auth.NewProviderAuthStatusResolver(
		forgeCatalogAuthResolver,
		forgeDataDir,
		userHome,
	)
	status := resolver.ProviderAuthStatus("kimi-coding")
	if !status.OK {
		t.Fatalf("kimi-coding should be authenticated, got status: %+v", status)
	}
	if status.Kind != auth.ResolverForgeManaged {
		t.Fatalf("expected forge-managed resolver, got %s", status.Kind)
	}
}

func TestProviderAuthStatusForgeManagedMissing(t *testing.T) {
	home := t.TempDir()
	setupForgedHome(t, home)
	t.Setenv("HOME", home)

	resolver := auth.NewProviderAuthStatusResolver(
		forgeCatalogAuthResolver,
		forgeDataDir,
		userHome,
	)
	status := resolver.ProviderAuthStatus("kimi-coding")
	if status.OK {
		t.Fatal("kimi-coding should NOT be authenticated without auth.json")
	}
}

func TestProviderAuthStatusCodeBuddy(t *testing.T) {
	home := t.TempDir()
	setupForgedHome(t, home)
	t.Setenv("HOME", home)

	// Create CodeBuddy auth file with the real nested shape.
	cbDir := codebuddyTestAuthDir(t, home)
	if err := os.MkdirAll(cbDir, 0o755); err != nil {
		t.Fatal(err)
	}
	cbInfo := map[string]interface{}{
		"auth": map[string]interface{}{
			"accessToken": "test-codebuddy-token",
			"domain":      "tencent.com",
		},
	}
	data, _ := json.Marshal(cbInfo)
	if err := os.WriteFile(filepath.Join(cbDir, "Tencent-Cloud.coding-copilot.info"), data, 0o600); err != nil {
		t.Fatal(err)
	}

	resolver := auth.NewProviderAuthStatusResolver(
		codebuddyCatalogAuthResolver,
		forgeDataDir,
		userHome,
	)
	status := resolver.ProviderAuthStatus("codebuddy")
	if !status.OK {
		t.Fatalf("codebuddy should be authenticated, got status: %+v", status)
	}
	if status.Kind != auth.ResolverCodeBuddy {
		t.Fatalf("expected codebuddy resolver, got %s", status.Kind)
	}

	// Credential carries the bearer token and no company-only headers.
	cred, ok := resolver.Credential("codebuddy")
	if !ok {
		t.Fatal("codebuddy credential should be available")
	}
	if cred.Value != "test-codebuddy-token" {
		t.Fatalf("codebuddy credential value = %q, want test-codebuddy-token", cred.Value)
	}
	if cred.Headers != nil && len(cred.Headers) > 0 {
		t.Fatalf("codebuddy credential must carry no company headers, got %v", cred.Headers)
	}
	headers := resolver.Headers("codebuddy")
	if headers.Get("Authorization") != "Bearer test-codebuddy-token" {
		t.Fatalf("Authorization header = %q, want Bearer test-codebuddy-token", headers.Get("Authorization"))
	}
	for _, h := range []string{"X-Domain", "X-User-Id", "X-Enterprise-Id", "X-Tenant-Id", "X-Product", "X-Requested-With"} {
		if headers.Get(h) != "" {
			t.Fatalf("company-only header %s must not be attached: %v", h, headers)
		}
	}
}

func TestProviderAuthStatusCodeBuddyMissing(t *testing.T) {
	home := t.TempDir()
	setupForgedHome(t, home)
	t.Setenv("HOME", home)
	_ = codebuddyTestAuthDir(t, home)

	// No CodeBuddy auth file on disk.
	resolver := auth.NewProviderAuthStatusResolver(
		codebuddyCatalogAuthResolver,
		forgeDataDir,
		userHome,
	)
	status := resolver.ProviderAuthStatus("codebuddy")
	if status.OK {
		t.Fatal("codebuddy should NOT be authenticated without the CodeBuddy auth file")
	}
	cred, ok := resolver.Credential("codebuddy")
	if ok {
		t.Fatalf("codebuddy credential should not resolve, got: %+v", cred)
	}
	if cred != nil {
		t.Fatal("codebuddy credential pointer should be nil when ok is false")
	}
	if headers := resolver.Headers("codebuddy"); headers != nil {
		t.Fatal("codebuddy should have no headers without the CodeBuddy auth file")
	}
}

func codebuddyTestAuthDir(t *testing.T, home string) string {
	t.Helper()
	switch runtime.GOOS {
	case "darwin":
		return filepath.Join(home, "Library", "Application Support", "CodeBuddyExtension", "Data", "Public", "auth")
	case "windows":
		localAppData := filepath.Join(home, "AppData", "Local")
		t.Setenv("LOCALAPPDATA", localAppData)
		return filepath.Join(localAppData, "CodeBuddyExtension", "Data", "Public", "auth")
	default:
		return filepath.Join(home, ".local", "share", "CodeBuddyExtension", "Data", "Public", "auth")
	}
}

func TestProviderAuthStatusCodex(t *testing.T) {
	home := t.TempDir()
	setupForgedHome(t, home)
	t.Setenv("HOME", home)

	// Create Codex auth.json with nested tokens.access_token.
	codexDir := filepath.Join(home, ".codex")
	if err := os.MkdirAll(codexDir, 0o755); err != nil {
		t.Fatal(err)
	}
	codexAuth := map[string]interface{}{
		"tokens": map[string]interface{}{
			"access_token": "codex-access-token-value",
		},
	}
	data, _ := json.Marshal(codexAuth)
	if err := os.WriteFile(filepath.Join(codexDir, "auth.json"), data, 0o600); err != nil {
		t.Fatal(err)
	}

	resolver := auth.NewProviderAuthStatusResolver(
		forgeCatalogAuthResolver,
		forgeDataDir,
		userHome,
	)
	status := resolver.ProviderAuthStatus("chatgpt")
	if !status.OK {
		t.Fatalf("codex should be authenticated, got status: %+v", status)
	}
	if status.Kind != auth.ResolverCodex {
		t.Fatalf("expected codex resolver, got %s", status.Kind)
	}

	cred, ok := resolver.Credential("chatgpt")
	if !ok {
		t.Fatal("codex credential should be available")
	}
	if cred.Value != "codex-access-token-value" {
		t.Fatalf("codex credential value = %q, want codex-access-token-value", cred.Value)
	}
}

func TestProviderAuthStatusCodexMissing(t *testing.T) {
	home := t.TempDir()
	setupForgedHome(t, home)
	t.Setenv("HOME", home)

	resolver := auth.NewProviderAuthStatusResolver(
		forgeCatalogAuthResolver,
		forgeDataDir,
		userHome,
	)
	status := resolver.ProviderAuthStatus("chatgpt")
	if status.OK {
		t.Fatal("codex should NOT be authenticated without auth.json")
	}
}

func TestProviderAuthStatusClaude(t *testing.T) {
	home := t.TempDir()
	setupForgedHome(t, home)
	t.Setenv("HOME", home)

	// Create Claude .credentials.json with nested OAuth token.
	credsDir := filepath.Join(home, ".claude")
	if err := os.MkdirAll(credsDir, 0o755); err != nil {
		t.Fatal(err)
	}
	creds := map[string]interface{}{
		"claudeAiOauth": map[string]interface{}{
			"accessToken": "claude-oauth-token",
		},
	}
	data, _ := json.Marshal(creds)
	if err := os.WriteFile(filepath.Join(credsDir, ".credentials.json"), data, 0o600); err != nil {
		t.Fatal(err)
	}

	resolver := auth.NewProviderAuthStatusResolver(
		forgeCatalogAuthResolver,
		forgeDataDir,
		userHome,
	)
	status := resolver.ProviderAuthStatus("anthropic")
	if !status.OK {
		t.Fatalf("anthropic should be authenticated, got status: %+v", status)
	}
	if status.Kind != auth.ResolverClaude {
		t.Fatalf("expected claude resolver, got %s", status.Kind)
	}

	cred, ok := resolver.Credential("anthropic")
	if !ok {
		t.Fatal("anthropic credential should be available")
	}
	if cred.Value != "claude-oauth-token" {
		t.Fatalf("anthropic credential value = %q, want claude-oauth-token", cred.Value)
	}
}

func TestProviderAuthStatusClaudeMissing(t *testing.T) {
	home := t.TempDir()
	setupForgedHome(t, home)
	t.Setenv("HOME", home)

	resolver := auth.NewProviderAuthStatusResolver(
		forgeCatalogAuthResolver,
		forgeDataDir,
		userHome,
	)
	status := resolver.ProviderAuthStatus("anthropic")
	if status.OK {
		t.Fatal("anthropic should NOT be authenticated without .credentials.json")
	}
}

// writeForgeCursorStateDB creates a Cursor state.vscdb under home at the
// platform path resolved by the shared helper, storing a token.
func writeForgeCursorStateDB(t *testing.T, home, value string) {
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
}

func TestProviderAuthStatusCursor(t *testing.T) {
	home := t.TempDir()
	setupForgedHome(t, home)
	t.Setenv("HOME", home)
	writeForgeCursorStateDB(t, home, "forge-cursor-token")

	resolver := auth.NewProviderAuthStatusResolver(
		forgeCatalogAuthResolver,
		forgeDataDir,
		userHome,
	)
	status := resolver.ProviderAuthStatus("cursor")
	if !status.OK {
		t.Fatalf("cursor should be authenticated, got status: %+v", status)
	}
	if status.Kind != auth.ResolverCursor {
		t.Fatalf("expected cursor resolver, got %s", status.Kind)
	}
	// Status and source path must never expose the token.
	joined := status.SourcePath + " " + status.Detail
	if strings.Contains(joined, "forge-cursor-token") {
		t.Fatalf("cursor status leaked token: %q", joined)
	}

	cred, ok := resolver.Credential("cursor")
	if !ok {
		t.Fatal("cursor credential should be available")
	}
	if cred.Value != "forge-cursor-token" {
		t.Fatalf("cursor credential value = %q, want forge-cursor-token", cred.Value)
	}
	if cred.Headers != nil && len(cred.Headers) > 0 {
		t.Fatalf("cursor credential must carry no extra headers, got %v", cred.Headers)
	}
	if got := resolver.Headers("cursor").Get("Authorization"); got != "Bearer forge-cursor-token" {
		t.Fatalf("Authorization header = %q, want Bearer forge-cursor-token", got)
	}
}

func TestProviderAuthStatusCursorMissing(t *testing.T) {
	home := t.TempDir()
	setupForgedHome(t, home)
	t.Setenv("HOME", home)

	resolver := auth.NewProviderAuthStatusResolver(
		forgeCatalogAuthResolver,
		forgeDataDir,
		userHome,
	)
	status := resolver.ProviderAuthStatus("cursor")
	if status.OK {
		t.Fatal("cursor should NOT be authenticated without state.vscdb")
	}
	cred, ok := resolver.Credential("cursor")
	if ok || cred != nil {
		t.Fatalf("cursor credential should not resolve without state.vscdb, got: %+v / %v", cred, ok)
	}
}

func TestProviderAuthStatusMalformedFiles(t *testing.T) {
	home := t.TempDir()
	setupForgedHome(t, home)
	t.Setenv("HOME", home)

	// Invalid JSON in auth.json.
	forgeData := forgeDataDir()
	if err := os.MkdirAll(forgeData, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(forgeData, "auth.json"), []byte(`not json`), 0o600); err != nil {
		t.Fatal(err)
	}

	resolver := auth.NewProviderAuthStatusResolver(
		forgeCatalogAuthResolver,
		forgeDataDir,
		userHome,
	)

	// Forge-managed should fail with invalid JSON.
	status := resolver.ProviderAuthStatus("kimi-coding")
	if status.OK {
		t.Fatal("kimi-coding should NOT be authenticated with invalid auth.json")
	}
}

func TestProviderAuthStatusEmptyFields(t *testing.T) {
	home := t.TempDir()
	setupForgedHome(t, home)
	t.Setenv("HOME", home)

	// auth.json exists but has empty key.
	forgeData := forgeDataDir()
	if err := os.MkdirAll(forgeData, 0o755); err != nil {
		t.Fatal(err)
	}
	authData := map[string]auth.Entry{
		"kimi-coding": {Type: "api", Key: ""},
	}
	data, _ := json.MarshalIndent(authData, "", "  ")
	if err := os.WriteFile(filepath.Join(forgeData, "auth.json"), append(data, '\n'), 0o600); err != nil {
		t.Fatal(err)
	}

	resolver := auth.NewProviderAuthStatusResolver(
		forgeCatalogAuthResolver,
		forgeDataDir,
		userHome,
	)
	status := resolver.ProviderAuthStatus("kimi-coding")
	if status.OK {
		t.Fatal("kimi-coding should NOT be authenticated with empty key")
	}
}

func TestProviderAuthStatusUnknownProvider(t *testing.T) {
	home := t.TempDir()
	setupForgedHome(t, home)
	t.Setenv("HOME", home)

	resolver := auth.NewProviderAuthStatusResolver(
		forgeCatalogAuthResolver,
		forgeDataDir,
		userHome,
	)
	status := resolver.ProviderAuthStatus("nonexistent-provider")
	if status.OK {
		t.Fatal("nonexistent provider should not be authenticated")
	}
}

func TestAnthropicIsNotForgeManagedAndResolverIsClaude(t *testing.T) {
	if IsManagedProvider("anthropic") {
		t.Fatal("anthropic must not be forge-managed; its credential resolver is claude")
	}
	for _, id := range []string{"kimi-coding", "zhipu-coding"} {
		if !IsManagedProvider(id) {
			t.Fatalf("%s should be forge-managed", id)
		}
	}

	home := t.TempDir()
	setupForgedHome(t, home)
	t.Setenv("HOME", home)
	resolver := auth.NewProviderAuthStatusResolver(
		forgeCatalogAuthResolver,
		forgeDataDir,
		userHome,
	)
	status := resolver.ProviderAuthStatus("anthropic")
	if status.Kind != auth.ResolverClaude {
		t.Fatalf("anthropic resolver = %s, want claude", status.Kind)
	}
}

// codebuddyCatalogAuthResolver is a test helper that maps the generic
// "codebuddy" provider id to the CodeBuddy native credential resolver.
func codebuddyCatalogAuthResolver(providerID string) (auth.CredentialResolverKind, bool) {
	if providerID == "codebuddy" {
		return auth.ResolverCodeBuddy, true
	}
	return "", false
}

// forgeCatalogAuthResolver is a test helper that resolves the credential
// resolver kind from the catalog, mirroring the production
// resolveCatalogCredentialResolver. The top-level CredentialSource works for
// native client providers that declare no inference transport.
func forgeCatalogAuthResolver(providerID string) (auth.CredentialResolverKind, bool) {
	reg := catalog.DefaultRegistry()
	binding, err := reg.LookupBinding(providerID)
	if err != nil {
		return "", false
	}
	source := binding.CredentialSource()
	if source == "" {
		return "", false
	}
	return source, true
}

// === CodeBuddyActiveScope tests ===
//
// All fixtures below use synthetic identity/domain values only.

// cbv1Scope computes the documented canonical digest: SHA-256 over the UTF-8
// string "cbv1:" + payloadJSON, where payloadJSON has keys in the exact TS
// insertion order id, enterpriseId?, accountType?, idp?, domain?, environment.
func cbv1Scope(t *testing.T, payloadJSON string) string {
	t.Helper()
	sum := sha256.Sum256([]byte("cbv1:" + payloadJSON))
	return "cbv1:" + hex.EncodeToString(sum[:])
}

func scopeTestHome(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	setupForgedHome(t, home)
	t.Setenv("HOME", home)
	return home
}

func codebuddySyntheticProductAttributes() map[string]interface{} {
	return map[string]interface{}{
		"internalDomain":    []string{"enterprise.example.test", "*.enterprise.example.test"},
		"iOADomain":         []string{"*.ioa.auth.test"},
		"cloudHostedDomain": []string{"cloud.console.test", "*.cloud.console.test"},
		"externalDomain":    []string{"public.example", "*.public.example"},
	}
}

func writeScopeProductConfig(t *testing.T, attributes map[string]interface{}) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "product.json")
	cfg := map[string]interface{}{
		"authentication": map[string]interface{}{
			"attributes": attributes,
		},
	}
	data, err := json.Marshal(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func writeScopeAuthFile(t *testing.T, home string, payload map[string]interface{}) {
	t.Helper()
	dir := codebuddyTestAuthDir(t, home)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	data, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "Tencent-Cloud.coding-copilot.info")
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
}

func newScopeResolver(t *testing.T, productPath string) *auth.ProviderAuthStatusResolver {
	t.Helper()
	resolver := auth.NewProviderAuthStatusResolver(
		codebuddyCatalogAuthResolver,
		forgeDataDir,
		userHome,
	)
	resolver.CodeBuddyProductPath = productPath
	return resolver
}

// codebuddyScopeAuth returns a minimal synthetic auth payload in the real
// nested shape: the access token and domain live under "auth" while the active
// account object sits at the top level.
func codebuddyScopeAuth(uid, domain string) map[string]interface{} {
	return map[string]interface{}{
		"auth": map[string]interface{}{
			"accessToken": "synthetic-scope-token",
			"domain":      domain,
		},
		"account": map[string]interface{}{
			"uid": uid,
		},
	}
}

func TestCodeBuddyActiveScopeRealTopLevelAccountCanonicalVector(t *testing.T) {
	home := scopeTestHome(t)
	productPath := writeScopeProductConfig(t, codebuddySyntheticProductAttributes())
	writeScopeAuthFile(t, home, map[string]interface{}{
		"auth": map[string]interface{}{
			"accessToken":  "synthetic-access-token",
			"refreshToken": "synthetic-refresh-token",
			"expiration":   9999999999999,
			"domain":       "alice.enterprise.example.test",
		},
		"account": map[string]interface{}{
			"uid":            "uid-1111",
			"uin":            "uin-2222",
			"oneidAccountId": "oneid-3333",
			"enterpriseId":   "ent-123",
			"accountType":    "corp",
			"idp":            "idp-synthetic",
			"name":           "Alice Developer",
			"avatar":         "data:image/png;base64,c2VjcmV0",
		},
	})

	res := newScopeResolver(t, productPath).CodeBuddyActiveScope()
	if !res.OK {
		t.Fatalf("expected ok, got %+v", res)
	}
	if res.Environment != "internal" {
		t.Fatalf("environment=%q want internal", res.Environment)
	}

	// Canonical TS payload: keys in the exact order id, enterpriseId,
	// accountType, idp, domain, environment, hashed as cbv1:<sha256> over the
	// JSON {"id":"uid-1111","enterpriseId":"ent-123","accountType":"corp","idp":"idp-synthetic","domain":"alice.enterprise.example.test","environment":"internal"}.
	// The digest is pinned as a fixed literal anchor so any cross-language
	// drift in field order, normalization, or payload contents breaks here.
	const wantScope = "cbv1:84c83a54126ac8dbc9fca6986aae90c527e462d4490f2ab5c4c749bf7720b6f6"
	if res.Scope != wantScope {
		t.Fatalf("scope=%q want canonical digest %q", res.Scope, wantScope)
	}

	// The scope must never leak raw identity or domain material.
	joined := res.Scope + " " + res.Environment
	for _, forbidden := range []string{
		"uid-1111", "uin-2222", "oneid-3333", "ent-123", "idp-synthetic",
		"alice.enterprise.example.test", "synthetic-access-token",
		"synthetic-refresh-token", "Alice Developer", "c2VjcmV0",
	} {
		if strings.Contains(joined, forbidden) {
			t.Fatalf("scope/environment leaked %q: %s", forbidden, joined)
		}
	}
}

func TestCodeBuddyActiveScopeEnvironmentClassification(t *testing.T) {
	cases := []struct {
		name    string
		domain  string
		wantEnv string
		wantOK  bool
		payload string
	}{
		{"internal exact attribute", "enterprise.example.test", "internal", true, `{"id":"uid-c","domain":"enterprise.example.test","environment":"internal"}`},
		{"internal wildcard one label", "west.enterprise.example.test", "internal", true, `{"id":"uid-c","domain":"west.enterprise.example.test","environment":"internal"}`},
		{"internal wildcard never crosses dots", "deep.west.enterprise.example.test", "", false, ""},
		{"case sensitive exact", "Enterprise.Example.Test", "", false, ""},
		{"ioa wildcard one label", "alice.ioa.auth.test", "ioa", true, `{"id":"uid-c","domain":"alice.ioa.auth.test","environment":"ioa"}`},
		{"cloudhosted exact attribute", "cloud.console.test", "cloudhosted", true, `{"id":"uid-c","domain":"cloud.console.test","environment":"cloudhosted"}`},
		{"cloudhosted wildcard one label", "eu.cloud.console.test", "cloudhosted", true, `{"id":"uid-c","domain":"eu.cloud.console.test","environment":"cloudhosted"}`},
		{"external exact attribute", "public.example", "external", true, `{"id":"uid-c","domain":"public.example","environment":"external"}`},
		{"external wildcard one label", "alice.public.example", "external", true, `{"id":"uid-c","domain":"alice.public.example","environment":"external"}`},
		{"unrecognized environment fails closed", "random.example.test", "", false, ""},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			home := scopeTestHome(t)
			productPath := writeScopeProductConfig(t, codebuddySyntheticProductAttributes())
			writeScopeAuthFile(t, home, codebuddyScopeAuth("uid-c", tc.domain))

			res := newScopeResolver(t, productPath).CodeBuddyActiveScope()
			if res.OK != tc.wantOK {
				t.Fatalf("ok=%v want %v (res=%+v)", res.OK, tc.wantOK, res)
			}
			if !tc.wantOK {
				if res.Scope != "" || res.Environment != "" {
					t.Fatalf("failed-closed result must carry no scope/environment: %+v", res)
				}
				return
			}
			if res.Environment != tc.wantEnv {
				t.Fatalf("environment=%q want %q", res.Environment, tc.wantEnv)
			}
			// Absent optional keys are omitted while key order is preserved
			// (id, then domain, then environment).
			if want := cbv1Scope(t, tc.payload); res.Scope != want {
				t.Fatalf("scope=%q want %q", res.Scope, want)
			}
		})
	}
}

func TestCodeBuddyActiveScopeDomainMatchSemantics(t *testing.T) {
	cases := []struct {
		name       string
		attributes map[string]interface{}
		domain     string
		wantEnv    string
		wantOK     bool
	}{
		{
			name:       "wildcard never matches across dot labels",
			attributes: map[string]interface{}{"internalDomain": "*.enterprise.example.test"},
			domain:     "deep.west.enterprise.example.test",
			wantEnv:    "",
			wantOK:     false,
		},
		{
			name:       "wildcard matches one label",
			attributes: map[string]interface{}{"internalDomain": "*.enterprise.example.test"},
			domain:     "west.enterprise.example.test",
			wantEnv:    "internal",
			wantOK:     true,
		},
		{
			name:       "matching is case sensitive on the domain",
			attributes: map[string]interface{}{"internalDomain": "*.enterprise.example.test"},
			domain:     "West.Enterprise.Example.Test",
			wantEnv:    "",
			wantOK:     false,
		},
		{
			name:       "matching is case sensitive on the pattern",
			attributes: map[string]interface{}{"internalDomain": "*.Enterprise.Example.Test"},
			domain:     "west.enterprise.example.test",
			wantEnv:    "",
			wantOK:     false,
		},
		{
			name:       "exact equality is case sensitive",
			attributes: map[string]interface{}{"internalDomain": "Enterprise.Example.Test"},
			domain:     "Enterprise.Example.Test",
			wantEnv:    "internal",
			wantOK:     true,
		},
		{
			name:       "question mark retains regex quantifier semantics",
			attributes: map[string]interface{}{"externalDomain": "*.lab?.public.example"},
			domain:     "edge.lab.public.example",
			wantEnv:    "external",
			wantOK:     true,
		},
		{
			name:       "question mark quantifier may omit preceding character",
			attributes: map[string]interface{}{"externalDomain": "*.lab?.public.example"},
			domain:     "edge.la.public.example",
			wantEnv:    "external",
			wantOK:     true,
		},
		{
			name:       "question mark is not matched literally",
			attributes: map[string]interface{}{"externalDomain": "*.lab?.public.example"},
			domain:     "edge.lab?.public.example",
			wantEnv:    "",
			wantOK:     false,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			home := scopeTestHome(t)
			productPath := writeScopeProductConfig(t, tc.attributes)
			writeScopeAuthFile(t, home, codebuddyScopeAuth("uid-m", tc.domain))

			res := newScopeResolver(t, productPath).CodeBuddyActiveScope()
			if res.OK != tc.wantOK {
				t.Fatalf("ok=%v want %v (res=%+v)", res.OK, tc.wantOK, res)
			}
			if !tc.wantOK {
				if res.Scope != "" || res.Environment != "" {
					t.Fatalf("failed-closed result must carry no scope/environment: %+v", res)
				}
				return
			}
			if res.Environment != tc.wantEnv {
				t.Fatalf("environment=%q want %q", res.Environment, tc.wantEnv)
			}
		})
	}
}

func TestCodeBuddyActiveScopeFiniteNumericUIDNormalization(t *testing.T) {
	home := scopeTestHome(t)
	productPath := writeScopeProductConfig(t, codebuddySyntheticProductAttributes())
	writeScopeAuthFile(t, home, map[string]interface{}{
		"auth": map[string]interface{}{
			"accessToken": "synthetic-scope-token",
			"domain":      "enterprise.example.test",
		},
		"account": map[string]interface{}{
			"uid":          123456789,
			"enterpriseId": 1700,
		},
	})

	res := newScopeResolver(t, productPath).CodeBuddyActiveScope()
	if !res.OK {
		t.Fatalf("expected ok for numeric uid, got %+v", res)
	}
	if res.Environment != "internal" {
		t.Fatalf("environment=%q want internal", res.Environment)
	}
	// Numeric identity fields are normalized with JavaScript String(number)
	// decimal semantics before hashing.
	const canonicalPayload = `{"id":"123456789","enterpriseId":"1700","domain":"enterprise.example.test","environment":"internal"}`
	if want := cbv1Scope(t, canonicalPayload); res.Scope != want {
		t.Fatalf("scope=%q want %q", res.Scope, want)
	}
}

func TestCodeBuddyActiveScopeLegacyNestedFallback(t *testing.T) {
	home := scopeTestHome(t)
	productPath := writeScopeProductConfig(t, codebuddySyntheticProductAttributes())
	writeScopeAuthFile(t, home, map[string]interface{}{
		"auth": map[string]interface{}{
			"accessToken":  "nested-access-token",
			"domain":       "alice.ioa.auth.test",
			"enterpriseId": "ent-nested",
			"accountType":  "corp",
			"idp":          "idp-nested",
			"account": map[string]interface{}{
				"uin":            "uin-nested-42",
				"oneidAccountId": "oneid-nested-77",
			},
		},
	})

	res := newScopeResolver(t, productPath).CodeBuddyActiveScope()
	if !res.OK {
		t.Fatalf("expected ok for legacy nested shape, got %+v", res)
	}
	if res.Environment != "ioa" {
		t.Fatalf("environment=%q want ioa", res.Environment)
	}
	// No uid present: uin must resolve as the stable account id.
	want := cbv1Scope(t, `{"id":"uin-nested-42","enterpriseId":"ent-nested","accountType":"corp","idp":"idp-nested","domain":"alice.ioa.auth.test","environment":"ioa"}`)
	if res.Scope != want {
		t.Fatalf("scope=%q want %q", res.Scope, want)
	}
}

func TestCodeBuddyActiveScopeStableAcrossTokenRotation(t *testing.T) {
	home := scopeTestHome(t)
	productPath := writeScopeProductConfig(t, codebuddySyntheticProductAttributes())
	writeScopeAuthFile(t, home, map[string]interface{}{
		"auth": map[string]interface{}{
			"accessToken":  "token-version-one",
			"refreshToken": "refresh-version-one",
			"expiration":   1700000000001,
			"domain":       "team.enterprise.example.test",
		},
		"account": map[string]interface{}{
			"uid":          "uid-stable-7",
			"enterpriseId": "ent-rotate",
			"accountType":  "corp",
			"idp":          "idp-rotate",
		},
	})

	reads := 0
	resolver := newScopeResolver(t, productPath)
	resolver.ReadFile = func(p string) ([]byte, error) {
		reads++
		return os.ReadFile(p)
	}

	first := resolver.CodeBuddyActiveScope()
	if !first.OK {
		t.Fatalf("expected ok, got %+v", first)
	}
	if reads != 1 {
		t.Fatalf("expected exactly one auth-file read, got %d", reads)
	}

	// Rotate access/refresh tokens and expiry: same account and domain must
	// yield a byte-identical scope.
	writeScopeAuthFile(t, home, map[string]interface{}{
		"auth": map[string]interface{}{
			"accessToken":  "token-version-two-rotated",
			"refreshToken": "refresh-version-two-rotated",
			"expiration":   1700000009999,
			"domain":       "team.enterprise.example.test",
		},
		"account": map[string]interface{}{
			"uid":          "uid-stable-7",
			"enterpriseId": "ent-rotate",
			"accountType":  "corp",
			"idp":          "idp-rotate",
		},
	})
	second := resolver.CodeBuddyActiveScope()
	if !second.OK {
		t.Fatalf("expected ok after rotation, got %+v", second)
	}
	if reads != 2 {
		t.Fatalf("expected exactly one auth-file read per call, got %d", reads)
	}
	if second.Scope != first.Scope || second.Environment != first.Environment {
		t.Fatalf("token rotation changed scope/environment: %+v -> %+v", first, second)
	}
}

func TestCodeBuddyActiveScopeChangesOnAccountAndEnvironmentSwitch(t *testing.T) {
	home := scopeTestHome(t)
	productPath := writeScopeProductConfig(t, codebuddySyntheticProductAttributes())
	resolver := newScopeResolver(t, productPath)

	writeScopeAuthFile(t, home, codebuddyScopeAuth("uid-a", "alice.ioa.auth.test"))
	ioa := resolver.CodeBuddyActiveScope()
	if !ioa.OK || ioa.Environment != "ioa" {
		t.Fatalf("expected ioa scope, got %+v", ioa)
	}

	// Environment switch: same account id, different auth domain.
	writeScopeAuthFile(t, home, codebuddyScopeAuth("uid-a", "enterprise.example.test"))
	internal := resolver.CodeBuddyActiveScope()
	if !internal.OK || internal.Environment != "internal" {
		t.Fatalf("expected internal scope, got %+v", internal)
	}
	if internal.Scope == ioa.Scope {
		t.Fatal("domain/environment switch must change the scope")
	}

	// Account switch: different stable account id, same environment.
	writeScopeAuthFile(t, home, codebuddyScopeAuth("uid-b", "enterprise.example.test"))
	other := resolver.CodeBuddyActiveScope()
	if !other.OK || other.Environment != "internal" {
		t.Fatalf("expected internal scope for second account, got %+v", other)
	}
	if other.Scope == internal.Scope {
		t.Fatal("account switch must change the scope")
	}
}

func TestCodeBuddyActiveScopeFailsClosed(t *testing.T) {
	validAuth := codebuddyScopeAuth("uid-fail", "enterprise.example.test")
	cases := []struct {
		name    string
		product func() string
		auth    func(t *testing.T, home string)
	}{
		{
			name: "missing auth file",
			product: func() string {
				return writeScopeProductConfig(t, codebuddySyntheticProductAttributes())
			},
			auth: func(t *testing.T, home string) {},
		},
		{
			name: "missing access token",
			product: func() string {
				return writeScopeProductConfig(t, codebuddySyntheticProductAttributes())
			},
			auth: func(t *testing.T, home string) {
				payload := codebuddyScopeAuth("uid-fail", "enterprise.example.test")
				delete(payload["auth"].(map[string]interface{}), "accessToken")
				writeScopeAuthFile(t, home, payload)
			},
		},
		{
			name: "top-level token and domain are not read",
			product: func() string {
				return writeScopeProductConfig(t, codebuddySyntheticProductAttributes())
			},
			auth: func(t *testing.T, home string) {
				writeScopeAuthFile(t, home, map[string]interface{}{
					"accessToken": "synthetic-scope-token",
					"domain":      "enterprise.example.test",
					"account": map[string]interface{}{
						"uid": "uid-fail",
					},
				})
			},
		},
		{
			name: "missing stable account id",
			product: func() string {
				return writeScopeProductConfig(t, codebuddySyntheticProductAttributes())
			},
			auth: func(t *testing.T, home string) {
				writeScopeAuthFile(t, home, map[string]interface{}{
					"auth": map[string]interface{}{
						"accessToken": "synthetic-scope-token",
						"domain":      "enterprise.example.test",
					},
					"account": map[string]interface{}{
						"name": "No Stable Id",
					},
				})
			},
		},
		{
			name: "direct root identity is not read",
			product: func() string {
				return writeScopeProductConfig(t, codebuddySyntheticProductAttributes())
			},
			auth: func(t *testing.T, home string) {
				writeScopeAuthFile(t, home, map[string]interface{}{
					"auth": map[string]interface{}{
						"accessToken": "synthetic-scope-token",
						"domain":      "enterprise.example.test",
					},
					"uid":          "root-uid",
					"enterpriseId": "root-ent",
				})
			},
		},
		{
			name: "top-level domain is not read",
			product: func() string {
				return writeScopeProductConfig(t, codebuddySyntheticProductAttributes())
			},
			auth: func(t *testing.T, home string) {
				writeScopeAuthFile(t, home, map[string]interface{}{
					"auth": map[string]interface{}{
						"accessToken": "synthetic-scope-token",
					},
					"domain": "enterprise.example.test",
					"account": map[string]interface{}{
						"uid": "uid-fail",
					},
				})
			},
		},
		{
			name: "missing product config",
			product: func() string {
				return filepath.Join(t.TempDir(), "no-such-product.json")
			},
			auth: func(t *testing.T, home string) {
				writeScopeAuthFile(t, home, validAuth)
			},
		},
		{
			name: "missing product attributes",
			product: func() string {
				return writeScopeProductConfig(t, map[string]interface{}{})
			},
			auth: func(t *testing.T, home string) {
				writeScopeAuthFile(t, home, validAuth)
			},
		},
		{
			name: "unrecognized environment",
			product: func() string {
				return writeScopeProductConfig(t, codebuddySyntheticProductAttributes())
			},
			auth: func(t *testing.T, home string) {
				writeScopeAuthFile(t, home, codebuddyScopeAuth("uid-fail", "random.example.test"))
			},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			home := scopeTestHome(t)
			tc.auth(t, home)
			res := newScopeResolver(t, tc.product()).CodeBuddyActiveScope()
			if res.OK {
				t.Fatalf("expected fail-closed result, got %+v", res)
			}
			if res.Scope != "" || res.Environment != "" {
				t.Fatalf("failed result must not expose partial scope/environment: %+v", res)
			}
		})
	}
}
