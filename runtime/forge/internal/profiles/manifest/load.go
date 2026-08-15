package manifest

import (
	"fmt"
	"sort"
	"strings"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/grok"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/profiles/config"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/catalog"
)

// LoadDeps provides the dependencies needed to load a manifest.
type LoadDeps struct {
	Recipes  map[string]config.ProfileRecipe
	Registry *catalog.Registry
}

// LoadManifest returns the source-owned built-in profiles manifest.
// User profile directories and embedded profile JSON are completely ignored
// in production. Overrides come from thin config only.
func LoadManifest(deps LoadDeps) (Manifest, error) {
	manifest := BuiltinManifest()
	if len(deps.Recipes) == 0 {
		return *manifest, nil
	}
	if deps.Registry == nil {
		return Manifest{}, fmt.Errorf("custom profiles require a provider catalog")
	}
	names := make([]string, 0, len(deps.Recipes))
	for name := range deps.Recipes {
		names = append(names, name)
	}
	sort.Strings(names)
	known := make(map[string]bool, len(manifest.OrderedIDs))
	for _, name := range manifest.OrderedIDs {
		known[name] = true
	}
	for _, name := range names {
		profile, err := synthesizeProfile(name, deps.Recipes[name], deps.Registry)
		if err != nil {
			return Manifest{}, err
		}
		manifest.Profiles[name] = profile
		if !known[name] {
			manifest.OrderedIDs = append(manifest.OrderedIDs, name)
			known[name] = true
		}
	}
	return *manifest, nil
}

// ManifestSources returns "go" for all known built-in profile names.
func ManifestSources(deps LoadDeps) map[string]string {
	sources := map[string]string{}
	for _, id := range List() {
		sources[id] = "go"
	}
	for id := range deps.Recipes {
		sources[id] = "config"
	}
	return sources
}

func synthesizeProfile(name string, recipe config.ProfileRecipe, reg *catalog.Registry) (Profile, error) {
	name = strings.TrimSpace(name)
	recipe.Client = strings.TrimSpace(recipe.Client)
	recipe.Provider = strings.TrimSpace(recipe.Provider)
	recipe.Model = strings.TrimSpace(recipe.Model)
	if name == "" {
		return Profile{}, fmt.Errorf("profiles: profile name must not be empty")
	}
	if recipe.Client == "" || recipe.Provider == "" || recipe.Model == "" {
		return Profile{}, fmt.Errorf("profiles.%s: client, provider, and model are required", name)
	}
	client, provider, err := reg.ResolveBinding(recipe.Client, recipe.Provider)
	if err != nil {
		return Profile{}, fmt.Errorf("profiles.%s: %w", name, err)
	}
	models := reg.ProviderModels(recipe.Provider)
	model, owned := models[recipe.Model]
	if !owned {
		return Profile{}, fmt.Errorf("profiles.%s: model %q is not registered for provider %q", name, recipe.Model, recipe.Provider)
	}
	if err := provider.ValidateModel(recipe.Model); err != nil {
		return Profile{}, fmt.Errorf("profiles.%s: %w", name, err)
	}

	env := map[string]string{}
	switch client.Dialect {
	case catalog.DialectGrok:
		env["GROK_MODEL"] = grok.ModelID(recipe.Provider, recipe.Model)
	case catalog.DialectCodex:
		env["CODEX_MODEL"] = recipe.Model
	case catalog.DialectClaudeCode, catalog.DialectCodeBuddy:
		env["ANTHROPIC_MODEL"] = recipe.Model
	case catalog.DialectOpenCode:
		env["OPENCODE_MODEL"] = recipe.Provider + "/" + recipe.Model
	case catalog.DialectDSH:
		env[catalog.EnvDSHModel] = recipe.Provider + "/" + recipe.Model
	default:
		return Profile{}, fmt.Errorf("profiles.%s: client %q has no profile template", name, recipe.Client)
	}
	description := strings.TrimSpace(recipe.Description)
	if description == "" {
		description = name
	}

	// Validate recipe capabilities and carry them into the runtime profile.
	var capabilities []string
	if len(recipe.Capabilities) > 0 {
		validated, err := config.ValidateCapabilities(recipe.Capabilities)
		if err != nil {
			return Profile{}, fmt.Errorf("profiles.%s: %w", name, err)
		}
		capabilities = validated
	}

	return Profile{
		Name: name, Client: recipe.Client, Provider: recipe.Provider,
		Launcher: map[string]any{"command": client.Binary.Name},
		Env:      env, Settings: map[string]any{}, Description: description,
		Supports1M:   model.ContextWindow >= 1000000,
		Capabilities: capabilities,
	}, nil
}
