package forge

import "github.com/wrenyard/wrenyard/runtime/forge/internal/profiles/config"

func embeddedForgeConfig() (ForgeConfig, error) {
	cfg, err := config.ParseEmbeddedDefaults(config.EmbeddedData())
	if err != nil {
		return ForgeConfig{}, err
	}
	config.FillDefaults(&cfg, config.EmbeddedData())
	return cfg, nil
}

func parseEmbeddedDefaults() (ForgeConfig, error) {
	return config.ParseEmbeddedDefaults(config.EmbeddedData())
}

func fillForgeConfigDefaults(c *ForgeConfig) {
	config.FillDefaults(c, config.EmbeddedData())
}

func DefaultForgeConfig() ForgeConfig {
	return config.Default(config.EmbeddedData())
}
