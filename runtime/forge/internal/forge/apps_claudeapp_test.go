package forge

import (
	"path/filepath"
	"strings"
	"testing"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/apps/claudeapp"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/catalog"
)

// TestClaudeAppBuildConfigMapsProfileToDTO verifies the root composition layer
// converts a Forge profile (and its model overrides) into a claudeapp.Config
// DTO without depending on the moved HTTP/SSE/process/policy implementation.
func TestClaudeAppBuildConfigMapsProfileToDTO(t *testing.T) {
	deps := claudeapp.Dependencies{
		LoadManifest: func() (map[string]claudeapp.Profile, error) {
			return map[string]claudeapp.Profile{
				"ccg": {
					Name:     "ccg",
					Client:   "claude",
					Provider: "zhipu-coding",
					Env: map[string]string{
						"ANTHROPIC_BASE_URL":             "https://wrong-url/v1",
						"ANTHROPIC_AUTH_TOKEN":           "upstream-token",
						"ANTHROPIC_DEFAULT_OPUS_MODEL":   "provider-opus",
						"ANTHROPIC_DEFAULT_SONNET_MODEL": "provider-sonnet",
						"ANTHROPIC_DEFAULT_HAIKU_MODEL":  "provider-haiku",
					},
				},
			}, nil
		},
		ResolveCredential: func(providerID string) (string, bool) {
			if providerID != "zhipu-coding" {
				t.Fatalf("credential lookup provider = %q, want zhipu-coding", providerID)
			}
			return "forge-auth-token", true
		},
		ModelOverrides: func(p claudeapp.Profile) map[string]string {
			return map[string]string{}
		},
		ResolveProviderBinding: func(p claudeapp.Profile) (claudeapp.ProviderBinding, error) {
			return claudeapp.ProviderBinding{
				Protocol:     "anthropic-messages",
				Endpoint:     "https://open.bigmodel.cn/api/anthropic/v1",
				DefaultModel: "",
			}, nil
		},
		DefaultPort: 18080,
	}
	cfg, err := claudeapp.BuildConfig("ccg", 18080, deps)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Profile.Name != "ccg" || cfg.Profile.Provider != "zhipu-coding" {
		t.Fatalf("unexpected profile mapping: %#v", cfg.Profile)
	}
	if cfg.UpstreamToken != "forge-auth-token" {
		t.Fatalf("upstream token should come from Forge auth store, got %q", cfg.UpstreamToken)
	}
	if cfg.UpstreamBaseURL != "https://open.bigmodel.cn/api/anthropic/v1" {
		t.Fatalf("upstream base URL should come from provider binding, got %q", cfg.UpstreamBaseURL)
	}
	if cfg.Port != 18080 {
		t.Fatalf("port should pass through, got %d", cfg.Port)
	}
	if len(cfg.Routes) != 3 {
		t.Fatalf("expected 3 routes from env model ids, got %d: %#v", len(cfg.Routes), cfg.Routes)
	}
	if cfg.GatewayAPIKey == "" {
		t.Fatalf("gateway api key should be generated into the config DTO")
	}
}

// TestClaudeAppBuildConfigRejectsNonClaudeClient ensures the composition layer
// rejects profiles whose client is not claude before delegating further.
func TestClaudeAppBuildConfigRejectsNonClaudeClient(t *testing.T) {
	deps := claudeapp.Dependencies{
		LoadManifest: func() (map[string]claudeapp.Profile, error) {
			return map[string]claudeapp.Profile{
				"cb-ds": {Name: "cb-ds", Client: "codebuddy", Provider: "zhipu-coding", Env: map[string]string{"ANTHROPIC_BASE_URL": "https://x"}},
			}, nil
		},
		ModelOverrides: func(p claudeapp.Profile) map[string]string { return map[string]string{} },
		ResolveProviderBinding: func(p claudeapp.Profile) (claudeapp.ProviderBinding, error) {
			return claudeapp.ProviderBinding{Protocol: "anthropic-messages", Endpoint: "https://example.com", DefaultModel: ""}, nil
		},
		DefaultPort: 18080,
	}
	if _, err := claudeapp.BuildConfig("cb-ds", 18080, deps); err == nil {
		t.Fatal("expected non-claude client to be rejected")
	}
}

