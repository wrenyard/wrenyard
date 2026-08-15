package xai

import "github.com/wrenyard/wrenyard/runtime/forge/internal/providers/schema"

func Module() schema.ProviderModule {
	return schema.StaticModule{
		ProviderID: "xai",
		Provider: schema.Provider{
			Name: "xai", Kind: "builtin",
			CompatibleDialects: []schema.Dialect{schema.DialectGrok},
			SecretResolution:   "native-oauth", AllowedModels: []string{"grok-4.5"}, DefaultModel: "grok-4.5",
			Inference: &schema.InferenceBinding{
				Protocol: "openai-chat-completions", Endpoint: "https://api.x.ai/v1",
				CredentialResolver: schema.CredentialResolverGrokOAuth,
			},
		},
		ModelSet: schema.ProviderModels{"grok-4.5": {ID: "grok-4.5", DisplayName: "Grok 4.5", ContextWindow: 2000000}},
	}
}
