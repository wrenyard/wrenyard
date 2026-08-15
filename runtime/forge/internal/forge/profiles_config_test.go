package forge

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/profiles/config"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/profiles/manifest"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/catalog"
)

func TestEmbeddedCCKimiProfile(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("XDG_CONFIG_HOME", "")
	t.Setenv("XDG_DATA_HOME", t.TempDir())

	reg := catalog.DefaultRegistry()
	provider, err := reg.LookupBinding("kimi-coding")
	if err != nil {
		t.Fatal(err)
	}
	if provider.Inference == nil || provider.Inference.Protocol != "anthropic-messages" {
		t.Fatalf("kimi-coding protocol = %q, want anthropic-messages", provider.Inference.Protocol)
	}
	if provider.Inference.Endpoint != "https://api.kimi.com/coding/v1/messages" {
		t.Fatalf("kimi-coding inference endpoint = %q, want full Anthropic request endpoint https://api.kimi.com/coding/v1/messages", provider.Inference.Endpoint)
	}
	if !contains(provider.AllowedModels, "k3") {
		t.Fatalf("kimi-coding allowed models missing k3")
	}
	if !contains(provider.AllowedModels, "k3[1m]") {
		t.Fatalf("kimi-coding allowed models missing k3[1m]")
	}

	manifest, err := loadManifest()
	if err != nil {
		t.Fatal(err)
	}
	p, ok := manifest.Profiles["cc-kimi"]
	if !ok {
		t.Fatalf("embedded profiles should include cc-kimi: %#v", sortedProfileKeys(manifest.Profiles))
	}
	if p.Client != "claude" || p.Provider != "kimi-coding" {
		t.Fatalf("cc-kimi client/provider = %s/%s, want claude/kimi-coding", p.Client, p.Provider)
	}
	if p.Env["ANTHROPIC_BASE_URL"] != "https://api.kimi.com/coding/" {
		t.Fatalf("cc-kimi ANTHROPIC_BASE_URL = %q, want Claude base https://api.kimi.com/coding/", p.Env["ANTHROPIC_BASE_URL"])
	}
	if p.Env["ANTHROPIC_API_KEY"] != "" {
		t.Fatalf("cc-kimi should source ANTHROPIC_API_KEY from Forge auth, got literal %q", p.Env["ANTHROPIC_API_KEY"])
	}
	if p.Env["ANTHROPIC_MODEL"] != "k3[1m]" || p.Env["CLAUDE_CODE_SUBAGENT_MODEL"] != "k3[1m]" {
		t.Fatalf("cc-kimi model env not configured for Kimi: %#v", p.Env)
	}
	if p.Env["CLAUDE_CODE_AUTO_COMPACT_WINDOW"] != "1048576" {
		t.Fatalf("cc-kimi CLAUDE_CODE_AUTO_COMPACT_WINDOW = %q", p.Env["CLAUDE_CODE_AUTO_COMPACT_WINDOW"])
	}
	if p.Env["CLAUDE_CODE_MAX_CONTEXT_TOKENS"] != "1048576" {
		t.Fatalf("cc-kimi CLAUDE_CODE_MAX_CONTEXT_TOKENS = %q", p.Env["CLAUDE_CODE_MAX_CONTEXT_TOKENS"])
	}
	wantOverrides := map[string]interface{}{
		"claude-opus-4-8":   "k3[1m]",
		"claude-sonnet-4-6": "k3[1m]",
		"claude-haiku-4-5":  "k3[1m]",
	}
	if got := p.Settings["modelOverrides"]; !reflect.DeepEqual(got, wantOverrides) {
		t.Fatalf("cc-kimi modelOverrides = %#v, want %#v", got, wantOverrides)
	}
}

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

