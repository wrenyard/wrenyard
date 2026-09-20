// Package deepseek registers the official DeepSeek open-platform provider.
// Its credential is resolved through the existing Forge-managed path, which
// reuses the legacy DeepSeek secret lookup used by the DeepSeek balance quota.
package deepseek

import "github.com/wrenyard/wrenyard/runtime/forge/internal/providers/schema"

func Module() schema.ProviderModule {
	const endpoint = "https://api.deepseek.com/chat/completions"
	// The official open platform publishes exactly two models, and both share
	// the same verified context and output limits.
	models := schema.ProviderModels{
		"deepseek-flash": {ID: "deepseek-flash", DisplayName: "DeepSeek V4.1 Flash", ContextWindow: 1000000, MaxTokens: 384000},
		"deepseek-pro":   {ID: "deepseek-pro", DisplayName: "DeepSeek V4 Pro", ContextWindow: 1000000, MaxTokens: 384000},
	}
	return schema.StaticModule{
		ProviderID: "deepseek",
		Provider: schema.Provider{
			Name: "deepseek", Kind: "builtin",
			AllowedModels: []string{"deepseek-flash", "deepseek-pro"}, DefaultModel: "deepseek-flash",
			Inference: &schema.InferenceBinding{Protocol: "openai-chat-completions", Endpoint: endpoint, CredentialResolver: schema.CredentialResolverForgeManaged, AuthScheme: schema.AuthSchemeBearer},
		},
		ModelSet: models, AuthInfo: schema.AuthMetadata{Login: true},
	}
}
