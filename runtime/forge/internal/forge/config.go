package forge

import (
	"fmt"
	"os"
	"sort"
	"strings"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/profiles/config"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/profiles/manifest"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/providers"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/catalog"
)

func loadManifest() (profileManifest, error) {
	cfg, _, err := LoadForgeConfig()
	if err != nil {
		return profileManifest{}, err
	}
	reg, err := catalogRegistryForConfig(cfg)
	if err != nil {
		return profileManifest{}, err
	}
	return manifest.LoadManifest(manifest.LoadDeps{Recipes: cfg.Profiles, Registry: reg})
}

func manifestSources() map[string]string {
	cfg, _, err := LoadForgeConfig()
	if err != nil {
		return manifest.ManifestSources(manifest.LoadDeps{})
	}
	return manifest.ManifestSources(manifest.LoadDeps{Recipes: cfg.Profiles})
}

func LoadForgeConfig() (ForgeConfig, []string, error) {
	cfg, warnings, err := config.LoadForgeConfig(userConfigPath(), config.EmbeddedData(), os.Stderr)
	if err != nil {
		return ForgeConfig{}, nil, err
	}
	return cfg, warnings, nil
}

func providerSources() map[string]string {
	sources := map[string]string{}
	for _, module := range providers.Modules() {
		sources[module.ID()] = "go"
	}
	cfg, _, err := LoadForgeConfig()
	if err == nil {
		for id := range cfg.Providers {
			sources[id] = "config"
		}
	}
	for _, module := range providers.Modules() {
		prefix := providers.EnvPrefix(module.ID())
		for _, suffix := range []string{"_OPENAI_BASE_URL", "_ANTHROPIC_BASE_URL", "_API_KEY"} {
			if value, ok := os.LookupEnv(prefix + suffix); ok && value != "" {
				sources[module.ID()] = "env"
				break
			}
		}
	}
	return sources
}

func catalogRegistryForConfig(cfg ForgeConfig) (*catalog.Registry, error) {
	reg := catalog.DefaultRegistry()
	overrides := make(map[string]providers.Override, len(cfg.Providers))
	for id, override := range cfg.Providers {
		overrides[id] = providers.Override{
			OpenAIBaseURL: override.OpenAIBaseURL, AnthropicBaseURL: override.AnthropicBaseURL,
			APIKey: override.APIKey,
		}
	}
	if err := providers.ApplyOverrides(reg, overrides, os.LookupEnv); err != nil {
		return nil, err
	}
	if err := registerCustomProviders(reg, cfg.CustomProviders); err != nil {
		return nil, err
	}
	return reg, nil
}

// registerCustomProviders registers user-defined custom provider bindings in
// deterministic id order. Custom providers are data-only: they inherit the
// client's default native credential source, run through the client binary,
// and declare no inference transport, raw LLM capability, or quota surface.
func registerCustomProviders(reg *catalog.Registry, custom map[string]config.CustomProvider) error {
	ids := make([]string, 0, len(custom))
	for id := range custom {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	seen := make(map[string]bool, len(ids))
	for _, rawID := range ids {
		id := strings.TrimSpace(rawID)
		if id == "" {
			return fmt.Errorf("custom_providers: provider id must not be empty")
		}
		if seen[id] {
			return fmt.Errorf("custom_providers.%s: duplicate provider id", id)
		}
		seen[id] = true
		if _, ok := providers.Lookup(id); ok {
			return fmt.Errorf("custom_providers.%s: id collides with a builtin provider", id)
		}
		entry := custom[rawID]
		client := strings.TrimSpace(entry.Client)
		if client == "" {
			return fmt.Errorf("custom_providers.%s.client: must not be empty", id)
		}
		desc, err := reg.LookupDescriptor(client)
		if err != nil {
			return fmt.Errorf("custom_providers.%s.client: %v", id, err)
		}
		if desc.DefaultProvider == "" {
			return fmt.Errorf("custom_providers.%s.client: client %q has no default native credential source", id, client)
		}
		if len(entry.Models) == 0 {
			return fmt.Errorf("custom_providers.%s.models: must declare at least one model", id)
		}
		models := make(catalog.ProviderModels, len(entry.Models))
		modelSeen := make(map[string]bool, len(entry.Models))
		for _, rawModel := range entry.Models {
			model := strings.TrimSpace(rawModel)
			if model == "" {
				return fmt.Errorf("custom_providers.%s.models: model id must not be empty", id)
			}
			if modelSeen[model] {
				return fmt.Errorf("custom_providers.%s.models: duplicate model id %q", id, model)
			}
			modelSeen[model] = true
			models[model] = catalog.ModelDef{ID: model}
		}
		defaultBinding, err := reg.LookupBinding(desc.DefaultProvider)
		if err != nil {
			return fmt.Errorf("custom_providers.%s: %v", id, err)
		}
		source := defaultBinding.CredentialSource()
		if source == "" {
			return fmt.Errorf("custom_providers.%s: client %q has no native credential source", id, client)
		}
		reg.RegisterBinding(catalog.Provider{
			Name: id, Kind: "custom",
			CompatibleDialects: []catalog.Dialect{desc.Dialect},
			CredentialResolver: source,
			UseClientBinary:    true,
		})
		reg.RegisterModels(id, models)
	}
	return nil
}

func loadCatalogRegistry() (*catalog.Registry, error) {
	cfg, _, err := LoadForgeConfig()
	if err != nil {
		return nil, err
	}
	return catalogRegistryForConfig(cfg)
}

func catalogRegistryOrDefault() *catalog.Registry {
	reg, err := loadCatalogRegistry()
	if err != nil {
		return catalog.DefaultRegistry()
	}
	return reg
}

func configuredProviderOverrides() (map[string]providers.Override, error) {
	cfg, _, err := LoadForgeConfig()
	if err != nil {
		return nil, err
	}
	overrides := make(map[string]providers.Override, len(cfg.Providers))
	for id, override := range cfg.Providers {
		overrides[id] = providers.Override{APIKey: override.APIKey}
	}
	return overrides, nil
}
