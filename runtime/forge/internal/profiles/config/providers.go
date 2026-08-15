package config

// ProviderOverride holds the complete, protocol-scoped provider override
// surface. Values are full base URLs and are validated against module-declared
// protocol support before use.
type ProviderOverride struct {
	OpenAIBaseURL    string `json:"openai_base_url,omitempty"`
	AnthropicBaseURL string `json:"anthropic_base_url,omitempty"`
	APIKey           string `json:"api_key,omitempty"`
}
