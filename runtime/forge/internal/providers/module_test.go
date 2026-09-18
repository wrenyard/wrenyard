package providers_test

import (
	"reflect"
	"strings"
	"testing"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/providers"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/catalog"
)

func TestAllProviderModulesRegisterBindingAndModels(t *testing.T) {
	want := []string{"anthropic", "chatgpt", "claude-coding", "codebuddy", "cursor", "deepseek", "kimi-coding", "minimax", "minimax-coding", "moonshot", "openai", "opencode-go", "opencode-zen", "openrouter", "qwen", "qwen-coding", "spacex-ai", "tokenhub", "volcengine", "zhipu", "zhipu-coding"}
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

func TestChatGPTSingleProvider(t *testing.T) {
	module, ok := providers.Lookup("chatgpt")
	if !ok {
		t.Fatal("chatgpt builtin module must be registered")
	}
	binding := module.Binding()
	if binding.Name != "chatgpt" || binding.Kind != "builtin" {
		t.Fatalf("chatgpt binding = %+v", binding)
	}
	if binding.QuotaProvider != "chatgpt" {
		t.Fatalf("chatgpt quota provider = %q, want chatgpt", binding.QuotaProvider)
	}
	if !binding.SupportsDialect(catalog.DialectCodex) {
		t.Fatal("chatgpt provider must support the codex dialect")
	}
	if binding.Inference == nil || binding.Inference.CredentialResolver != catalog.CredentialResolverCodex {
		t.Fatalf("chatgpt must keep the codex credential resolver, got %#v", binding.Inference)
	}
	if quota := module.Quota(); quota.Kind != "chatgpt" || quota.Name != "chatgpt" {
		t.Fatalf("chatgpt quota metadata = %#v, want kind/name chatgpt", quota)
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

}

func TestPublicAPIProviderContracts(t *testing.T) {
	tests := []struct {
		id         string
		protocol   string
		endpoint   string
		authScheme catalog.AuthScheme
	}{
		{"anthropic", "anthropic-messages", "https://api.anthropic.com/v1/messages", catalog.AuthSchemeAPIKey},
		{"deepseek", "openai-chat-completions", "https://api.deepseek.com/chat/completions", catalog.AuthSchemeBearer},
		{"minimax", "openai-chat-completions", "https://api.minimaxi.com/v1/chat/completions", catalog.AuthSchemeBearer},
		{"minimax-coding", "openai-chat-completions", "https://api.minimaxi.com/v1/chat/completions", catalog.AuthSchemeBearer},
		{"moonshot", "openai-chat-completions", "https://api.moonshot.cn/v1/chat/completions", catalog.AuthSchemeBearer},
		{"openai", "openai-chat-completions", "https://api.openai.com/v1/chat/completions", catalog.AuthSchemeBearer},
		{"qwen", "openai-chat-completions", "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions", catalog.AuthSchemeBearer},
		{"qwen-coding", "openai-chat-completions", "https://coding.dashscope.aliyuncs.com/v1/chat/completions", catalog.AuthSchemeBearer},
		{"tokenhub", "openai-chat-completions", "https://tokenhub.tencentmaas.com/v1/chat/completions", catalog.AuthSchemeBearer},
		{"volcengine", "openai-chat-completions", "https://ark.cn-beijing.volces.com/api/v3/chat/completions", catalog.AuthSchemeBearer},
		{"zhipu", "openai-chat-completions", "https://open.bigmodel.cn/api/paas/v4/chat/completions", catalog.AuthSchemeBearer},
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
		})
	}
}

