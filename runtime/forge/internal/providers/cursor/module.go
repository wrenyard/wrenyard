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
			AllowedModels:      []string{"composer-2.5", "grok-4.6", "kimi-k3", "claude-opus-5", "gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol", "claude-sonnet-5", "muse-spark-1.3", "gemini-3.8-flash", "claude-fable-5", "claude-fable-5-1"},
			DefaultModel:       "composer-2.5",
			UseClientBinary:    true,
		},
		ModelSet: schema.ProviderModels{
			"composer-2.5": {
				ID: "composer-2.5", DisplayName: "Composer 2.5", ContextWindow: 200000,
			},
			"grok-4.6": {
				ID: "grok-4.6", DisplayName: "Grok 4.6", ContextWindow: 256000,
			},
			"kimi-k3": {
				ID: "kimi-k3", DisplayName: "Kimi K3", ContextWindow: 1048576,
			},
			"claude-opus-5": {
				ID: "claude-opus-5", DisplayName: "Claude Opus 5", ContextWindow: 300000,
			},
			"gpt-5.6-luna":     {ID: "gpt-5.6-luna", DisplayName: "GPT-5.6 Luna", ContextWindow: 272000},
			"gpt-5.6-terra":    {ID: "gpt-5.6-terra", DisplayName: "GPT-5.6 Terra", ContextWindow: 272000},
			"gpt-5.6-sol":      {ID: "gpt-5.6-sol", DisplayName: "GPT-5.6 Sol", ContextWindow: 272000},
			"claude-sonnet-5":  {ID: "claude-sonnet-5", DisplayName: "Claude Sonnet 5", ContextWindow: 300000},
			"muse-spark-1.3":   {ID: "muse-spark-1.3", DisplayName: "Muse Spark 1.3", ContextWindow: 300000},
			"gemini-3.8-flash": {ID: "gemini-3.8-flash", DisplayName: "Gemini 3.8 Flash", ContextWindow: 1000000},
			"claude-fable-5":   {ID: "claude-fable-5", DisplayName: "Claude Fable 5", ContextWindow: 300000},
			"claude-fable-5-1": {ID: "claude-fable-5-1", DisplayName: "Claude Fable 5.1", ContextWindow: 300000},
		},
		QuotaInfo: schema.QuotaMetadata{Kind: "cursor", Name: "cursor"},
	}
}
