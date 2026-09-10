// Package freepool assembles the OpenCode-managed free-pool provider modules:
// opencode-zen (free trial), openrouter (free shared pool), and opencode-go
// (paid $10/month subscription). All three are forge-managed bearer
// openai-chat-completions endpoints; none carry native billing or quota.
package freepool

import "github.com/wrenyard/wrenyard/runtime/forge/internal/providers/schema"

func Modules() []schema.ProviderModule {
	const (
		opencodeZenEndpoint = "https://opencode.ai/zen/v1/chat/completions"
		openRouterEndpoint  = "https://openrouter.ai/api/v1/chat/completions"
		opencodeGoEndpoint  = "https://opencode.ai/zen/go/v1/chat/completions"
	)
	dialects := []schema.Dialect{schema.DialectGrok, schema.DialectDSH, schema.DialectOpenCode}

	zenModels := schema.ProviderModels{
		"mimo-v2.5-free":          {ID: "mimo-v2.5-free", DisplayName: "OpenCode Zen Mimo v2.5 Free", ContextWindow: 1048576, MaxTokens: 32768},
		"ling-3.0-flash-fin-free": {ID: "ling-3.0-flash-fin-free", DisplayName: "Ling 3.0 Flash Fin Free", ContextWindow: 262144, MaxTokens: 32768},
	}
	zenAllowed := []string{"mimo-v2.5-free", "ling-3.0-flash-fin-free"}

	openRouterModels := schema.ProviderModels{
		"nex-agi/nex-n2.5-mini:free":  {ID: "nex-agi/nex-n2.5-mini:free", DisplayName: "Nex N2.5 Mini Free", ContextWindow: 262144, MaxTokens: 235929},
		"cohere/north-mini-code:free": {ID: "cohere/north-mini-code:free", DisplayName: "North Mini Code Free", ContextWindow: 256000, MaxTokens: 64000},
	}
	openRouterAllowed := []string{"nex-agi/nex-n2.5-mini:free", "cohere/north-mini-code:free"}

	goModels := schema.ProviderModels{
		"glm-5.3-flash":  {ID: "glm-5.3-flash", DisplayName: "GLM-5.3 Flash", ContextWindow: 1048576},
		"glm-5.3":        {ID: "glm-5.3", DisplayName: "GLM-5.3", ContextWindow: 1048576},
		"deepseek-flash": {ID: "deepseek-flash", DisplayName: "DeepSeek V4.1 Flash", ContextWindow: 1000000, MaxTokens: 384000},
		"hy3":            {ID: "hy3", DisplayName: "HY3"},
	}
	goAllowed := []string{"glm-5.3-flash", "glm-5.3", "deepseek-flash", "hy3"}

	return []schema.ProviderModule{
		schema.StaticModule{
			ProviderID: "opencode-zen",
			Provider: schema.Provider{
				Name:               "opencode-zen",
				Kind:               "builtin",
				CompatibleDialects: dialects,
				AllowedModels:      zenAllowed,
				DefaultModel:       "ling-3.0-flash-fin-free",
				Inference: &schema.InferenceBinding{
					Protocol:           "openai-chat-completions",
					Endpoint:           opencodeZenEndpoint,
					CredentialResolver: schema.CredentialResolverForgeManaged,
					AuthScheme:         schema.AuthSchemeBearer,
				},
			},
			ModelSet: zenModels,
			AuthInfo: schema.AuthMetadata{Login: true},
		},
		schema.StaticModule{
			ProviderID: "openrouter",
			Provider: schema.Provider{
				Name:               "openrouter",
				Kind:               "builtin",
				CompatibleDialects: dialects,
				AllowedModels:      openRouterAllowed,
				DefaultModel:       "nex-agi/nex-n2.5-mini:free",
				Inference: &schema.InferenceBinding{
					Protocol:           "openai-chat-completions",
					Endpoint:           openRouterEndpoint,
					CredentialResolver: schema.CredentialResolverForgeManaged,
					AuthScheme:         schema.AuthSchemeBearer,
				},
			},
			ModelSet: openRouterModels,
			AuthInfo: schema.AuthMetadata{Login: true},
		},
		schema.StaticModule{
			ProviderID: "opencode-go",
			Provider: schema.Provider{
				Name:               "opencode-go",
				Kind:               "builtin",
				CompatibleDialects: []schema.Dialect{schema.DialectOpenCode},
				AllowedModels:      goAllowed,
				DefaultModel:       "glm-5.3-flash",
				Inference: &schema.InferenceBinding{
					Protocol:           "openai-chat-completions",
					Endpoint:           opencodeGoEndpoint,
					CredentialResolver: schema.CredentialResolverForgeManaged,
					AuthScheme:         schema.AuthSchemeBearer,
				},
			},
			ModelSet: goModels,
			AuthInfo: schema.AuthMetadata{Login: true},
		},
	}
}
