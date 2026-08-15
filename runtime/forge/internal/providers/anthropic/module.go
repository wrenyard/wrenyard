package anthropic

import "github.com/wrenyard/wrenyard/runtime/forge/internal/providers/schema"

func Module() schema.ProviderModule {
	return schema.StaticModule{
		ProviderID: "anthropic",
		Provider: schema.Provider{
			Name: "anthropic", Kind: "builtin",
			CompatibleDialects: []schema.Dialect{schema.DialectClaudeCode},
			QuotaProvider:      "anthropic", UseClientBinary: true,
			Inference: &schema.InferenceBinding{
				Protocol: "anthropic-messages", Endpoint: "https://api.anthropic.com/v1",
				CredentialResolver: schema.CredentialResolverClaude,
			},
			RawLLM: []schema.RawLLMCapability{{Protocol: schema.RawLLMProtocolAnthropic, BaseEndpoint: "https://api.anthropic.com/v1"}},
		},
		QuotaInfo: schema.QuotaMetadata{Kind: "claude", Name: "anthropic"},
	}
}
