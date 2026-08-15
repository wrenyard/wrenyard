package config

import (
	_ "embed"
)

//go:embed data/config.json
var embeddedConfigData []byte

// EmbeddedData returns the bundled Forge config bytes. The returned slice is
// the read-only embedded content and must not be mutated by callers.
func EmbeddedData() []byte {
	return embeddedConfigData
}
