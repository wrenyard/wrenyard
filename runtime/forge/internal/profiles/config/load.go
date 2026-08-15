package config

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"
)

// LoadForgeConfig loads the user Forge config.json from path, falling back to
// the embedded config bytes when the user file is entirely absent (sole-source
// semantics: the user file, when present, is the only runtime source and is
// filled with typed defaults for missing keys). Unknown keys cause an error.
func LoadForgeConfig(path string, embeddedData []byte, w io.Writer) (Config, []string, error) {
	var warnings []string

	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			cfg, _ := ParseEmbeddedDefaults(embeddedData)
			FillDefaults(&cfg, embeddedData)
			return cfg, nil, nil
		}
		return Config{}, nil, fmt.Errorf("read %s: %w", path, err)
	}

	// Strict JSON decoding with DisallowUnknownFields.
	decoder := json.NewDecoder(strings.NewReader(string(data)))
	decoder.DisallowUnknownFields()
	var userCfg Config
	if err := decoder.Decode(&userCfg); err != nil {
		return Config{}, nil, fmt.Errorf("invalid %s: %w (unknown or invalid fields are not allowed)", path, err)
	}

	cfg := userCfg
	FillDefaults(&cfg, embeddedData)

	for _, wmsg := range warnings {
		fmt.Fprintf(w, "forge: %s\n", wmsg)
	}
	return cfg, warnings, nil
}
