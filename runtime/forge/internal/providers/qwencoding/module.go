package qwencoding

import "github.com/wrenyard/wrenyard/runtime/forge/internal/providers/schema"

func Module() schema.ProviderModule {
	const openAIEndpoint = "https://coding.dashscope.aliyuncs.com/v1/chat/completions"
	const anthropicEndpoint = "https://coding.dashscope.aliyuncs.com/apps/anthropic/v1/messages"
	models := schema.ProviderModels{
		"qwen3.7-plus":     {ID: "qwen3.7-plus", DisplayName: "Qwen3.7 Plus", ContextWindow: 1000000},
		"qwen3.6-plus":     {ID: "qwen3.6-plus", DisplayName: "Qwen3.6 Plus", ContextWindow: 1000000},
		"qwen3.5-plus":     {ID: "qwen3.5-plus", DisplayName: "Qwen3.5 Plus", ContextWindow: 1000000},
		"qwen3-coder-next": {ID: "qwen3-coder-next", DisplayName: "Qwen3 Coder Next", ContextWindow: 262144},
		"qwen3-coder-plus": {ID: "qwen3-coder-plus", DisplayName: "Qwen3 Coder Plus", ContextWindow: 1000000},
	}
	return schema.StaticModule{
		ProviderID: "qwen-coding",
		Provider: schema.Provider{
			Name: "qwen-coding", Kind: "builtin",
			CompatibleDialects: []schema.Dialect{schema.DialectGrok, schema.DialectDSH},
			AllowedModels:      []string{"qwen3.7-plus", "qwen3.6-plus", "qwen3.5-plus", "qwen3-coder-next", "qwen3-coder-plus"}, DefaultModel: "qwen3.7-plus",
			Inference: &schema.InferenceBinding{Protocol: "openai-chat-completions", Endpoint: openAIEndpoint, CredentialResolver: schema.CredentialResolverForgeManaged, AuthScheme: schema.AuthSchemeBearer},
			RawLLM: []schema.RawLLMCapability{
				{Protocol: schema.RawLLMProtocolOpenAI, BaseEndpoint: openAIEndpoint, AuthScheme: schema.AuthSchemeBearer},
				{Protocol: schema.RawLLMProtocolAnthropic, BaseEndpoint: anthropicEndpoint, AuthScheme: schema.AuthSchemeBearer},
			},
		},
		ModelSet: models, AuthInfo: schema.AuthMetadata{Login: true},
	}
}
