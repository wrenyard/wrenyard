package capability

import (
	_ "embed"
)

//go:embed data/capabilities.json
var embeddedCapabilities []byte

// EmbeddedData returns the bundled capability registry bytes. The returned
// slice is the read-only embedded content and must not be mutated by callers.
func EmbeddedData() []byte {
	return embeddedCapabilities
}