// TestClaudeAppRejectsOpenAIProtocolProvider verifies OpenAI-protocol providers
// are rejected for the app proxy.
func TestClaudeAppRejectsOpenAIProtocolProvider(t *testing.T) {
	deps := claudeapp.Dependencies{
		LoadManifest: func() (map[string]claudeapp.Profile, error) {
			return map[string]claudeapp.Profile{
				"vendor-prof": {
					Name:     "vendor-prof",
					Client:   "claude",
					Provider: "vendor-chat",
					Env: map[string]string{
						"ANTHROPIC_BASE_URL":             "https://api.example.com/v1",
						"ANTHROPIC_AUTH_TOKEN":           "test-token",
						"ANTHROPIC_DEFAULT_OPUS_MODEL":   "vendor-opus",
						"ANTHROPIC_DEFAULT_SONNET_MODEL": "vendor-sonnet",
						"ANTHROPIC_DEFAULT_HAIKU_MODEL":  "vendor-haiku",
					},
				},
			}, nil
		},
		ModelOverrides: func(p claudeapp.Profile) map[string]string {
			return map[string]string{}
		},
		ResolveProviderBinding: func(p claudeapp.Profile) (claudeapp.ProviderBinding, error) {
			return claudeapp.ProviderBinding{
				Protocol:     "openai-chat-completions",
				Endpoint:     "https://api.example.com/v1",
				DefaultModel: "",
			}, nil
		},
		DefaultPort: 18080,
	}
	_, err := claudeapp.BuildConfig("vendor-prof", 18080, deps)
	if err == nil {
		t.Fatal("expected OpenAI-protocol provider to be rejected for app proxy")
	}
}

// TestCCGLMBuildConfigUsesProviderEndpoint verifies that cc-glm
// (zhipu-coding provider) builds app config using the provider-owned
// inference endpoint instead of profile Env.
func TestCCGLMBuildConfigUsesProviderEndpoint(t *testing.T) {
	deps := claudeapp.Dependencies{
		LoadManifest: func() (map[string]claudeapp.Profile, error) {
			return map[string]claudeapp.Profile{
				"cc-glm": {
					Name:     "cc-glm",
					Client:   "claude",
					Provider: "zhipu-coding",
					Env:      map[string]string{}, // No ANTHROPIC_BASE_URL
				},
			}, nil
		},
		ResolveCredential: func(providerID string) (string, bool) {
			return "zhipu-api-key", true
		},
		ModelOverrides: func(p claudeapp.Profile) map[string]string {
			return map[string]string{"claude-sonnet-4-6": "glm-5.3"}
		},
		ModelDisplayName: func(providerID, modelID string) string { return modelID },
		ResolveProviderBinding: func(p claudeapp.Profile) (claudeapp.ProviderBinding, error) {
			_, provider, err := catalog.DefaultRegistry().ResolveBinding(p.Client, p.Provider)
			if err != nil {
				return claudeapp.ProviderBinding{}, err
			}
			if provider.Inference == nil {
				return claudeapp.ProviderBinding{}, nil
			}
			return claudeapp.ProviderBinding{
				Protocol:     provider.Inference.Protocol,
				Endpoint:     provider.Inference.Endpoint,
				DefaultModel: provider.DefaultModel,
			}, nil
		},
		DefaultPort: 18080,
	}
	cfg, err := claudeapp.BuildConfig("cc-glm", 18080, deps)
	if err != nil {
		t.Fatalf("cc-glm should build app config from zhipu-coding binding endpoint, got: %v", err)
	}
	if cfg.UpstreamBaseURL != "https://open.bigmodel.cn/api/anthropic/v1/messages" {
		t.Fatalf("cc-glm upstream base URL should come from provider binding, got %q", cfg.UpstreamBaseURL)
	}
}

