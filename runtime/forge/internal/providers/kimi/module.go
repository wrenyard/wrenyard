package kimi

import "github.com/wrenyard/wrenyard/runtime/forge/internal/providers/schema"

func Module() schema.ProviderModule {
	return schema.StaticModule{
		ProviderID: "kimi-coding",
		Provider: schema.Provider{
			Name: "kimi-coding", Kind: "builtin",
			CompatibleDialects: []schema.Dialect{schema.DialectClaudeCode, schema.DialectGrok, schema.DialectDSH},
			// "kimi-for-coding" is the official wire id clients send for the
			// canonical kimi-k2.8 identity; it must stay allowed so
			// ValidateModel accepts requests that arrive already on the wire id.
			QuotaProvider: "kimi-coding", AllowedModels: []string{"k3", "k3[1m]", "kimi-k2.8", "kimi-for-coding"}, DefaultModel: "k3", UseClientBinary: true,
			Inference: &schema.InferenceBinding{
				Protocol: "anthropic-messages", Endpoint: "https://api.kimi.com/coding/v1/messages",
				CredentialResolver: schema.CredentialResolverForgeManaged,
			},
		},
		ModelSet: schema.ProviderModels{
			"k3":        {ID: "k3", DisplayName: "Kimi K3", ContextWindow: 1048576},
			"kimi-k2.8": {ID: "kimi-k2.8", DisplayName: "Kimi K2.8 Preview", ContextWindow: 1048576},
		},
		AuthInfo:  schema.AuthMetadata{Login: true},
		QuotaInfo: schema.QuotaMetadata{Kind: "kimi", Name: "kimi-coding"},
	}
}
