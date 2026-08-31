package providers_test

import (
	"reflect"
	"strings"
	"testing"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/providers"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/catalog"
)

func TestAllProviderModulesRegisterBindingAndModels(t *testing.T) {
	want := []string{"anthropic", "anthropic-api", "codebuddy", "codex", "codex-spark", "cursor", "kimi-coding", "minimax", "minimax-coding", "moonshot", "openai", "opencode-native", "qwen", "qwen-coding", "spacex-ai", "tokenhub", "volcengine", "zhipu", "zhipu-coding"}
	modules := providers.Modules()
	got := make([]string, len(modules))
	reg := catalog.DefaultRegistry()
	for i, module := range modules {
		got[i] = module.ID()
		binding, err := reg.LookupBinding(module.ID())
		if err != nil {
			t.Fatalf("module %s binding: %v", module.ID(), err)
		}
		if binding.Name != module.ID() {
			t.Fatalf("module %s registered binding %s", module.ID(), binding.Name)
		}
		if len(reg.ProviderModels(module.ID())) != len(module.Models()) {
			t.Fatalf("module %s model registration mismatch", module.ID())
		}
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("module ids = %v, want %v", got, want)
	}
}

func TestProviderOverridesRespectDeclaredCapabilities(t *testing.T) {
	reg := catalog.DefaultRegistry()
	err := providers.ApplyOverrides(reg, map[string]providers.Override{
		"spacex-ai": {APIKey: "must-not-be-used"},
	}, nil)
	if err == nil {
		t.Fatal("OAuth provider accepted an API-key override")
	}

	reg = catalog.DefaultRegistry()
	err = providers.ApplyOverrides(reg, map[string]providers.Override{
		"opencode-native": {AnthropicBaseURL: "https://example.invalid/v1"},
	}, nil)
	if err == nil {
		t.Fatal("provider override enabled an undeclared protocol")
	}
}

func TestPublicAPIProviderContracts(t *testing.T) {
	tests := []struct {
		id              string
		protocol        string
		endpoint        string
		authScheme      catalog.AuthScheme
		rawAnthropic    bool
		anthropicScheme catalog.AuthScheme
	}{
		{"anthropic-api", "anthropic-messages", "https://api.anthropic.com/v1/messages", catalog.AuthSchemeAPIKey, true, catalog.AuthSchemeAPIKey},
		{"minimax", "openai-chat-completions", "https://api.minimaxi.com/v1/chat/completions", catalog.AuthSchemeBearer, true, catalog.AuthSchemeBearer},
		{"minimax-coding", "openai-chat-completions", "https://api.minimaxi.com/v1/chat/completions", catalog.AuthSchemeBearer, true, catalog.AuthSchemeBearer},
		{"moonshot", "openai-chat-completions", "https://api.moonshot.cn/v1/chat/completions", catalog.AuthSchemeBearer, false, ""},
		{"openai", "openai-chat-completions", "https://api.openai.com/v1/chat/completions", catalog.AuthSchemeBearer, false, ""},
		{"qwen", "openai-chat-completions", "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions", catalog.AuthSchemeBearer, true, catalog.AuthSchemeBearer},
		{"qwen-coding", "openai-chat-completions", "https://coding.dashscope.aliyuncs.com/v1/chat/completions", catalog.AuthSchemeBearer, true, catalog.AuthSchemeBearer},
		{"tokenhub", "openai-chat-completions", "https://tokenhub.tencentmaas.com/v1/chat/completions", catalog.AuthSchemeBearer, true, catalog.AuthSchemeAPIKey},
		{"volcengine", "openai-chat-completions", "https://ark.cn-beijing.volces.com/api/v3/chat/completions", catalog.AuthSchemeBearer, false, ""},
		{"zhipu", "openai-chat-completions", "https://open.bigmodel.cn/api/paas/v4/chat/completions", catalog.AuthSchemeBearer, false, ""},
	}
	for _, tc := range tests {
		t.Run(tc.id, func(t *testing.T) {
			module, ok := providers.Lookup(tc.id)
			if !ok {
				t.Fatalf("provider %s is not registered", tc.id)
			}
			binding := module.Binding()
			if binding.Inference == nil {
				t.Fatal("public API provider must expose direct inference")
			}
			if binding.Inference.Protocol != tc.protocol || binding.Inference.Endpoint != tc.endpoint {
				t.Fatalf("inference = %#v, want protocol %q endpoint %q", binding.Inference, tc.protocol, tc.endpoint)
			}
			if binding.Inference.AuthScheme != tc.authScheme {
				t.Fatalf("auth scheme = %q, want %q", binding.Inference.AuthScheme, tc.authScheme)
			}
			if binding.CredentialSource() != catalog.CredentialResolverForgeManaged || !module.Auth().Login {
				t.Fatal("public API provider must use Forge-managed API-key auth")
			}
			anthropic, ok := binding.RawCapability(catalog.RawLLMProtocolAnthropic)
			if ok != tc.rawAnthropic {
				t.Fatalf("raw Anthropic capability = %t, want %t", ok, tc.rawAnthropic)
			}
			if ok && anthropic.AuthScheme != tc.anthropicScheme {
				t.Fatalf("raw Anthropic auth scheme = %q, want %q", anthropic.AuthScheme, tc.anthropicScheme)
			}
		})
	}
}

