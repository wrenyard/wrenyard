package anthropicapi

import "github.com/wrenyard/wrenyard/runtime/forge/internal/providers/schema"

func Module() schema.ProviderModule {
	models := schema.ProviderModels{
		"claude-fable-5":            {ID: "claude-fable-5", DisplayName: "Claude Fable 5", ContextWindow: 1000000},
		"claude-opus-5":             {ID: "claude-opus-5", DisplayName: "Claude Opus 5", ContextWindow: 1000000},
		"claude-sonnet-5":           {ID: "claude-sonnet-5", DisplayName: "Claude Sonnet 5", ContextWindow: 1000000},
		"claude-haiku-4-5-20251001": {ID: "claude-haiku-4-5-20251001", DisplayName: "Claude Haiku 4.5", ContextWindow: 200000},
	}
	return schema.StaticModule{
		ProviderID: "anthropic-api",
		Provider: schema.Provider{
			Name: "anthropic-api", Kind: "builtin",
			AllowedModels: []string{"claude-fable-5", "claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5-20251001"},
			DefaultModel:  "claude-sonnet-5",
			Inference: &schema.InferenceBinding{
				Protocol: "anthropic-messages", Endpoint: "https://api.anthropic.com/v1/messages",
				CredentialResolver: schema.CredentialResolverForgeManaged,
				AuthScheme:         schema.AuthSchemeAPIKey,
			},
			RawLLM: []schema.RawLLMCapability{{
				Protocol: schema.RawLLMProtocolAnthropic, BaseEndpoint: "https://api.anthropic.com/v1/messages", AuthScheme: schema.AuthSchemeAPIKey,
			}},
		},
		ModelSet: models,
		AuthInfo: schema.AuthMetadata{Login: true},
	}
}