// TestEmbeddedProfiles_CodexProvider ensures the embedded profiles.json
// has provider: "codex" for the main codex family profiles and
// provider: "codex-spark" for the codex-spark distinct pool.
// This guards against accidental drift to a stale API-provider value
// that would cause setup to materialize wrong template content.
func TestEmbeddedProfiles_CodexProvider(t *testing.T) {
	manifest := *manifest.BuiltinManifest()

	codexProfiles := []string{
		"codex-sol", "codex-terra", "codex-luna",
	}
	for _, name := range codexProfiles {
		p, ok := manifest.Profiles[name]
		if !ok {
			t.Errorf("embedded profiles missing profile %q", name)
			continue
		}
		if p.Provider != "codex" {
			t.Errorf("profile %q has provider=%q, want \"codex\" — embedded profiles.json is stale", name, p.Provider)
		}
	}

	// codex-spark uses its own distinct provider pool.
	if p, ok := manifest.Profiles["codex-spark"]; !ok {
		t.Error("embedded profiles missing profile \"codex-spark\"")
	} else if p.Provider != "codex-spark" {
		t.Errorf("codex-spark has provider=%q, want \"codex-spark\" — embedded profiles.json is stale", p.Provider)
	}
}

func TestEmbeddedConfigDoesNotIncludeNativeOpenAIProvider(t *testing.T) {
	reg := catalog.DefaultRegistry()
	if _, err := reg.LookupBinding("openai"); err == nil {
		t.Fatal("catalog registry should not include native OpenAI API provider")
	}
}

func TestOpenAIProviderIsNotManagedOrMigrated(t *testing.T) {
	if IsManagedProvider("openai") {
		t.Fatal("openai should not be a Forge-managed provider")
	}
	if got := legacyKeyToProviderID("openai-api-key"); got != "" {
		t.Fatalf("legacyKeyToProviderID(openai-api-key) = %q, want empty", got)
	}
}

func TestNoOldInteractiveClaudeProfiles(t *testing.T) {
	manifest := *manifest.BuiltinManifest()
	// These old interactive profiles should not exist in the new embedded set.
	for _, name := range []string{"ccds", "ccg", "cck", "ccc", "oc", "oc-gpt"} {
		if _, ok := manifest.Profiles[name]; ok {
			t.Fatalf("removed profile %q should not be in embedded profiles", name)
		}
	}
}

func TestCCGLMProfileIsInEmbeddedSet(t *testing.T) {
	manifest := *manifest.BuiltinManifest()
	p, ok := manifest.Profiles["cc-glm"]
	if !ok {
		t.Fatal("cc-glm should be in embedded profiles")
	}
	if p.Client != "claude" || p.Provider != "zhipu-coding" {
		t.Fatalf("cc-glm client/provider = %s/%s, want claude/zhipu-coding", p.Client, p.Provider)
	}
	if p.Env["ANTHROPIC_BASE_URL"] != "https://open.bigmodel.cn/api/anthropic" {
		t.Fatalf("cc-glm ANTHROPIC_BASE_URL = %q, want Claude base https://open.bigmodel.cn/api/anthropic", p.Env["ANTHROPIC_BASE_URL"])
	}
}

