package catalog

import "github.com/wrenyard/wrenyard/runtime/forge/internal/providers/schema"

type InferenceBinding = schema.InferenceBinding
type CredentialResolver = schema.CredentialResolver
type AuthScheme = schema.AuthScheme

const (
	CredentialResolverForgeManaged = schema.CredentialResolverForgeManaged
	CredentialResolverCodeBuddy    = schema.CredentialResolverCodeBuddy
	CredentialResolverCodex        = schema.CredentialResolverCodex
	CredentialResolverClaude       = schema.CredentialResolverClaude
	CredentialResolverGrokOAuth    = schema.CredentialResolverGrokOAuth
	CredentialResolverCursor       = schema.CredentialResolverCursor
)

const (
	AuthSchemeBearer = schema.AuthSchemeBearer
	AuthSchemeAPIKey = schema.AuthSchemeAPIKey
)

type ModelDef = schema.ModelDef
type RawLLMProtocol = schema.RawLLMProtocol

const (
	RawLLMProtocolOpenAI    = schema.RawLLMProtocolOpenAI
	RawLLMProtocolAnthropic = schema.RawLLMProtocolAnthropic
)

type RawLLMCapability = schema.RawLLMCapability
type ProviderModels = schema.ProviderModels
