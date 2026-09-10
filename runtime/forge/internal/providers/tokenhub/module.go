package tokenhub

import "github.com/wrenyard/wrenyard/runtime/forge/internal/providers/schema"

func Module() schema.ProviderModule {
	const openAIEndpoint = "https://tokenhub.tencentmaas.com/v1/chat/completions"
	models := schema.ProviderModels{
		"hy4-preview":             {ID: "hy4-preview", DisplayName: "Hunyuan HY4 Preview", ContextWindow: 262144},
		"deepseek/deepseek-flash": {ID: "deepseek/deepseek-flash", DisplayName: "DeepSeek V4.1 Flash", ContextWindow: 1000000},
		"glm-5.3":                 {ID: "glm-5.3", DisplayName: "GLM-5.3", ContextWindow: 1048576},
		"glm-5.3-flash":           {ID: "glm-5.3-flash", DisplayName: "GLM-5.3 Flash", ContextWindow: 1048576},
		"kimi-k2.6":               {ID: "kimi-k2.6", DisplayName: "Kimi K2.6", ContextWindow: 262144},
		"minimax-m2.7":            {ID: "minimax-m2.7", DisplayName: "MiniMax M2.7", ContextWindow: 204800},
		"qwen3.5-plus":            {ID: "qwen3.5-plus", DisplayName: "Qwen3.5 Plus", ContextWindow: 1048576},
	}
	allowed := []string{"hy4-preview", "deepseek/deepseek-flash", "glm-5.3", "glm-5.3-flash", "kimi-k2.6", "minimax-m2.7", "qwen3.5-plus"}
	return schema.StaticModule{
		ProviderID: "tokenhub",
		Provider: schema.Provider{
			Name: "tokenhub", Kind: "builtin",
			CompatibleDialects: []schema.Dialect{schema.DialectGrok, schema.DialectDSH},
			AllowedModels:      allowed, DefaultModel: "deepseek/deepseek-flash",
			Inference: &schema.InferenceBinding{Protocol: "openai-chat-completions", Endpoint: openAIEndpoint, CredentialResolver: schema.CredentialResolverForgeManaged, AuthScheme: schema.AuthSchemeBearer},
		},
		ModelSet: models, AuthInfo: schema.AuthMetadata{Login: true},
	}
}
