package codexspark

import "github.com/wrenyard/wrenyard/runtime/forge/internal/providers/schema"

func Module() schema.ProviderModule {
	models := schema.ProviderModels{
		"gpt-5.3-codex-spark": {ID: "gpt-5.3-codex-spark", DisplayName: "GPT-5.3 Codex Spark"},
	}
	return schema.StaticModule{
		ProviderID: "codex-spark", ModelSet: models,
		Provider: schema.Provider{
			Name: "codex-spark", Kind: "builtin",
			CompatibleDialects: []schema.Dialect{schema.DialectCodex},
			QuotaProvider:      "codex-spark", AllowedModels: []string{"gpt-5.3-codex-spark"},
			Inference: &schema.InferenceBinding{Protocol: "openai-chat-completions", CredentialResolver: schema.CredentialResolverCodex},
		},
		QuotaInfo: schema.QuotaMetadata{Kind: "codex", Name: "codex-spark"},
	}
}
