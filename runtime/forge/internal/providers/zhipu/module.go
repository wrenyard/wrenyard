package zhipu

import "github.com/wrenyard/wrenyard/runtime/forge/internal/providers/schema"

func Module() schema.ProviderModule {
	return schema.StaticModule{
		ProviderID: "zhipu-coding",
		Provider: schema.Provider{
			Name: "zhipu-coding", Kind: "builtin",
			CompatibleDialects: []schema.Dialect{schema.DialectClaudeCode, schema.DialectGrok, schema.DialectDSH},
			QuotaProvider:      "zhipu-coding", DefaultModel: "glm-5.3",
			Inference: &schema.InferenceBinding{
				Protocol: "anthropic-messages", Endpoint: "https://open.bigmodel.cn/api/anthropic/v1/messages",
				CredentialResolver: schema.CredentialResolverForgeManaged,
			},
			RawLLM: []schema.RawLLMCapability{
				{Protocol: schema.RawLLMProtocolOpenAI, BaseEndpoint: "https://open.bigmodel.cn/api/coding/paas/v4/chat/completions"},
				{Protocol: schema.RawLLMProtocolAnthropic, BaseEndpoint: "https://open.bigmodel.cn/api/anthropic/v1/messages"},
			},
		},
		ModelSet: schema.ProviderModels{
			"glm-5.3": {ID: "glm-5.3", DisplayName: "GLM-5.3", ContextWindow: 1048576},
		},
		AuthInfo:  schema.AuthMetadata{Login: true},
		QuotaInfo: schema.QuotaMetadata{Kind: "bigmodel", Name: "zhipu-coding"},
	}
}
