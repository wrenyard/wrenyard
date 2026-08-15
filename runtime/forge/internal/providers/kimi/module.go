package kimi

import "github.com/wrenyard/wrenyard/runtime/forge/internal/providers/schema"

func Module() schema.ProviderModule {
	return schema.StaticModule{
		ProviderID: "kimi-coding",
		Provider: schema.Provider{
			Name: "kimi-coding", Kind: "builtin",
			CompatibleDialects: []schema.Dialect{schema.DialectClaudeCode, schema.DialectGrok, schema.DialectDSH},
			QuotaProvider:      "kimi-coding", AllowedModels: []string{"k3", "k3[1m]"}, DefaultModel: "k3", UseClientBinary: true,
			Inference: &schema.InferenceBinding{
				Protocol: "anthropic-messages", Endpoint: "https://api.kimi.com/coding/v1/messages",
				CredentialResolver: schema.CredentialResolverForgeManaged,
			},
			RawLLM: []schema.RawLLMCapability{
				{Protocol: schema.RawLLMProtocolOpenAI, BaseEndpoint: "https://api.kimi.com/coding/v1/chat/completions"},
				{Protocol: schema.RawLLMProtocolAnthropic, BaseEndpoint: "https://api.kimi.com/coding/v1/messages"},
			},
		},
		ModelSet:  schema.ProviderModels{"k3": {ID: "k3", DisplayName: "Kimi K3", ContextWindow: 1048576}},
		AuthInfo:  schema.AuthMetadata{Login: true},
		QuotaInfo: schema.QuotaMetadata{Kind: "kimi", Name: "kimi-coding"},
	}
}
