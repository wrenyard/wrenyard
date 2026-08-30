package openaiapi

import "github.com/wrenyard/wrenyard/runtime/forge/internal/providers/schema"

func Module() schema.ProviderModule {
	allowed := []string{"gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"}
	models := schema.ProviderModels{
		"gpt-5.6-sol":   {ID: "gpt-5.6-sol", DisplayName: "GPT-5.6 Sol", ContextWindow: 1050000},
		"gpt-5.6-terra": {ID: "gpt-5.6-terra", DisplayName: "GPT-5.6 Terra", ContextWindow: 1050000},
		"gpt-5.6-luna":  {ID: "gpt-5.6-luna", DisplayName: "GPT-5.6 Luna", ContextWindow: 1050000},
	}
	return schema.StaticModule{
		ProviderID: "openai",
		Provider: schema.Provider{
			Name: "openai", Kind: "builtin",
			CompatibleDialects: []schema.Dialect{schema.DialectGrok, schema.DialectDSH},
			AllowedModels:      allowed, DefaultModel: "gpt-5.6-sol",
			Inference: &schema.InferenceBinding{
				Protocol: "openai-chat-completions", Endpoint: "https://api.openai.com/v1/chat/completions",
				CredentialResolver: schema.CredentialResolverForgeManaged,
				AuthScheme:         schema.AuthSchemeBearer,
			},
			RawLLM: []schema.RawLLMCapability{{
				Protocol: schema.RawLLMProtocolOpenAI, BaseEndpoint: "https://api.openai.com/v1/chat/completions", AuthScheme: schema.AuthSchemeBearer,
			}},
		},
		ModelSet: models,
		AuthInfo: schema.AuthMetadata{Login: true},
	}
}