func TestPlanAndOpenPlatformCredentialsRemainSeparate(t *testing.T) {
	for _, pair := range [][2]string{{"minimax", "minimax-coding"}, {"qwen", "qwen-coding"}, {"moonshot", "kimi-coding"}, {"zhipu", "zhipu-coding"}, {"openai", "chatgpt"}, {"anthropic", "claude-coding"}} {
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

func TestClaudeSubscriptionAndAPIIdentitiesStayDistinct(t *testing.T) {
	subscription, ok := providers.Lookup("claude-coding")
	if !ok {
		t.Fatal("claude-coding subscription module must be registered")
	}
	if got := subscription.Binding().CredentialSource(); got != catalog.CredentialResolverClaude {
		t.Fatalf("claude-coding credential source = %q, want claude", got)
	}
	api, ok := providers.Lookup("anthropic")
	if !ok {
		t.Fatal("anthropic API module must be registered")
	}
	if got := api.Binding().CredentialSource(); got != catalog.CredentialResolverForgeManaged {
		t.Fatalf("anthropic credential source = %q, want forge-managed", got)
	}
	if subscription.ID() == api.ID() {
		t.Fatal("subscription and API provider identities must stay distinct")
	}
}

func TestLegacyProviderIDAliasesAreExactAndOnceOnly(t *testing.T) {
	if got := providers.CanonicalID("anthropic-api"); got != "anthropic" {
		t.Fatalf("CanonicalID(anthropic-api) = %q, want anthropic", got)
	}
	if got := providers.CanonicalID("opencode-native"); got != "opencode-zen" {
		t.Fatalf("CanonicalID(opencode-native) = %q, want opencode-zen", got)
	}
	// The subscription identity is never aliased from the legacy API id.
	if providers.CanonicalID("anthropic-api") == "claude-coding" {
		t.Fatal("anthropic-api must not alias to claude-coding")
	}
	if got := providers.CanonicalID("claude-coding"); got != "claude-coding" {
		t.Fatalf("CanonicalID(claude-coding) = %q, want unchanged", got)
	}
}

func TestCodeBuddyProviderModule(t *testing.T) {
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
	if binding.QuotaProvider != "" {
		t.Fatalf("codebuddy must not declare a quota provider, got %q", binding.QuotaProvider)
	}
	if !binding.UseClientBinary {
		t.Fatal("codebuddy must use the client binary")
	}
	if source := binding.CredentialSource(); source != catalog.CredentialResolverCodeBuddy {
		t.Fatalf("codebuddy credential source = %q, want codebuddy", source)
	}
	wantModels := []string{
		"deepseek-v4.1-flash", "hy4-preview", "hy3", "minimax-m3",
		"kimi-k3", "glm-5.3", "glm-5.3-flash",
	}
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
	for _, near := range []string{"hy3-ioa", "hy3-preview"} {
		if _, ok := models[near]; ok {
			t.Fatalf("codebuddy exposes internal near-id %q as a public model", near)
		}
		if err := binding.ValidateModel(near); err == nil {
			t.Fatalf("codebuddy must reject internal near-id %q as a public model", near)
		}
	}
	if _, ok := providers.Lookup("deepseek"); !ok {
		t.Fatal("deepseek official provider must be registered")
	}
}

func TestKimiCodingProviderModule(t *testing.T) {
	module, ok := providers.Lookup("kimi-coding")
	if !ok {
		t.Fatal("kimi-coding builtin module must be registered")
	}
	binding := module.Binding()
	if binding.Name != "kimi-coding" || binding.Kind != "builtin" {
		t.Fatalf("kimi-coding binding = %+v", binding)
	}
	if binding.DefaultModel != "k3" {
		t.Fatalf("kimi-coding default model = %q, want k3", binding.DefaultModel)
	}
	if binding.QuotaProvider != "kimi-coding" {
		t.Fatalf("kimi-coding quota provider = %q, want kimi-coding", binding.QuotaProvider)
	}

	// Register each model once; the wire alias stays an allowed input.
	wantModels := []string{"k3", "kimi-k2.8"}
	models := module.Models()
	if len(models) != len(wantModels) {
		t.Fatalf("kimi-coding model count = %d, want %d", len(models), len(wantModels))
	}
	for _, id := range wantModels {
		model, ok := models[id]
		if !ok {
			t.Fatalf("kimi-coding models missing %q", id)
		}
		if model.ID != id {
			t.Fatalf("kimi-coding model %q has ID %q", id, model.ID)
		}
		if model.ContextWindow != 1048576 {
			t.Fatalf("kimi-coding model %q context = %d, want 1048576", id, model.ContextWindow)
		}
	}
	if got := models["k3"].DisplayName; got != "Kimi K3" {
		t.Fatalf("kimi-coding k3 display name = %q, want Kimi K3", got)
	}
	for _, id := range []string{"kimi-k2.8"} {
		if got := models[id].DisplayName; got != "Kimi K2.8 Preview" {
			t.Fatalf("kimi-coding %s display name = %q, want Kimi K2.8 Preview", id, got)
		}
	}

	// Both the canonical id and the official wire id must validate, while K3
	// stays allowed and the compatibility alias k3[1m] is preserved.
	for _, id := range []string{"k3", "k3[1m]", "kimi-k2.8", "kimi-for-coding"} {
		if err := binding.ValidateModel(id); err != nil {
			t.Fatalf("kimi-coding must allow %q: %v", id, err)
		}
	}
	for _, near := range []string{"kimi-for-coding-ioa", "kimi-k2.8-preview", "kimi-k3-ioa"} {
		if err := binding.ValidateModel(near); err == nil {
			t.Fatalf("kimi-coding must reject unknown model %q", near)
		}
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
	wantModels := []string{"composer-2.5", "grok-4.6", "kimi-k3", "claude-opus-5", "gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol", "claude-sonnet-5", "muse-spark-1.3", "gemini-3.8-flash", "claude-fable-5", "claude-fable-5-1"}
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
