package moonshot

import "github.com/wrenyard/wrenyard/runtime/forge/internal/providers/schema"

func Module() schema.ProviderModule {
	const endpoint = "https://api.moonshot.cn/v1/chat/completions"
	models := schema.ProviderModels{
		"kimi-k2.6": {ID: "kimi-k2.6", DisplayName: "Kimi K2.6", ContextWindow: 262144},
		"kimi-k2.5": {ID: "kimi-k2.5", DisplayName: "Kimi K2.5", ContextWindow: 262144},
	}
	return schema.StaticModule{
		ProviderID: "moonshot",
		Provider: schema.Provider{
			Name: "moonshot", Kind: "builtin",
			CompatibleDialects: []schema.Dialect{schema.DialectGrok, schema.DialectDSH},
			AllowedModels:      []string{"kimi-k2.6", "kimi-k2.5"}, DefaultModel: "kimi-k2.6",
			Inference: &schema.InferenceBinding{Protocol: "openai-chat-completions", Endpoint: endpoint, CredentialResolver: schema.CredentialResolverForgeManaged, AuthScheme: schema.AuthSchemeBearer},
			RawLLM:    []schema.RawLLMCapability{{Protocol: schema.RawLLMProtocolOpenAI, BaseEndpoint: endpoint, AuthScheme: schema.AuthSchemeBearer}},
		},
		ModelSet: models, AuthInfo: schema.AuthMetadata{Login: true},
	}
}
