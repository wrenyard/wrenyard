package opencode

import "github.com/wrenyard/wrenyard/runtime/forge/internal/providers/schema"

func Module() schema.ProviderModule {
	return schema.StaticModule{
		ProviderID: "opencode-native",
		Provider: schema.Provider{
			Name: "opencode-native", Kind: "builtin",
			CompatibleDialects: []schema.Dialect{schema.DialectOpenCode},
		},
	}
}
