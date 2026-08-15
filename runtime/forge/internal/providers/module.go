// Package providers assembles all built-in provider modules and applies the
// small runtime override surface shared by catalog, auth, quota, and profiles.
package providers

import (
	"fmt"
	"net/url"
	"sort"
	"strings"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/providers/anthropic"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/providers/codebuddy"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/providers/codex"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/providers/codexspark"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/providers/kimi"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/providers/opencode"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/providers/schema"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/providers/xai"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/providers/zhipu"
)

type ProviderModule = schema.ProviderModule

type Override struct {
	OpenAIBaseURL    string
	AnthropicBaseURL string
	APIKey           string
}

var modules = []ProviderModule{
	anthropic.Module(),
	codebuddy.Module(),
	codex.Module(),
	codexspark.Module(),
	kimi.Module(),
	opencode.Module(),
	xai.Module(),
	zhipu.Module(),
}

func Modules() []ProviderModule {
	out := append([]ProviderModule(nil), modules...)
	sort.Slice(out, func(i, j int) bool { return out[i].ID() < out[j].ID() })
	return out
}

func Lookup(id string) (ProviderModule, bool) {
	for _, module := range modules {
		if module.ID() == id {
			return module, true
		}
	}
	return nil, false
}

func RegisterAll(reg schema.Registrar) {
	for _, module := range Modules() {
		reg.RegisterBinding(module.Binding())
		reg.RegisterModels(module.ID(), module.Models())
	}
}

// ApplyOverrides replaces registered bindings after validating config and env
// values against each module's declared protocol and authentication capability.
func ApplyOverrides(reg schema.Registrar, configured map[string]Override, lookupEnv func(string) (string, bool)) error {
	for id := range configured {
		if _, ok := Lookup(id); !ok {
			return fmt.Errorf("providers.%s: unknown provider", id)
		}
	}
	for _, module := range Modules() {
		override := configured[module.ID()]
		if lookupEnv != nil {
			prefix := EnvPrefix(module.ID())
			if value, ok := lookupEnv(prefix + "_OPENAI_BASE_URL"); ok && strings.TrimSpace(value) != "" {
				override.OpenAIBaseURL = strings.TrimSpace(value)
			}
			if value, ok := lookupEnv(prefix + "_ANTHROPIC_BASE_URL"); ok && strings.TrimSpace(value) != "" {
				override.AnthropicBaseURL = strings.TrimSpace(value)
			}
			if value, ok := lookupEnv(prefix + "_API_KEY"); ok && strings.TrimSpace(value) != "" {
				override.APIKey = strings.TrimSpace(value)
			}
		}
		binding, err := bindingWithOverride(module, override)
		if err != nil {
			return err
		}
		reg.RegisterBinding(binding)
	}
	return nil
}

func EffectiveAPIKey(providerID string, configured map[string]Override, lookupEnv func(string) (string, bool)) (string, bool, error) {
	module, ok := Lookup(providerID)
	if !ok {
		return "", false, fmt.Errorf("unknown provider %q", providerID)
	}
	value := strings.TrimSpace(configured[providerID].APIKey)
	if lookupEnv != nil {
		if envValue, exists := lookupEnv(EnvPrefix(providerID) + "_API_KEY"); exists && strings.TrimSpace(envValue) != "" {
			value = strings.TrimSpace(envValue)
		}
	}
	if value == "" {
		return "", false, nil
	}
	if !isForgeManaged(module.Binding()) {
		return "", false, fmt.Errorf("provider %q does not accept API-key overrides", providerID)
	}
	return value, true, nil
}

func IsManaged(providerID string) bool {
	module, ok := Lookup(providerID)
	return ok && isForgeManaged(module.Binding())
}

func EnvPrefix(providerID string) string {
	replacer := strings.NewReplacer("-", "_", ".", "_", "/", "_")
	return "FORGE_" + strings.ToUpper(replacer.Replace(providerID))
}

func bindingWithOverride(module ProviderModule, override Override) (schema.Provider, error) {
	binding := cloneBinding(module.Binding())
	if strings.TrimSpace(override.APIKey) != "" && !isForgeManaged(binding) {
		return schema.Provider{}, fmt.Errorf("providers.%s.api_key: provider does not accept API-key overrides", module.ID())
	}
	endpoints := []struct {
		protocol schema.RawLLMProtocol
		value    string
	}{
		{protocol: schema.RawLLMProtocolOpenAI, value: override.OpenAIBaseURL},
		{protocol: schema.RawLLMProtocolAnthropic, value: override.AnthropicBaseURL},
	}
	for _, candidate := range endpoints {
		protocol := candidate.protocol
		endpoint := strings.TrimSpace(candidate.value)
		if endpoint == "" {
			continue
		}
		if err := validateBaseURL(endpoint); err != nil {
			return schema.Provider{}, fmt.Errorf("providers.%s.%s_base_url: %w", module.ID(), protocol, err)
		}
		found := false
		for i := range binding.RawLLM {
			if binding.RawLLM[i].Protocol == protocol {
				binding.RawLLM[i].BaseEndpoint = endpoint
				found = true
			}
		}
		if !found {
			return schema.Provider{}, fmt.Errorf("providers.%s.%s_base_url: protocol is not declared by provider", module.ID(), protocol)
		}
		if binding.Inference != nil && inferenceProtocol(binding.Inference.Protocol) == protocol {
			binding.Inference.Endpoint = endpoint
		}
	}
	return binding, nil
}

func cloneBinding(binding schema.Provider) schema.Provider {
	binding.Env = cloneStringMap(binding.Env)
	binding.CompatibleDialects = append([]schema.Dialect(nil), binding.CompatibleDialects...)
	binding.AllowedModels = append([]string(nil), binding.AllowedModels...)
	binding.RawLLM = append([]schema.RawLLMCapability(nil), binding.RawLLM...)
	if binding.Inference != nil {
		inference := *binding.Inference
		binding.Inference = &inference
	}
	return binding
}

func cloneStringMap(input map[string]string) map[string]string {
	if input == nil {
		return nil
	}
	out := make(map[string]string, len(input))
	for key, value := range input {
		out[key] = value
	}
	return out
}

func inferenceProtocol(protocol string) schema.RawLLMProtocol {
	if strings.HasPrefix(protocol, "openai-") {
		return schema.RawLLMProtocolOpenAI
	}
	if strings.HasPrefix(protocol, "anthropic-") {
		return schema.RawLLMProtocolAnthropic
	}
	return ""
}

func isForgeManaged(binding schema.Provider) bool {
	// Forge-managed credential handling still requires an inference transport;
	// the credential resolver itself is read from the top-level source.
	return binding.Inference != nil && binding.CredentialSource() == schema.CredentialResolverForgeManaged
}

func validateBaseURL(raw string) error {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return fmt.Errorf("must be an absolute URL")
	}
	if parsed.Scheme != "https" && parsed.Scheme != "http" {
		return fmt.Errorf("unsupported URL scheme %q", parsed.Scheme)
	}
	if parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return fmt.Errorf("must not contain credentials, query, or fragment")
	}
	return nil
}
