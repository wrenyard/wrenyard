package cursor

import "github.com/wrenyard/wrenyard/runtime/forge/internal/providers/schema"

// Module registers the Cursor native provider module. Cursor is a dedicated
// client dialect with native auth; it exposes the cursor-agent binary and owns
// its model set plus quota metadata.
func Module() schema.ProviderModule {
	return schema.StaticModule{
		ProviderID: "cursor",
		Provider: schema.Provider{
			Name: "cursor", Kind: "builtin",
			QuotaProvider:      "cursor",
			CompatibleDialects: []schema.Dialect{schema.DialectCursor},
			CredentialResolver: schema.CredentialResolverCursor,
			AllowedModels:      []string{"composer-2.5", "cursor-grok-4.6-high"},
			DefaultModel:       "composer-2.5",
			UseClientBinary:    true,
		},
		ModelSet: schema.ProviderModels{
			"composer-2.5": {
				ID: "composer-2.5", DisplayName: "Composer 2.5", ContextWindow: 200000,
			},
			"cursor-grok-4.6-high": {
				ID: "cursor-grok-4.6-high", DisplayName: "Cursor Grok 4.6 High", ContextWindow: 256000,
			},
		},
		QuotaInfo: schema.QuotaMetadata{Kind: "cursor", Name: "cursor"},
	}
}
