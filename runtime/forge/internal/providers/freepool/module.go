// Package freepool assembles the OpenCode-managed free-pool provider modules:
// opencode-zen (genuine OpenCode client transport, free pool plus paid
// glm-5.3/kimi-k3), openrouter (free shared pool), and opencode-go (paid
// $10/month subscription). All three are forge-managed bearer
// openai-chat-completions endpoints; none carry native billing or quota.
package freepool

import "github.com/wrenyard/wrenyard/runtime/forge/internal/providers/schema"

func Modules() []schema.ProviderModule {
	const (
		opencodeZenEndpoint = "https://opencode.ai/zen/v1/chat/completions"
		openRouterEndpoint  = "https://openrouter.ai/api/v1/chat/completions"
		opencodeGoEndpoint  = "https://opencode.ai/zen/go/v1/chat/completions"
	)
	// Zen's Anthropic-messages protocol serves union-alpha; the default stays a
	// chat-completions free model so the genuine OpenCode route keeps working.
	dialects := []schema.Dialect{schema.DialectGrok, schema.DialectDSH, schema.DialectOpenCode, schema.DialectClaudeCode}

	// Zen free pool: usable only through the genuine OpenCode client transport.
	// The paid pool (glm-5.3, kimi-k3) stays gateway-usable.
	zenModels := schema.ProviderModels{
		"big-pickle":                  {ID: "big-pickle", DisplayName: "Big Pickle Free", ContextWindow: 200000, MaxTokens: 128000},
		"union-alpha":                 {ID: "union-alpha", DisplayName: "Union Alpha Free", ContextWindow: 200000, MaxTokens: 64000},
		"mimo-v2.5-free":              {ID: "mimo-v2.5-free", DisplayName: "OpenCode Zen Mimo v2.5 Free", ContextWindow: 1048576, MaxTokens: 32768},
		"ling-3.0-flash-fin-free":     {ID: "ling-3.0-flash-fin-free", DisplayName: "Ling 3.0 Flash Fin Free", ContextWindow: 262144, MaxTokens: 32768},
		"nemotron-3-ultra-free":       {ID: "nemotron-3-ultra-free", DisplayName: "Nemotron 3 Ultra Free", ContextWindow: 1000000, MaxTokens: 32768},
		"nemotron-3.5-lightning-free": {ID: "nemotron-3.5-lightning-free", DisplayName: "Nemotron 3.5 Lightning Free", ContextWindow: 1000000, MaxTokens: 32768},
		"glm-5.3":                     {ID: "glm-5.3", DisplayName: "GLM 5.3", ContextWindow: 1048576, MaxTokens: 32768},
		"kimi-k3":                     {ID: "kimi-k3", DisplayName: "Kimi K3", ContextWindow: 1048576, MaxTokens: 32768},
	}
	zenAllowed := []string{
		"mimo-v2.5-free", "ling-3.0-flash-fin-free", "big-pickle", "union-alpha",
		"nemotron-3-ultra-free", "nemotron-3.5-lightning-free", "glm-5.3", "kimi-k3",
	}

	// OpenRouter free pool: the exact official catalogue, mirroring the
	// authoritative TypeScript provider registry. Display names stay hyphen-free.
	openRouterModels := schema.ProviderModels{
		"nex-agi/nex-n2.5-mini:free":                         {ID: "nex-agi/nex-n2.5-mini:free", DisplayName: "Nex N2.5 Mini Free", ContextWindow: 262144, MaxTokens: 235929},
		"nex-agi/nex-n2.5-pro:free":                          {ID: "nex-agi/nex-n2.5-pro:free", DisplayName: "Nex N2.5 Pro Free", ContextWindow: 262144, MaxTokens: 235929},
		"cohere/north-mini-code:free":                        {ID: "cohere/north-mini-code:free", DisplayName: "North Mini Code Free", ContextWindow: 256000, MaxTokens: 64000},
		"inclusionai/ling-3.0-flash-vl:free":                 {ID: "inclusionai/ling-3.0-flash-vl:free", DisplayName: "Ling 3.0 Flash VL Free", ContextWindow: 262144, MaxTokens: 32768},
		"inclusionai/ling-3.0-flash-sante:free":              {ID: "inclusionai/ling-3.0-flash-sante:free", DisplayName: "Ling 3.0 Flash Sante Free", ContextWindow: 262144, MaxTokens: 32768},
		"inclusionai/ling-3.0-flash-fin:free":                {ID: "inclusionai/ling-3.0-flash-fin:free", DisplayName: "Ling 3.0 Flash Fin Free", ContextWindow: 262144, MaxTokens: 32768},
		"qwen/qwen3.8-27b:free":                              {ID: "qwen/qwen3.8-27b:free", DisplayName: "Qwen3.8 27B Free", ContextWindow: 262144, MaxTokens: 235929},
		"dots-studio/dots-3-note-preview:free":               {ID: "dots-studio/dots-3-note-preview:free", DisplayName: "Dots3 Note Preview Free", ContextWindow: 512000, MaxTokens: 460800},
		"liquid/lfm-2.5-2.6b:free":                           {ID: "liquid/lfm-2.5-2.6b:free", DisplayName: "LFM2.5 2.6B Free", ContextWindow: 65536, MaxTokens: 8192},
		"nvidia/nemotron-3.5-lightning:free":                 {ID: "nvidia/nemotron-3.5-lightning:free", DisplayName: "Nemotron 3.5 Lightning Free", ContextWindow: 1000000, MaxTokens: 65536},
		"thinkingmachines/inkling-small:free":                {ID: "thinkingmachines/inkling-small:free", DisplayName: "Inkling Small Free", ContextWindow: 1048576, MaxTokens: 262144},
		"thinkingmachines/inkling:free":                      {ID: "thinkingmachines/inkling:free", DisplayName: "Inkling Free", ContextWindow: 1048576, MaxTokens: 262144},
		"poolside/laguna-s-2.1:free":                         {ID: "poolside/laguna-s-2.1:free", DisplayName: "Laguna S 2.1 Free", ContextWindow: 262144, MaxTokens: 32768},
		"poolside/laguna-xs-2.1:free":                        {ID: "poolside/laguna-xs-2.1:free", DisplayName: "Laguna XS 2.1 Free", ContextWindow: 262144, MaxTokens: 32768},
		"nvidia/nemotron-3-ultra-550b-a55b:free":             {ID: "nvidia/nemotron-3-ultra-550b-a55b:free", DisplayName: "Nemotron 3 Ultra Free", ContextWindow: 1000000, MaxTokens: 65536},
		"nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free": {ID: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free", DisplayName: "Nemotron 3 Nano Omni Free", ContextWindow: 256000, MaxTokens: 65536},
		"google/gemma-4-26b-a4b-it:free":                     {ID: "google/gemma-4-26b-a4b-it:free", DisplayName: "Gemma 4 26B A4B Free", ContextWindow: 262144, MaxTokens: 32768},
		"google/gemma-4-31b-it:free":                         {ID: "google/gemma-4-31b-it:free", DisplayName: "Gemma 4 31B Free", ContextWindow: 262144, MaxTokens: 32768},
		"nvidia/nemotron-3-super-120b-a12b:free":             {ID: "nvidia/nemotron-3-super-120b-a12b:free", DisplayName: "Nemotron 3 Super Free", ContextWindow: 262144, MaxTokens: 235929},
	}
	openRouterAllowed := []string{
		"nex-agi/nex-n2.5-mini:free", "nex-agi/nex-n2.5-pro:free", "cohere/north-mini-code:free",
		"inclusionai/ling-3.0-flash-vl:free", "inclusionai/ling-3.0-flash-sante:free",
		"inclusionai/ling-3.0-flash-fin:free", "qwen/qwen3.8-27b:free",
		"dots-studio/dots-3-note-preview:free", "liquid/lfm-2.5-2.6b:free",
		"nvidia/nemotron-3.5-lightning:free", "thinkingmachines/inkling-small:free",
		"thinkingmachines/inkling:free", "poolside/laguna-s-2.1:free",
		"poolside/laguna-xs-2.1:free", "nvidia/nemotron-3-ultra-550b-a55b:free",
		"nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
		"google/gemma-4-26b-a4b-it:free", "google/gemma-4-31b-it:free",
		"nvidia/nemotron-3-super-120b-a12b:free",
	}

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
				DefaultModel:       "mimo-v2.5-free",
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
