package qwenapi

import "github.com/wrenyard/wrenyard/runtime/forge/internal/providers/schema"

func Module() schema.ProviderModule {
	const openAIEndpoint = "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions"
	const anthropicEndpoint = "https://dashscope.aliyuncs.com/apps/anthropic/v1/messages"
	models := schema.ProviderModels{
		"qwen3.8-max":      {ID: "qwen3.8-max", DisplayName: "Qwen3.8 Max", ContextWindow: 1000000},
		"qwen3.7-plus":     {ID: "qwen3.7-plus", DisplayName: "Qwen3.7 Plus", ContextWindow: 1000000},
		"qwen3.7-flash":    {ID: "qwen3.7-flash", DisplayName: "Qwen3.7 Flash", ContextWindow: 1000000},
		"qwen3-coder-next": {ID: "qwen3-coder-next", DisplayName: "Qwen3 Coder Next", ContextWindow: 262144},
	}
	return schema.StaticModule{
		ProviderID: "qwen",
		Provider: schema.Provider{
			Name: "qwen", Kind: "builtin",
			CompatibleDialects: []schema.Dialect{schema.DialectGrok, schema.DialectDSH},
			AllowedModels:      []string{"qwen3.8-max", "qwen3.7-plus", "qwen3.7-flash", "qwen3-coder-next"}, DefaultModel: "qwen3.7-plus",
			Inference: &schema.InferenceBinding{Protocol: "openai-chat-completions", Endpoint: openAIEndpoint, CredentialResolver: schema.CredentialResolverForgeManaged, AuthScheme: schema.AuthSchemeBearer},
			RawLLM: []schema.RawLLMCapability{
				{Protocol: schema.RawLLMProtocolOpenAI, BaseEndpoint: openAIEndpoint, AuthScheme: schema.AuthSchemeBearer},
				{Protocol: schema.RawLLMProtocolAnthropic, BaseEndpoint: anthropicEndpoint, AuthScheme: schema.AuthSchemeBearer},
			},
		},
		ModelSet: models, AuthInfo: schema.AuthMetadata{Login: true},
	}
}
