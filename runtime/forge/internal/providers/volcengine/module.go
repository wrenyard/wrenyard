package volcengine

import "github.com/wrenyard/wrenyard/runtime/forge/internal/providers/schema"

func Module() schema.ProviderModule {
	const endpoint = "https://ark.cn-beijing.volces.com/api/v3/chat/completions"
	models := schema.ProviderModels{
		"doubao-seed-2-0-lite-260215": {ID: "doubao-seed-2-0-lite-260215", DisplayName: "Doubao Seed 2.0 Lite", ContextWindow: 262144},
	}
	return schema.StaticModule{
		ProviderID: "volcengine",
		Provider: schema.Provider{
			Name: "volcengine", Kind: "builtin",
			CompatibleDialects: []schema.Dialect{schema.DialectGrok, schema.DialectDSH},
			AllowedModels:      []string{"doubao-seed-2-0-lite-260215"}, DefaultModel: "doubao-seed-2-0-lite-260215",
			Inference: &schema.InferenceBinding{Protocol: "openai-chat-completions", Endpoint: endpoint, CredentialResolver: schema.CredentialResolverForgeManaged, AuthScheme: schema.AuthSchemeBearer},
		},
		ModelSet: models, AuthInfo: schema.AuthMetadata{Login: true},
	}
}