// TestClaudeProfilesRouteContract guards the route contract for the Claude Code
// (claude) profiles: the ANTHROPIC_BASE_URL the Claude client consumes must be
// the API base (Claude Code appends /v1/messages), while provider inference and
// raw bindings must carry complete request endpoints.
func TestClaudeProfilesRouteContract(t *testing.T) {
	reg := catalog.DefaultRegistry()

	// Manifest profiles must point Claude Code at Anthropic-compatible API bases.
	m := manifest.BuiltinManifest()
	if got := m.Profiles["cc-kimi"].Env["ANTHROPIC_BASE_URL"]; got != "https://api.kimi.com/coding/" {
		t.Fatalf("cc-kimi ANTHROPIC_BASE_URL = %q, want Claude base https://api.kimi.com/coding/", got)
	}
	if got := m.Profiles["cc-glm"].Env["ANTHROPIC_BASE_URL"]; got != "https://open.bigmodel.cn/api/anthropic" {
		t.Fatalf("cc-glm ANTHROPIC_BASE_URL = %q, want Claude base https://open.bigmodel.cn/api/anthropic", got)
	}

	// Provider inference bindings must carry the complete Anthropic endpoint
	// (base + /v1/messages), not the base URL.
	kimi, err := reg.LookupBinding("kimi-coding")
	if err != nil {
		t.Fatal(err)
	}
	if kimi.Inference == nil || kimi.Inference.Endpoint != "https://api.kimi.com/coding/v1/messages" {
		t.Fatalf("kimi-coding inference endpoint = %q, want https://api.kimi.com/coding/v1/messages", kimi.Inference.Endpoint)
	}
	zhipu, err := reg.LookupBinding("zhipu-coding")
	if err != nil {
		t.Fatal(err)
	}
	if zhipu.Inference == nil || zhipu.Inference.Endpoint != "https://open.bigmodel.cn/api/anthropic/v1/messages" {
		t.Fatalf("zhipu-coding inference endpoint = %q, want https://open.bigmodel.cn/api/anthropic/v1/messages", zhipu.Inference.Endpoint)
	}

	// Raw bindings must also be complete request endpoints.
	if got := rawEndpoint(kimi, catalog.RawLLMProtocolOpenAI); got != "https://api.kimi.com/coding/v1/chat/completions" {
		t.Fatalf("kimi-coding OpenAI raw endpoint = %q, want https://api.kimi.com/coding/v1/chat/completions", got)
	}
	if got := rawEndpoint(kimi, catalog.RawLLMProtocolAnthropic); got != "https://api.kimi.com/coding/v1/messages" {
		t.Fatalf("kimi-coding Anthropic raw endpoint = %q, want https://api.kimi.com/coding/v1/messages", got)
	}
	if got := rawEndpoint(zhipu, catalog.RawLLMProtocolAnthropic); got != "https://open.bigmodel.cn/api/anthropic/v1/messages" {
		t.Fatalf("zhipu-coding Anthropic raw endpoint = %q, want https://open.bigmodel.cn/api/anthropic/v1/messages", got)
	}
}

func rawEndpoint(binding catalog.Provider, protocol catalog.RawLLMProtocol) string {
	for _, c := range binding.RawLLM {
		if c.Protocol == protocol {
			return c.BaseEndpoint
		}
	}
	return ""
}

func TestNewCodexSolTerraLunaProfilesExist(t *testing.T) {
	manifest := *manifest.BuiltinManifest()
	for _, name := range []string{"codex-sol", "codex-terra", "codex-luna"} {
		p, ok := manifest.Profiles[name]
		if !ok {
			t.Fatalf("checked-in profiles should include %s", name)
		}
		if p.Env["CODEX_REASONING_EFFORT"] != "xhigh" {
			t.Fatalf("%s should use xhigh reasoning, got %q", name, p.Env["CODEX_REASONING_EFFORT"])
		}
	}
	// Verify models
	if p, ok := manifest.Profiles["codex-sol"]; ok {
		if p.Env["CODEX_MODEL"] != "gpt-5.6-sol" {
			t.Fatalf("codex-sol model = %q, want gpt-5.6-sol", p.Env["CODEX_MODEL"])
		}
	}
	if p, ok := manifest.Profiles["codex-terra"]; ok {
		if p.Env["CODEX_MODEL"] != "gpt-5.6-terra" {
			t.Fatalf("codex-terra model = %q, want gpt-5.6-terra", p.Env["CODEX_MODEL"])
		}
	}
	if p, ok := manifest.Profiles["codex-luna"]; ok {
		if p.Env["CODEX_MODEL"] != "gpt-5.6-luna" {
			t.Fatalf("codex-luna model = %q, want gpt-5.6-luna", p.Env["CODEX_MODEL"])
		}
	}
}

