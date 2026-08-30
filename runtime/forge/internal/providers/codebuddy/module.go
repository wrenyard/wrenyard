package codebuddy

import "github.com/wrenyard/wrenyard/runtime/forge/internal/providers/schema"

// Module returns the built-in CodeBuddy provider module. The binding runs
// through the codebuddy client binary and uses the CodeBuddy native
// credential source; it declares no inference transport, raw LLM capability,
// quota surface, endpoint, or API key.
func Module() schema.ProviderModule {
	models := schema.ProviderModels{
		"deepseek-v4-flash": {ID: "deepseek-v4-flash", DisplayName: "DeepSeek V4 Flash"},
		"deepseek-v4-pro":   {ID: "deepseek-v4-pro", DisplayName: "DeepSeek V4 Pro"},
		"hy4-preview-ioa":   {ID: "hy4-preview-ioa", DisplayName: "Hunyuan HY4 Preview"},
		"kimi-k2.6":         {ID: "kimi-k2.6", DisplayName: "Kimi K2.6"},
	}
	return schema.StaticModule{
		ProviderID: "codebuddy", ModelSet: models,
		Provider: schema.Provider{
			Name: "codebuddy", Kind: "builtin",
			CompatibleDialects: []schema.Dialect{schema.DialectCodeBuddy},
			CredentialResolver: schema.CredentialResolverCodeBuddy,
			UseClientBinary:    true,
			AllowedModels: []string{
				"deepseek-v4-flash", "deepseek-v4-pro", "hy4-preview-ioa", "kimi-k2.6",
			},
		},
	}
}
