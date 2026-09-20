package zhipuapi

import "github.com/wrenyard/wrenyard/runtime/forge/internal/providers/schema"

func Module() schema.ProviderModule {
	const endpoint = "https://open.bigmodel.cn/api/paas/v4/chat/completions"
	models := schema.ProviderModels{
		"glm-5.3":       {ID: "glm-5.3", DisplayName: "GLM-5.3", ContextWindow: 1048576},
		"glm-5.3-flash": {ID: "glm-5.3-flash", DisplayName: "GLM-5.3 Flash", ContextWindow: 1048576},
		"glm-5.2":       {ID: "glm-5.2", DisplayName: "GLM-5.2", ContextWindow: 1048576},
	}
	return schema.StaticModule{
		ProviderID: "zhipu",
		Provider: schema.Provider{
			Name: "zhipu", Kind: "builtin",
			CompatibleDialects: []schema.Dialect{schema.DialectGrok, schema.DialectDSH},
			AllowedModels:      []string{"glm-5.3", "glm-5.3-flash", "glm-5.2"}, DefaultModel: "glm-5.3",
			Inference: &schema.InferenceBinding{Protocol: "openai-chat-completions", Endpoint: endpoint, CredentialResolver: schema.CredentialResolverForgeManaged, AuthScheme: schema.AuthSchemeBearer},
		},
		ModelSet: models, AuthInfo: schema.AuthMetadata{Login: true},
	}
}
