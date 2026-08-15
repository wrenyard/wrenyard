package config

import (
	"encoding/json"
	"fmt"
)

// ParseEmbeddedDefaults parses the embedded config.json bytes and returns the
// resulting Config or an error.
func ParseEmbeddedDefaults(data []byte) (Config, error) {
	var cfg Config
	if err := json.Unmarshal(data, &cfg); err != nil {
		return Config{}, fmt.Errorf("invalid embedded config: %w", err)
	}
	return cfg, nil
}

// FillDefaults fills missing typed fields of cfg from the embedded defaults
// parsed from data. Applies only thin runtime override defaults.
func FillDefaults(cfg *Config, data []byte) {
	if cfg.Clients == nil {
		cfg.Clients = map[string]Client{}
	}
	if cfg.Providers == nil {
		cfg.Providers = map[string]ProviderOverride{}
	}
	if cfg.Profiles == nil {
		cfg.Profiles = map[string]ProfileRecipe{}
	}
	if cfg.CustomProviders == nil {
		cfg.CustomProviders = map[string]CustomProvider{}
	}
	if cfg.Quota.StatuslineTTLSec == 0 {
		cfg.Quota.StatuslineTTLSec = 600
	}
	if cfg.Quota.UsageTTLMin == 0 {
		cfg.Quota.UsageTTLMin = 10
	}
	if cfg.Quota.SnapshotStaleMin == 0 {
		cfg.Quota.SnapshotStaleMin = 15
	}
	if cfg.Quota.StatuslineRenderMs == 0 {
		cfg.Quota.StatuslineRenderMs = 250
	}
	if cfg.Quota.StatuslineFetchSec == 0 {
		cfg.Quota.StatuslineFetchSec = 2
	}
	// LLMModel has no internal default: it stays empty unless the user
	// configures it explicitly.
	if cfg.LLMProtocol == "" {
		cfg.LLMProtocol = "openai"
	}
}

// Default returns a fully-defaulted Config.
func Default(data []byte) Config {
	cfg := Config{}
	FillDefaults(&cfg, data)
	return cfg
}
