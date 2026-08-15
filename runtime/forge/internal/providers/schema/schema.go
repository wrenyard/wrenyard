// Package schema defines the dependency-neutral provider module contract.
// Vendor modules depend on this package; catalog consumes the modules through
// Registrar, so neither side needs to import the other.
package schema

import (
	"fmt"
	"sort"
	"strings"
)

// Dialect describes the client protocol dialect a provider can serve.
type Dialect string

const (
	DialectClaudeCode Dialect = "claude-code"
	DialectCodeBuddy  Dialect = "codebuddy"
	DialectCodex      Dialect = "codex"
	DialectOpenCode   Dialect = "opencode"
	DialectGrok       Dialect = "grok"
	DialectDSH        Dialect = "dsh"
)

// CredentialResolver identifies the provider credential source.
type CredentialResolver string

const (
	CredentialResolverForgeManaged CredentialResolver = "forge-managed"
	CredentialResolverCodeBuddy    CredentialResolver = "codebuddy"
	CredentialResolverCodex        CredentialResolver = "codex"
	CredentialResolverClaude       CredentialResolver = "claude"
	CredentialResolverGrokOAuth    CredentialResolver = "grok-oauth"
)

// InferenceBinding describes the default text-inference transport.
type InferenceBinding struct {
	Protocol           string             `json:"protocol"`
	Endpoint           string             `json:"endpoint"`
	CredentialResolver CredentialResolver `json:"credential_resolver"`
}

// RawLLMProtocol is a canonical raw protocol exposed by a provider.
type RawLLMProtocol string

const (
	RawLLMProtocolOpenAI    RawLLMProtocol = "openai"
	RawLLMProtocolAnthropic RawLLMProtocol = "anthropic"
)

// RawLLMCapability is a protocol-specific full base URL. Consumers receive
// this value verbatim and must not add protocol-version or method path parts.
type RawLLMCapability struct {
	Protocol     RawLLMProtocol `json:"protocol"`
	BaseEndpoint string         `json:"base_endpoint"`
}

// Provider describes one provider binding.
type Provider struct {
	Name               string             `json:"name"`
	Kind               string             `json:"kind"`
	Env                map[string]string  `json:"env,omitempty"`
	CompatibleDialects []Dialect          `json:"compatible_dialects,omitempty"`
	QuotaProvider      string             `json:"quota_provider"`
	SecretResolution   string             `json:"secret_resolution"`
	AllowedModels      []string           `json:"allowed_models,omitempty"`
	CredentialResolver CredentialResolver `json:"credential_resolver,omitempty"`
	Inference          *InferenceBinding  `json:"inference,omitempty"`
	RawLLM             []RawLLMCapability `json:"raw_llm,omitempty"`
	DefaultModel       string             `json:"default_model,omitempty"`
	UseClientBinary    bool               `json:"-"`
}

func (p Provider) UsesClientBinary() bool { return p.UseClientBinary }

// CredentialSource returns the provider's credential resolver, preferring the
// top-level CredentialResolver (independent of inference transport) and
// falling back to the legacy Inference binding resolver for compatibility.
func (p Provider) CredentialSource() CredentialResolver {
	if p.CredentialResolver != "" {
		return p.CredentialResolver
	}
	if p.Inference != nil {
		return p.Inference.CredentialResolver
	}
	return ""
}

func (p Provider) ValidateModel(model string) error {
	if len(p.AllowedModels) == 0 {
		return nil
	}
	for _, allowed := range p.AllowedModels {
		if allowed == model {
			return nil
		}
	}
	return fmt.Errorf("model %q is not allowed for provider binding %q; allowed models: %s",
		model, p.Name, strings.Join(p.AllowedModels, ", "))
}

func (p Provider) SupportsDialect(d Dialect) bool {
	for _, compatible := range p.CompatibleDialects {
		if compatible == d {
			return true
		}
	}
	return false
}

func (p Provider) DialectList() string {
	names := make([]string, len(p.CompatibleDialects))
	for i, d := range p.CompatibleDialects {
		names[i] = string(d)
	}
	sort.Strings(names)
	return strings.Join(names, ", ")
}

func (p Provider) RawCapability(protocol RawLLMProtocol) (RawLLMCapability, bool) {
	for _, capability := range p.RawLLM {
		if capability.Protocol == protocol {
			return capability, true
		}
	}
	return RawLLMCapability{}, false
}

// ModelDef is provider-owned model metadata.
type ModelDef struct {
	ID            string `json:"id"`
	DisplayName   string `json:"display_name,omitempty"`
	ContextWindow int    `json:"context_window,omitempty"`
}

type ProviderModels map[string]ModelDef

// AuthMetadata describes whether Forge exposes API-key login for the module.
type AuthMetadata struct {
	Login bool `json:"login"`
}

// QuotaMetadata selects a shared quota implementation without keying framework
// code on provider IDs. Empty Kind means the provider has no quota surface.
type QuotaMetadata struct {
	Kind string `json:"kind,omitempty"`
	Name string `json:"name,omitempty"`
}

// ProviderModule is the complete source of truth for one built-in provider.
type ProviderModule interface {
	ID() string
	Binding() Provider
	Models() ProviderModels
	Auth() AuthMetadata
	Quota() QuotaMetadata
}

// StaticModule is the compact implementation used by built-in vendor modules.
type StaticModule struct {
	ProviderID string
	Provider   Provider
	ModelSet   ProviderModels
	AuthInfo   AuthMetadata
	QuotaInfo  QuotaMetadata
}

func (m StaticModule) ID() string             { return m.ProviderID }
func (m StaticModule) Binding() Provider      { return m.Provider }
func (m StaticModule) Models() ProviderModels { return m.ModelSet }
func (m StaticModule) Auth() AuthMetadata     { return m.AuthInfo }
func (m StaticModule) Quota() QuotaMetadata   { return m.QuotaInfo }

// Registrar is implemented by catalog.Registry.
type Registrar interface {
	RegisterBinding(Provider)
	RegisterModels(string, ProviderModels)
}
