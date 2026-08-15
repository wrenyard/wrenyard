package codex

import "github.com/wrenyard/wrenyard/runtime/forge/internal/providers/schema"

func Module() schema.ProviderModule {
	models := schema.ProviderModels{
		"gpt-5.6-sol":         {ID: "gpt-5.6-sol", DisplayName: "GPT-5.6 Sol"},
		"gpt-5.6-terra":       {ID: "gpt-5.6-terra", DisplayName: "GPT-5.6 Terra"},
		"gpt-5.6-luna":        {ID: "gpt-5.6-luna", DisplayName: "GPT-5.6 Luna"},
		"gpt-5.3-codex-spark": {ID: "gpt-5.3-codex-spark", DisplayName: "GPT-5.3 Codex Spark"},
		"gpt-5.5":             {ID: "gpt-5.5", DisplayName: "GPT-5.5"},
		"gpt-5.4":             {ID: "gpt-5.4", DisplayName: "GPT-5.4"},
		"gpt-5.4-mini":        {ID: "gpt-5.4-mini", DisplayName: "GPT-5.4 Mini"},
	}
	return schema.StaticModule{
		ProviderID: "codex", ModelSet: models,
		Provider: schema.Provider{
			Name: "codex", Kind: "builtin",
			CompatibleDialects: []schema.Dialect{schema.DialectCodex},
			QuotaProvider:      "codex",
			Inference:          &schema.InferenceBinding{Protocol: "openai-chat-completions", CredentialResolver: schema.CredentialResolverCodex},
		},
		QuotaInfo: schema.QuotaMetadata{Kind: "codex", Name: "codex"},
	}
}