func TestCBGLMProfileIsRemoved(t *testing.T) {
	manifest := *manifest.BuiltinManifest()
	if _, ok := manifest.Profiles["cb-glm"]; ok {
		t.Fatal("cb-glm should be removed from embedded profiles")
	}
}

func TestManagedProfileNamesCanDiscoverCodexVariants(t *testing.T) {
	manifest, err := loadManifest()
	if err != nil {
		t.Fatal(err)
	}
	names := availableProfileNames(manifest)
	for _, want := range []string{"codex-sol", "codex-terra", "codex-luna", "codex-spark"} {
		if !contains(names, want) {
			t.Fatalf("expected available profile list to include %s, got %#v", want, names)
		}
	}
}

func TestCodexVariantsUseProfileV2Overlays(t *testing.T) {
	manifest := *manifest.BuiltinManifest()
	cases := []struct {
		name      string
		wantModel string
	}{
		{name: "codex-sol", wantModel: "gpt-5.6-sol"},
		{name: "codex-terra", wantModel: "gpt-5.6-terra"},
		{name: "codex-luna", wantModel: "gpt-5.6-luna"},
		{name: "codex-spark", wantModel: "gpt-5.3-codex-spark"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			p, ok := manifest.Profiles[tc.name]
			if !ok {
				t.Fatalf("builtin profiles should include %s", tc.name)
			}
			// Assert no legacy --profile-v2 overlay in launcher.
			if launcherArgs, ok := p.Launcher["default_args"]; ok {
				if args, ok := launcherArgs.([]any); ok {
					for _, arg := range args {
						if s, ok := arg.(string); ok && s == "--profile-v2" {
							t.Fatalf("%s should not use --profile-v2 overlay, got default_args: %v", tc.name, args)
						}
					}
				}
			}
			// Assert xhigh reasoning effort.
			if p.Env["CODEX_REASONING_EFFORT"] != "xhigh" {
				t.Fatalf("%s CODEX_REASONING_EFFORT = %q, want xhigh", tc.name, p.Env["CODEX_REASONING_EFFORT"])
			}
			// Assert exact model.
			if p.Env["CODEX_MODEL"] != tc.wantModel {
				t.Fatalf("%s CODEX_MODEL = %q, want %s", tc.name, p.Env["CODEX_MODEL"], tc.wantModel)
			}
			// Build plan and verify command-plan behavior.
			plan, err := buildDirectRunPlan(directPlanInput{Profile: tc.name, Prompt: "work", CWD: t.TempDir()})
			if err != nil {
				t.Fatal(err)
			}
			if len(plan.Command) == 0 || plan.Command[0] != "codex" || !contains(plan.Command, "exec") {
				t.Fatalf("unexpected codex agent command for %s: %v", tc.name, plan.Command)
			}
			if !containsOrdered(plan.Command, "--model", tc.wantModel) {
				t.Fatalf("unexpected codex model for %s: got command %v want model %s", tc.name, plan.Command, tc.wantModel)
			}
			if plan.Env["FORGE_PROFILE"] != tc.name {
				t.Fatalf("unexpected FORGE_PROFILE for %s: %v", tc.name, plan.Env)
			}
			// Assert no --profile-v2 in command.
			for _, arg := range plan.Command {
				if arg == "--profile-v2" {
					t.Fatalf("%s command should not contain --profile-v2, got: %v", tc.name, plan.Command)
				}
			}
		})
	}
}

func TestRemovedCodexProfilesNotInEmbeddedSet(t *testing.T) {
	manifest := *manifest.BuiltinManifest()
	for _, name := range []string{"codex", "codex-high", "codex-xhigh", "codex-lite", "codex-mini"} {
		if _, ok := manifest.Profiles[name]; ok {
			t.Fatalf("removed profile %q should not be in embedded profiles", name)
		}
	}
}

