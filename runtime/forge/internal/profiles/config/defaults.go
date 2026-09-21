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
	if cfg.CustomProviders == nil {
		cfg.CustomProviders = map[string]CustomProvider{}
	}
}

// Default returns a fully-defaulted Config.
func Default(data []byte) Config {
	cfg := Config{}
	FillDefaults(&cfg, data)
	return cfg
}
