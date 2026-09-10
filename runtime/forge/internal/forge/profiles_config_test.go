package forge

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/profiles/config"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/catalog"
)

func TestCodexConfigCheckOK(t *testing.T) {
	home := t.TempDir()
	bin := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("PATH", bin)
	t.Setenv("CODEX_HOME", "")
	if err := os.MkdirAll(filepath.Join(home, ".codex"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, ".codex", "auth.json"), []byte(`{"tokens":{"access_token":"fake-token"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	writeFakeCodexExecutable(t, bin, true)

	check := codexConfigCheck()
	if check["status"] != "ok" {
		t.Fatalf("expected codex config check ok, got %#v", check)
	}
}

func TestCodexConfigCheckReportsMissingAuth(t *testing.T) {
	home := t.TempDir()
	bin := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("PATH", bin)
	t.Setenv("CODEX_HOME", "")
	writeFakeCodexExecutable(t, bin, true)

	check := codexConfigCheck()
	if check["status"] != "warning" {
		t.Fatalf("expected missing auth warning, got %#v", check)
	}
	message, _ := check["message"].(string)
	if !strings.Contains(message, "not logged in") {
		t.Fatalf("expected login warning, got %#v", check)
	}
}

func TestCodexConfigCheckRespectsCodexHome(t *testing.T) {
	home := t.TempDir()
	codexHome := t.TempDir()
	bin := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("CODEX_HOME", codexHome)
	t.Setenv("PATH", bin)
	writeFakeCodexExecutable(t, bin, true)
	if err := os.WriteFile(filepath.Join(codexHome, "auth.json"), []byte(`{"tokens":{"access_token":"fake-token"}}`), 0o600); err != nil {
		t.Fatal(err)
	}

	check := codexConfigCheck()
	if check["status"] != "ok" {
		t.Fatalf("expected auth under CODEX_HOME to be accepted, got %#v", check)
	}
}

func TestOfficialOpenAIAPIProviderIsSeparateFromCodex(t *testing.T) {
	reg := catalog.DefaultRegistry()
	openai, err := reg.LookupBinding("openai")
	if err != nil {
		t.Fatal("catalog registry should include the official OpenAI API provider")
	}
	codex, err := reg.LookupBinding("chatgpt")
	if err != nil {
		t.Fatal(err)
	}
	if openai.CredentialSource() == codex.CredentialSource() {
		t.Fatal("official OpenAI API keys must remain separate from Codex native login")
	}
}

func TestOpenAIProviderIsManagedWithoutLegacyMigration(t *testing.T) {
	if !IsManagedProvider("openai") {
		t.Fatal("openai should accept a Forge-managed official API key")
	}
	if got := legacyKeyToProviderID("openai-api-key"); got != "" {
		t.Fatalf("legacyKeyToProviderID(openai-api-key) = %q, want empty", got)
	}
}

func TestUserConfigDirRespectsXDG(t *testing.T) {
	home := t.TempDir()
	xdgConfig := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", xdgConfig)

	got := userConfigDir()
	want := filepath.Join(xdgConfig, "wrenyard", "runtime")
	if got != want {
		t.Fatalf("userConfigDir with XDG_CONFIG_HOME: got %q, want %q", got, want)
	}

	t.Setenv("XDG_CONFIG_HOME", "")
	got = userConfigDir()
	want = filepath.Join(home, ".config", "wrenyard", "runtime")
	if got != want {
		t.Fatalf("userConfigDir without XDG_CONFIG_HOME: got %q, want %q", got, want)
	}
}

// writeTempConfig writes a local user config.json for tests dedicated to
// custom config, returning its path.
func writeTempConfig(t *testing.T, data string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "config.json")
	if err := os.WriteFile(path, []byte(data), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestCustomProviderRegistersIntoCatalog(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("XDG_CONFIG_HOME", "")
	t.Setenv("XDG_DATA_HOME", t.TempDir())
	path := writeTempConfig(t, `{
		"clients": {"codebuddy": {"enabled": true}},
		"custom_providers": {
			"codebuddy-local": {"client": "codebuddy", "models": ["deepseek-v4-flash", "deepseek-v4-pro"]}
		}
	}`)
	cfg, _, err := config.LoadForgeConfig(path, config.EmbeddedData(), &strings.Builder{})
	if err != nil {
		t.Fatalf("LoadForgeConfig: %v", err)
	}
	reg, err := catalogRegistryForConfig(cfg)
	if err != nil {
		t.Fatalf("catalogRegistryForConfig: %v", err)
	}
	binding, err := reg.LookupBinding("codebuddy-local")
	if err != nil {
		t.Fatal(err)
	}
	if !binding.UsesClientBinary() {
		t.Fatal("custom provider must use the client binary")
	}
	if binding.Inference != nil {
		t.Fatal("custom provider must not declare inference transport")
	}
	if source := binding.CredentialSource(); source != catalog.CredentialResolverCodeBuddy {
		t.Fatalf("custom provider credential source = %q, want codebuddy", source)
	}
	if !binding.SupportsDialect(catalog.DialectCodeBuddy) {
		t.Fatal("custom provider must support the codebuddy dialect")
	}
	models := reg.ProviderModels("codebuddy-local")
	if len(models) != 2 {
		t.Fatalf("custom provider models = %v, want 2", models)
	}
	for _, id := range []string{"deepseek-v4-flash", "deepseek-v4-pro"} {
		if _, ok := models[id]; !ok {
			t.Fatalf("custom provider models missing %q", id)
		}
	}
}

func TestCustomProviderRejectsUnknownClient(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("XDG_CONFIG_HOME", "")
	t.Setenv("XDG_DATA_HOME", t.TempDir())
	path := writeTempConfig(t, `{
		"custom_providers": {
			"custom-x": {"client": "no-such-client", "models": ["m1"]}
		}
	}`)
	cfg, _, err := config.LoadForgeConfig(path, config.EmbeddedData(), &strings.Builder{})
	if err != nil {
		t.Fatalf("LoadForgeConfig: %v", err)
	}
	_, err = catalogRegistryForConfig(cfg)
	if err == nil {
		t.Fatal("expected error for unknown custom provider client")
	}
	if !strings.Contains(err.Error(), "custom_providers.custom-x.client") {
		t.Fatalf("error %q should be path-specific to custom_providers.custom-x.client", err)
	}
}

func TestCustomProviderRejectsEmptyAndDuplicateModels(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("XDG_CONFIG_HOME", "")
	t.Setenv("XDG_DATA_HOME", t.TempDir())
	for name, data := range map[string]string{
		"empty": `{
			"custom_providers": {"custom-x": {"client": "codebuddy", "models": []}}
		}`,
		"empty-id": `{
			"custom_providers": {"custom-x": {"client": "codebuddy", "models": ["  "]}}
		}`,
		"duplicate": `{
			"custom_providers": {"custom-x": {"client": "codebuddy", "models": ["m1", "m1"]}}
		}`,
	} {
		path := writeTempConfig(t, data)
		cfg, _, err := config.LoadForgeConfig(path, config.EmbeddedData(), &strings.Builder{})
		if err != nil {
			t.Fatalf("%s: LoadForgeConfig: %v", name, err)
		}
		if _, err := catalogRegistryForConfig(cfg); err == nil {
			t.Fatalf("%s: expected error for invalid models", name)
		}
	}
}

func TestCustomProviderRejectsBuiltinIDCollision(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("XDG_CONFIG_HOME", "")
	t.Setenv("XDG_DATA_HOME", t.TempDir())
	path := writeTempConfig(t, `{
		"custom_providers": {
			"codebuddy": {"client": "codebuddy", "models": ["deepseek-v4-flash"]}
		}
	}`)
	cfg, _, err := config.LoadForgeConfig(path, config.EmbeddedData(), &strings.Builder{})
	if err != nil {
		t.Fatalf("LoadForgeConfig: %v", err)
	}
	_, err = catalogRegistryForConfig(cfg)
	if err == nil {
		t.Fatal("expected error for custom provider id colliding with builtin")
	}
	if !strings.Contains(err.Error(), "collides with a builtin provider") {
		t.Fatalf("error %q should mention builtin collision", err)
	}
}
