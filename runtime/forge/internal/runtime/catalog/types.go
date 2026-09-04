package catalog

import "github.com/wrenyard/wrenyard/runtime/forge/internal/providers/schema"

type InferenceBinding = schema.InferenceBinding
type CredentialResolver = schema.CredentialResolver
type AuthScheme = schema.AuthScheme
type GatewayProtocol = schema.GatewayProtocol

const (
	CredentialResolverForgeManaged = schema.CredentialResolverForgeManaged
	CredentialResolverCodeBuddy    = schema.CredentialResolverCodeBuddy
	CredentialResolverCodex        = schema.CredentialResolverCodex
	CredentialResolverClaude       = schema.CredentialResolverClaude
	CredentialResolverGrokOAuth    = schema.CredentialResolverGrokOAuth
	CredentialResolverCursor       = schema.CredentialResolverCursor
)

const (
	GatewayProtocolOpenAIChat      = schema.GatewayProtocolOpenAIChat
	GatewayProtocolOpenAIResponses = schema.GatewayProtocolOpenAIResponses
	GatewayProtocolAnthropic       = schema.GatewayProtocolAnthropic
)

const (
	AuthSchemeBearer = schema.AuthSchemeBearer
	AuthSchemeAPIKey = schema.AuthSchemeAPIKey
)

type ModelDef = schema.ModelDef
type ProviderModels = schema.ProviderModels
