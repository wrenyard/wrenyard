package catalog

import "github.com/wrenyard/wrenyard/runtime/forge/internal/providers/schema"

// Provider remains a catalog-facing alias while vendor-owned definitions live
// behind the dependency-neutral provider module contract.
type Provider = schema.Provider
