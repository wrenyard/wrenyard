package providers_test

import (
	"reflect"
	"testing"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/providers"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/catalog"
)

func TestAllProviderModulesRegisterBindingAndModels(t *testing.T) {
	want := []string{"anthropic", "codebuddy", "codex", "codex-spark", "kimi-coding", "opencode-native", "xai", "zhipu-coding"}
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
		"xai": {APIKey: "must-not-be-used"},
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
	wantModels := []string{"deepseek-v4-flash", "deepseek-v4-pro", "hunyuan-chat", "kimi-k2.6"}
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