func TestPlanAndOpenPlatformCredentialsRemainSeparate(t *testing.T) {
	for _, pair := range [][2]string{{"minimax", "minimax-coding"}, {"qwen", "qwen-coding"}, {"moonshot", "kimi-coding"}, {"zhipu", "zhipu-coding"}, {"openai", "codex"}, {"anthropic-api", "anthropic"}} {
		left, leftOK := providers.Lookup(pair[0])
		right, rightOK := providers.Lookup(pair[1])
		if !leftOK || !rightOK || left.ID() == right.ID() {
			t.Fatalf("provider identities must stay separate: %v", pair)
		}
	}
}

func TestLegacyXAIProviderIDResolvesToSpaceXAICanonicalModule(t *testing.T) {
	module, ok := providers.Lookup("xai")
	if !ok || module.ID() != providers.SpaceXAIProviderID {
		t.Fatalf("legacy xai lookup = (%v, %t), want canonical %q", module, ok, providers.SpaceXAIProviderID)
	}
	reg := catalog.DefaultRegistry()
	binding, err := reg.LookupBinding("xai")
	if err != nil {
		t.Fatal(err)
	}
	if binding.Name != providers.SpaceXAIProviderID {
		t.Fatalf("legacy xai binding name = %q, want %q", binding.Name, providers.SpaceXAIProviderID)
	}
	for _, id := range reg.BindingNames() {
		if id == "xai" {
			t.Fatal("legacy xai id must not be emitted by the canonical catalog")
		}
	}
}

func TestLegacyXAIOverrideStillUsesCanonicalProviderPolicy(t *testing.T) {
	err := providers.ApplyOverrides(catalog.DefaultRegistry(), map[string]providers.Override{
		"xai": {APIKey: "must-not-be-used"},
	}, nil)
	if err == nil || !strings.Contains(err.Error(), "spacex-ai") {
		t.Fatalf("legacy xai override error = %v, want canonical native-provider rejection", err)
	}
}

