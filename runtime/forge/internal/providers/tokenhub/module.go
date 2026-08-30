package tokenhub

import "github.com/wrenyard/wrenyard/runtime/forge/internal/providers/schema"

func Module() schema.ProviderModule {
	const openAIEndpoint = "https://tokenhub.tencentmaas.com/v1/chat/completions"
	const anthropicEndpoint = "https://tokenhub.tencentmaas.com/v1/messages"
	models := schema.ProviderModels{
		"hy4-preview":                           {ID: "hy4-preview", DisplayName: "Hunyuan HY4 Preview", ContextWindow: 262144},
		"deepseek-v4-flash-202605":              {ID: "deepseek-v4-flash-202605", DisplayName: "DeepSeek V4 Flash", ContextWindow: 1048576},
		"deepseek-v4-pro-202606":                {ID: "deepseek-v4-pro-202606", DisplayName: "DeepSeek V4 Pro", ContextWindow: 1048576},
		"deepseek/deepseek-v4-flash-vision-exp": {ID: "deepseek/deepseek-v4-flash-vision-exp", DisplayName: "DeepSeek V4 Flash Vision", ContextWindow: 1048576},
		"glm-5.3":                               {ID: "glm-5.3", DisplayName: "GLM-5.3", ContextWindow: 1048576},
		"glm-5.3-flash":                         {ID: "glm-5.3-flash", DisplayName: "GLM-5.3 Flash", ContextWindow: 1048576},
		"kimi-k2.6":                             {ID: "kimi-k2.6", DisplayName: "Kimi K2.6", ContextWindow: 262144},
		"minimax-m2.7":                          {ID: "minimax-m2.7", DisplayName: "MiniMax M2.7", ContextWindow: 204800},
		"qwen3.5-plus":                          {ID: "qwen3.5-plus", DisplayName: "Qwen3.5 Plus", ContextWindow: 1048576},
	}
	allowed := []string{"hy4-preview", "deepseek-v4-flash-202605", "deepseek-v4-pro-202606", "deepseek/deepseek-v4-flash-vision-exp", "glm-5.3", "glm-5.3-flash", "kimi-k2.6", "minimax-m2.7", "qwen3.5-plus"}
	return schema.StaticModule{
		ProviderID: "tokenhub",
		Provider: schema.Provider{
			Name: "tokenhub", Kind: "builtin",
			CompatibleDialects: []schema.Dialect{schema.DialectGrok, schema.DialectDSH},
			AllowedModels:      allowed, DefaultModel: "deepseek-v4-flash-202605",
			Inference: &schema.InferenceBinding{Protocol: "openai-chat-completions", Endpoint: openAIEndpoint, CredentialResolver: schema.CredentialResolverForgeManaged, AuthScheme: schema.AuthSchemeBearer},
			RawLLM: []schema.RawLLMCapability{
				{Protocol: schema.RawLLMProtocolOpenAI, BaseEndpoint: openAIEndpoint, AuthScheme: schema.AuthSchemeBearer},
				{Protocol: schema.RawLLMProtocolAnthropic, BaseEndpoint: anthropicEndpoint, AuthScheme: schema.AuthSchemeAPIKey},
			},
		},
		ModelSet: models, AuthInfo: schema.AuthMetadata{Login: true},
	}
}
