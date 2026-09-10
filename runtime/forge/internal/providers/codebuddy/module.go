package codebuddy

import "github.com/wrenyard/wrenyard/runtime/forge/internal/providers/schema"

// Module returns the built-in CodeBuddy provider module. The binding runs
// through the codebuddy client binary and uses the CodeBuddy native
// credential source; it declares no inference transport, raw LLM capability,
// quota surface, endpoint, or API key.
func Module() schema.ProviderModule {
	models := schema.ProviderModels{
		"deepseek-v4.1-flash": {ID: "deepseek-v4.1-flash", DisplayName: "DeepSeek V4.1 Flash", ContextWindow: 1000000},
		"hy4-preview":         {ID: "hy4-preview", DisplayName: "Hunyuan HY4 Preview"},
		"hy3":                 {ID: "hy3", DisplayName: "HY3"},
		"minimax-m3":          {ID: "minimax-m3", DisplayName: "MiniMax M3"},
		"kimi-k3":             {ID: "kimi-k3", DisplayName: "Kimi K3"},
		"glm-5.3":             {ID: "glm-5.3", DisplayName: "GLM-5.3"},
		"glm-5.3-flash":       {ID: "glm-5.3-flash", DisplayName: "GLM-5.3 Flash"},
	}
	return schema.StaticModule{
		ProviderID: "codebuddy", ModelSet: models,
		Provider: schema.Provider{
			Name: "codebuddy", Kind: "builtin",
			CompatibleDialects: []schema.Dialect{schema.DialectCodeBuddy},
			CredentialResolver: schema.CredentialResolverCodeBuddy,
			UseClientBinary:    true,
			AllowedModels: []string{
				"deepseek-v4.1-flash", "hy4-preview", "hy3", "minimax-m3",
				"kimi-k3", "glm-5.3", "glm-5.3-flash",
			},
		},
	}
}
