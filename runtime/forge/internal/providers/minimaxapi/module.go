package minimaxapi

import "github.com/wrenyard/wrenyard/runtime/forge/internal/providers/schema"

func Module() schema.ProviderModule { return module("minimax") }

func module(id string) schema.ProviderModule {
	models := schema.ProviderModels{
		"MiniMax-M3":             {ID: "MiniMax-M3", DisplayName: "MiniMax M3", ContextWindow: 1000000},
		"MiniMax-M2.7":           {ID: "MiniMax-M2.7", DisplayName: "MiniMax M2.7", ContextWindow: 204800},
		"MiniMax-M2.7-highspeed": {ID: "MiniMax-M2.7-highspeed", DisplayName: "MiniMax M2.7 Highspeed", ContextWindow: 204800},
	}
	const openAIEndpoint = "https://api.minimaxi.com/v1/chat/completions"
	return schema.StaticModule{
		ProviderID: id,
		Provider: schema.Provider{
			Name: id, Kind: "builtin",
			CompatibleDialects: []schema.Dialect{schema.DialectGrok, schema.DialectDSH},
			AllowedModels:      []string{"MiniMax-M3", "MiniMax-M2.7", "MiniMax-M2.7-highspeed"}, DefaultModel: "MiniMax-M3",
			Inference: &schema.InferenceBinding{Protocol: "openai-chat-completions", Endpoint: openAIEndpoint, CredentialResolver: schema.CredentialResolverForgeManaged, AuthScheme: schema.AuthSchemeBearer},
		},
		ModelSet: models, AuthInfo: schema.AuthMetadata{Login: true},
	}
}
