package cursor

import "github.com/wrenyard/wrenyard/runtime/forge/internal/providers/schema"

// Module registers the Cursor quota-only module. Cursor exposes no inference,
// raw LLM, client binary, or auth-login surface — only quota metadata.
func Module() schema.ProviderModule {
	return schema.StaticModule{
		ProviderID: "cursor",
		Provider: schema.Provider{
			Name: "cursor", Kind: "builtin",
			QuotaProvider: "cursor",
		},
		QuotaInfo: schema.QuotaMetadata{Kind: "cursor", Name: "cursor"},
	}
}
