package anthropic

import "github.com/wrenyard/wrenyard/runtime/forge/internal/providers/schema"

// Module registers the Claude Code subscription provider. Its public identity
// is claude-coding; the internal credential resolver stays the Claude resolver
// and is deliberately distinct from the anthropic API-key provider.
func Module() schema.ProviderModule {
	return schema.StaticModule{
		ProviderID: "claude-coding",
		Provider: schema.Provider{
			Name: "claude-coding", Kind: "builtin",
			CompatibleDialects: []schema.Dialect{schema.DialectClaudeCode},
			QuotaProvider:      "claude-coding", UseClientBinary: true,
			Inference: &schema.InferenceBinding{
				Protocol: "anthropic-messages", Endpoint: "https://api.anthropic.com/v1",
				CredentialResolver: schema.CredentialResolverClaude,
			},
		},
		QuotaInfo: schema.QuotaMetadata{Kind: "claude", Name: "claude-coding"},
	}
}
