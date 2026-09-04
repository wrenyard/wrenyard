// Package providers assembles all built-in provider modules and applies the
// small runtime override surface shared by catalog, auth, quota, and profiles.
package providers

import (
	"fmt"
	"sort"
	"strings"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/providers/anthropic"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/providers/anthropicapi"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/providers/codebuddy"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/providers/codex"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/providers/codexspark"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/providers/cursor"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/providers/kimi"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/providers/minimaxapi"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/providers/minimaxcoding"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/providers/moonshot"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/providers/openaiapi"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/providers/opencode"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/providers/qwenapi"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/providers/qwencoding"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/providers/schema"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/providers/tokenhub"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/providers/volcengine"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/providers/xai"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/providers/zhipu"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/providers/zhipuapi"
)

type ProviderModule = schema.ProviderModule

type Override struct {
	APIKey string
}

var modules = []ProviderModule{
	anthropic.Module(),
	anthropicapi.Module(),
	codebuddy.Module(),
	codex.Module(),
	codexspark.Module(),
	cursor.Module(),
	kimi.Module(),
	minimaxapi.Module(),
	minimaxcoding.Module(),
	moonshot.Module(),
	opencode.Module(),
	openaiapi.Module(),
	qwenapi.Module(),
	qwencoding.Module(),
	tokenhub.Module(),
	volcengine.Module(),
	xai.Module(),
	zhipu.Module(),
	zhipuapi.Module(),
}

const SpaceXAIProviderID = "spacex-ai"

// CanonicalID maps provider ids accepted from historical user configuration
// to the current product id. New catalog and product output must only emit the
// canonical id.
func CanonicalID(id string) string {
	if id == "xai" {
		return SpaceXAIProviderID
	}
	return id
}

func Modules() []ProviderModule {
	out := append([]ProviderModule(nil), modules...)
	sort.Slice(out, func(i, j int) bool { return out[i].ID() < out[j].ID() })
	return out
}

func Lookup(id string) (ProviderModule, bool) {
	id = CanonicalID(id)
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
		if legacy, ok := configured["xai"]; module.ID() == SpaceXAIProviderID && ok {
			if _, canonicalSet := configured[SpaceXAIProviderID]; !canonicalSet {
				override = legacy
			}
		}
		if lookupEnv != nil {
			prefix := EnvPrefix(module.ID())
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
	providerID = CanonicalID(providerID)
	module, ok := Lookup(providerID)
	if !ok {
		return "", false, fmt.Errorf("unknown provider %q", providerID)
	}
	override := configured[providerID]
	if providerID == SpaceXAIProviderID {
		if legacy, ok := configured["xai"]; ok {
			if _, canonicalSet := configured[SpaceXAIProviderID]; !canonicalSet {
				override = legacy
			}
		}
	}
	value := strings.TrimSpace(override.APIKey)
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
	return binding, nil
}

func cloneBinding(binding schema.Provider) schema.Provider {
	binding.Env = cloneStringMap(binding.Env)
	binding.CompatibleDialects = append([]schema.Dialect(nil), binding.CompatibleDialects...)
	binding.AllowedModels = append([]string(nil), binding.AllowedModels...)
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

func isForgeManaged(binding schema.Provider) bool {
	// Forge-managed credential handling still requires an inference transport;
	// the credential resolver itself is read from the top-level source.
	return binding.Inference != nil && binding.CredentialSource() == schema.CredentialResolverForgeManaged
}