func TestNoRetiredOCProfiles(t *testing.T) {
	manifest := *manifest.BuiltinManifest()
	if _, ok := manifest.Profiles["oc-gpt"]; ok {
		t.Fatal("oc-gpt should be removed from embedded profiles")
	}
	if _, ok := manifest.Profiles["oc"]; ok {
		t.Fatal("oc should be removed from embedded profiles")
	}
}

func TestCustomProfileCapabilitiesAccepted(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("XDG_CONFIG_HOME", "")
	t.Setenv("XDG_DATA_HOME", t.TempDir())
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	data := `{
		"clients": {"grok": {"enabled": true}},
		"profiles": {
			"ure-qa": {"client": "grok", "provider": "zhipu-coding", "model": "glm-5.3", "capabilities": ["ure-internal-qa"]}
		}
	}`
	if err := os.WriteFile(path, []byte(data), 0o644); err != nil {
		t.Fatal(err)
	}
	cfg, _, err := config.LoadForgeConfig(path, config.EmbeddedData(), &strings.Builder{})
	if err != nil {
		t.Fatalf("LoadForgeConfig with capabilities: %v", err)
	}
	recipe, ok := cfg.Profiles["ure-qa"]
	if !ok {
		t.Fatal("expected ure-qa profile")
	}
	if len(recipe.Capabilities) != 1 || recipe.Capabilities[0] != "ure-internal-qa" {
		t.Fatalf("capabilities = %#v, want [ure-internal-qa]", recipe.Capabilities)
	}
	// Verify profile is synthesizable with capabilities.
	reg := catalog.DefaultRegistry()
	manifestResult, err := manifest.LoadManifest(manifest.LoadDeps{Recipes: cfg.Profiles, Registry: reg})
	if err != nil {
		t.Fatalf("LoadManifest with capabilities: %v", err)
	}
	p, ok := manifestResult.Profiles["ure-qa"]
	if !ok {
		t.Fatal("expected ure-qa in manifest")
	}
	if len(p.Capabilities) != 1 || p.Capabilities[0] != "ure-internal-qa" {
		t.Fatalf("manifest profile capabilities = %#v, want [ure-internal-qa]", p.Capabilities)
	}
}

func TestCustomProfileCapabilitiesOmittedRemainsCompatible(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("XDG_CONFIG_HOME", "")
	t.Setenv("XDG_DATA_HOME", t.TempDir())
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	data := `{
		"clients": {"grok": {"enabled": true}},
		"profiles": {
			"ure-base": {"client": "grok", "provider": "zhipu-coding", "model": "glm-5.3"}
		}
	}`
	if err := os.WriteFile(path, []byte(data), 0o644); err != nil {
		t.Fatal(err)
	}
	cfg, _, err := config.LoadForgeConfig(path, config.EmbeddedData(), &strings.Builder{})
	if err != nil {
		t.Fatalf("LoadForgeConfig without capabilities: %v", err)
	}
	recipe := cfg.Profiles["ure-base"]
	if len(recipe.Capabilities) != 0 {
		t.Fatalf("expected no capabilities for omitted field, got %#v", recipe.Capabilities)
	}
	reg := catalog.DefaultRegistry()
	manifestResult, err := manifest.LoadManifest(manifest.LoadDeps{Recipes: cfg.Profiles, Registry: reg})
	if err != nil {
		t.Fatalf("LoadManifest without capabilities: %v", err)
	}
	p := manifestResult.Profiles["ure-base"]
	if len(p.Capabilities) != 0 {
		t.Fatalf("expected no capabilities in synthesized profile, got %#v", p.Capabilities)
	}
}

func TestCustomProfileCapabilitiesRejectsUnknownFields(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	data := `{
		"profiles": {
			"bad": {"client": "grok", "provider": "zhipu-coding", "model": "glm-5.3", "launcher": {"command": "evil"}}
		}
	}`
	if err := os.WriteFile(path, []byte(data), 0o644); err != nil {
		t.Fatal(err)
	}
	_, _, err := config.LoadForgeConfig(path, config.EmbeddedData(), &strings.Builder{})
	if err == nil {
		t.Fatal("expected error for unknown field launcher")
	}
}