func TestCodeBuddyProviderModule(t *testing.T) {
	reg := catalog.DefaultRegistry()
	module, ok := providers.Lookup("codebuddy")
	if !ok {
		t.Fatal("codebuddy builtin module must be registered")
	}
	binding := module.Binding()
	if binding.Name != "codebuddy" {
		t.Fatalf("binding name = %q, want codebuddy", binding.Name)
	}
	if binding.Inference != nil {
		t.Fatal("codebuddy must not declare an inference transport")
	}
	if len(binding.RawLLM) != 0 {
		t.Fatalf("codebuddy must not declare raw LLM capability, got %#v", binding.RawLLM)
	}
	if binding.QuotaProvider != "" {
		t.Fatalf("codebuddy must not declare a quota provider, got %q", binding.QuotaProvider)
	}
	if !binding.UseClientBinary {
		t.Fatal("codebuddy must use the client binary")
	}
	if source := binding.CredentialSource(); source != catalog.CredentialResolverCodeBuddy {
		t.Fatalf("codebuddy credential source = %q, want codebuddy", source)
	}
	wantModels := []string{"deepseek-v4-flash", "deepseek-v4-pro", "hy4-preview-ioa", "kimi-k2.6"}
	models := module.Models()
	if len(models) != len(wantModels) {
		t.Fatalf("codebuddy model count = %d, want %d", len(models), len(wantModels))
	}
	for _, id := range wantModels {
		if _, ok := models[id]; !ok {
			t.Fatalf("codebuddy models missing public model %q", id)
		}
		if err := binding.ValidateModel(id); err != nil {
			t.Fatalf("codebuddy must allow public model %q: %v", id, err)
		}
	}
	for id := range models {
		found := false
		for _, want := range wantModels {
			if id == want {
				found = true
				break
			}
		}
		if !found {
			t.Fatalf("codebuddy exposes unexpected internal model id %q", id)
		}
	}
	if _, err := reg.LookupBinding("deepseek"); err == nil {
		t.Fatal("deepseek must not be a registered Forge binding")
	}
}

func TestCursorProviderModuleRuntimeAndQuota(t *testing.T) {
	reg := catalog.DefaultRegistry()
	module, ok := providers.Lookup("cursor")
	if !ok {
		t.Fatal("cursor builtin module must be registered")
	}
	binding := module.Binding()
	if binding.Name != "cursor" {
		t.Fatalf("binding name = %q, want cursor", binding.Name)
	}
	if binding.Inference != nil {
		t.Fatal("cursor must not declare an inference transport")
	}
	if len(binding.RawLLM) != 0 {
		t.Fatalf("cursor must not declare raw LLM capability, got %#v", binding.RawLLM)
	}
	if !binding.UseClientBinary {
		t.Fatal("cursor must use the client binary")
	}
	if source := binding.CredentialSource(); source != catalog.CredentialResolverCursor {
		t.Fatalf("cursor credential source = %q, want cursor", source)
	}
	if !binding.SupportsDialect(catalog.DialectCursor) {
		t.Fatal("cursor provider must support the cursor dialect")
	}
	if binding.QuotaProvider != "cursor" {
		t.Fatalf("cursor quota provider = %q, want cursor", binding.QuotaProvider)
	}
	wantModels := []string{"composer-2.5", "cursor-grok-4.6-high", "kimi-k3", "claude-opus-5"}
	models := module.Models()
	if len(models) != len(wantModels) {
		t.Fatalf("cursor model count = %d, want %d", len(models), len(wantModels))
	}
	for _, id := range wantModels {
		if _, ok := models[id]; !ok {
			t.Fatalf("cursor models missing public model %q", id)
		}
		if err := binding.ValidateModel(id); err != nil {
			t.Fatalf("cursor must allow public model %q: %v", id, err)
		}
	}
	for id := range models {
		found := false
		for _, want := range wantModels {
			if id == want {
				found = true
				break
			}
		}
		if !found {
			t.Fatalf("cursor exposes unexpected internal model id %q", id)
		}
	}
	quotaInfo := module.Quota()
	if quotaInfo.Kind != "cursor" || quotaInfo.Name != "cursor" {
		t.Fatalf("cursor quota metadata = %#v, want kind/name cursor", quotaInfo)
	}
	if module.Auth().Login {
		t.Fatal("cursor must not expose an auth-login surface")
	}
	if _, err := reg.LookupBinding("cursor"); err != nil {
		t.Fatalf("cursor binding must be registered: %v", err)
	}
}