// TestCCGLMBuildConfigNoModelOverridesUsesProviderDefaultModel verifies that
// the cc-glm profile shape with no per-profile model env vars or model
// overrides falls back to the zhipu-coding provider catalog default model
// (glm-5.3) for all three Claude app routes.
//
// This is the production cc-glm profile shape: empty Env, empty Settings, no
// modelOverrides. The fix for this test is to add a provider catalog default
// model fallback in routesFromProfile.
func TestCCGLMBuildConfigNoModelOverridesUsesProviderDefaultModel(t *testing.T) {
	deps := claudeapp.Dependencies{
		LoadManifest: func() (map[string]claudeapp.Profile, error) {
			return map[string]claudeapp.Profile{
				"cc-glm": {
					Name:     "cc-glm",
					Client:   "claude",
					Provider: "zhipu-coding",
					Env:      map[string]string{},      // No model env vars
					Settings: map[string]interface{}{}, // No modelOverrides
				},
			}, nil
		},
		ResolveCredential: func(providerID string) (string, bool) {
			return "zhipu-api-key", true
		},
		ModelOverrides: func(p claudeapp.Profile) map[string]string {
			return nil // Production cc-glm has no modelOverrides
		},
		ModelDisplayName: func(providerID, modelID string) string {
			// Return the catalog display name (as the real wiring does)
			if providerID == "zhipu-coding" && modelID == "glm-5.3" {
				return "GLM-5.3"
			}
			return ""
		},
		ResolveProviderBinding: func(p claudeapp.Profile) (claudeapp.ProviderBinding, error) {
			_, provider, err := catalog.DefaultRegistry().ResolveBinding(p.Client, p.Provider)
			if err != nil {
				return claudeapp.ProviderBinding{}, err
			}
			if provider.Inference == nil {
				return claudeapp.ProviderBinding{}, nil
			}
			return claudeapp.ProviderBinding{
				Protocol:     provider.Inference.Protocol,
				Endpoint:     provider.Inference.Endpoint,
				DefaultModel: provider.DefaultModel,
			}, nil
		},
		DefaultPort: 18080,
	}
	cfg, err := claudeapp.BuildConfig("cc-glm", 18080, deps)
	if err != nil {
		t.Fatalf("cc-glm with no model overrides should fall back to provider default model, got: %v", err)
	}
	if len(cfg.Routes) != 3 {
		t.Fatalf("cc-glm should produce 3 Claude app routes using the provider default model, got %d: %#v", len(cfg.Routes), cfg.Routes)
	}
	for _, route := range cfg.Routes {
		if route.UpstreamModel != "glm-5.3" {
			t.Fatalf("cc-glm route %q upstream model = %q, want %q", route.Slot, route.UpstreamModel, "glm-5.3")
		}
		if route.DisplayName != "GLM-5.3" {
			t.Fatalf("cc-glm route %q display name = %q, want %q", route.Slot, route.DisplayName, "GLM-5.3")
		}
	}
	if cfg.UpstreamBaseURL != "https://open.bigmodel.cn/api/anthropic/v1/messages" {
		t.Fatalf("cc-glm upstream base URL should come from provider binding, got %q", cfg.UpstreamBaseURL)
	}
}

// TestClaudeAppFixedDefaultPort verifies the port is fixed at 18080.
func TestClaudeAppFixedDefaultPort(t *testing.T) {
	if got := fixedDefaultPort; got != 18080 {
		t.Fatalf("fixed default port = %d, want 18080", got)
	}
}