func TestValidateCapabilitiesRejectsEmpty(t *testing.T) {
	_, err := config.ValidateCapabilities([]string{"valid", "", "also-valid"})
	if err == nil {
		t.Fatal("expected error for empty capability name")
	}
}

func TestValidateCapabilitiesRejectsDuplicate(t *testing.T) {
	_, err := config.ValidateCapabilities([]string{"dup", "dup"})
	if err == nil {
		t.Fatal("expected error for duplicate capability name")
	}
}

func TestValidateCapabilitiesReturnsNilForEmpty(t *testing.T) {
	result, err := config.ValidateCapabilities(nil)
	if err != nil || result != nil {
		t.Fatalf("ValidateCapabilities(nil) = %#v, %v", result, err)
	}
	result, err = config.ValidateCapabilities([]string{})
	if err != nil || result != nil {
		t.Fatalf("ValidateCapabilities([]) = %#v, %v", result, err)
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
	if len(binding.RawLLM) != 0 {
		t.Fatalf("custom provider must not declare raw LLM capability, got %#v", binding.RawLLM)
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

func TestManifestProfileUsesCustomProvider(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("XDG_CONFIG_HOME", "")
	t.Setenv("XDG_DATA_HOME", t.TempDir())
	path := writeTempConfig(t, `{
		"clients": {"codebuddy": {"enabled": true}},
		"custom_providers": {
			"codebuddy-local": {"client": "codebuddy", "models": ["deepseek-v4-flash"]}
		},
		"profiles": {
			"cb-local": {"client": "codebuddy", "provider": "codebuddy-local", "model": "deepseek-v4-flash"}
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
	manifestResult, err := manifest.LoadManifest(manifest.LoadDeps{Recipes: cfg.Profiles, Registry: reg})
	if err != nil {
		t.Fatalf("LoadManifest: %v", err)
	}
	p, ok := manifestResult.Profiles["cb-local"]
	if !ok {
		t.Fatal("expected cb-local profile")
	}
	if p.Client != "codebuddy" || p.Provider != "codebuddy-local" {
		t.Fatalf("cb-local client/provider = %s/%s, want codebuddy/codebuddy-local", p.Client, p.Provider)
	}
	if p.Env["ANTHROPIC_MODEL"] != "deepseek-v4-flash" {
		t.Fatalf("cb-local ANTHROPIC_MODEL = %q, want deepseek-v4-flash", p.Env["ANTHROPIC_MODEL"])
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

func TestSameNameCBRecipeOverrideCarriesAnthropicModel(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("XDG_CONFIG_HOME", "")
	t.Setenv("XDG_DATA_HOME", t.TempDir())
	path := writeTempConfig(t, `{
		"clients": {"codebuddy": {"enabled": true}},
		"profiles": {
			"cb-hy": {"client": "codebuddy", "provider": "codebuddy", "model": "hunyuan-chat", "description": "CodeBuddy Hunyuan override"}
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
	manifestResult, err := manifest.LoadManifest(manifest.LoadDeps{Recipes: cfg.Profiles, Registry: reg})
	if err != nil {
		t.Fatalf("LoadManifest: %v", err)
	}
	p, ok := manifestResult.Profiles["cb-hy"]
	if !ok {
		t.Fatal("expected overridden cb-hy profile")
	}
	if p.Provider != "codebuddy" {
		t.Fatalf("cb-hy provider = %q, want codebuddy", p.Provider)
	}
	if p.Env["ANTHROPIC_MODEL"] != "hunyuan-chat" {
		t.Fatalf("cb-hy ANTHROPIC_MODEL = %q, want hunyuan-chat", p.Env["ANTHROPIC_MODEL"])
	}
}