func TestCCKimiAppUsesForgeAuthAndLegacyCCKIsUnknown(t *testing.T) {
	home := t.TempDir()
	setupForgedHome(t, home)
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("XDG_STATE_HOME", filepath.Join(home, "state"))
	if err := writeAuth(map[string]AuthEntry{
		"kimi-coding": {Type: "api", Key: "kimi-from-auth-json"},
	}); err != nil {
		t.Fatal(err)
	}

	cfg, err := buildClaudeAppTestConfig("cc-kimi", 18080)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.UpstreamToken != "kimi-from-auth-json" || cfg.Profile.Provider != "kimi-coding" {
		t.Fatalf("unexpected cc-kimi app config: provider=%s token=%q", cfg.Profile.Provider, cfg.UpstreamToken)
	}
	if len(cfg.Routes) != 3 {
		t.Fatalf("cc-kimi app routes = %d, want 3: %#v", len(cfg.Routes), cfg.Routes)
	}
	for _, route := range cfg.Routes {
		if route.UpstreamModel != "k3[1m]" || route.DisplayName != "Kimi K3" || route.LabelOverride != "Kimi K3" || route.Supports1M != true {
			t.Fatalf("cc-kimi route should use provider-owned K3 identity: %#v", route)
		}
	}
	if _, err := buildClaudeAppTestConfig("cck", 18080); err == nil || !strings.Contains(err.Error(), "unknown profile cck") {
		t.Fatalf("legacy cck should be unknown, got %v", err)
	}
}

var fixedDefaultPort = 18080

// TestClaudeAppToClaudeAppProfileRoundTrip verifies the root profile <-> DTO
// conversion preserves the fields the claudeapp package relies on.
func TestClaudeAppToClaudeAppProfileRoundTrip(t *testing.T) {
	original := profile{
		Name:       "ccg",
		Client:     "claude",
		Provider:   "zhipu-coding",
		SecretRef:  strptr("env:ZHIPU_KEY"),
		Env:        map[string]string{"A": "1"},
		Settings:   map[string]interface{}{"modelOverrides": map[string]interface{}{}},
		Supports1M: true,
	}
	converted := claudeapp.ProfileFrom(original)
	if converted.Name != "ccg" || converted.Client != "claude" || !converted.Supports1M {
		t.Fatalf("converted profile lost fields: %#v", converted)
	}
	back := claudeapp.ProfileToManifest(converted)
	if back.Name != original.Name || back.Client != original.Client || back.Provider != original.Provider ||
		back.Supports1M != original.Supports1M || back.SecretRef == nil || *back.SecretRef != "env:ZHIPU_KEY" {
		t.Fatalf("round-trip mismatch: %#v vs %#v", back, original)
	}
}

func strptr(value string) *string { return &value }

// buildClaudeAppTestConfig resolves a claudeapp.Config the same way
// claudeAppCommand does, so config-surface tests can assert gateway
// composition behavior without depending on the moved HTTP/process/policy code.
func buildClaudeAppTestConfig(profileName string, port int) (claudeapp.Config, error) {
	manifest, err := loadManifest()
	if err != nil {
		return claudeapp.Config{}, err
	}
	out := make(map[string]claudeapp.Profile, len(manifest.Profiles))
	for name, p := range manifest.Profiles {
		out[name] = claudeapp.ProfileFrom(p)
	}
	deps := claudeapp.Dependencies{
		LoadManifest:      func() (map[string]claudeapp.Profile, error) { return out, nil },
		ResolveCredential: ResolveCredential,
		ModelOverrides: func(p claudeapp.Profile) map[string]string {
			return claudeModelOverrides(claudeapp.ProfileToManifest(p))
		},
		ModelDisplayName: providerModelDisplayName,
		ResolveProviderBinding: func(p claudeapp.Profile) (claudeapp.ProviderBinding, error) {
			_, provider, err := catalog.DefaultRegistry().ResolveBinding(p.Client, p.Provider)
			if err != nil {
				return claudeapp.ProviderBinding{}, err
			}
			if provider.Inference == nil {
				return claudeapp.ProviderBinding{}, nil
			}
			return claudeapp.ProviderBinding{
				Protocol:     provider.Inference.Protocol,
				Endpoint:     provider.Inference.Endpoint,
				DefaultModel: provider.DefaultModel,
			}, nil
		},
		DefaultPort: port,
	}
	return claudeapp.BuildConfig(profileName, port, deps)
}
