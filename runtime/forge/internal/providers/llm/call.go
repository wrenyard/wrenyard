package llm

import (
	"fmt"
	"net/http"
)

// CallDeps bundles the catalog and auth callbacks for LLM inference routing.
type CallDeps struct {
	ResolveBinding       func(providerID string) (ProviderBinding, error)
	ResolveCredential    func(providerID string) (string, bool)
	ResolveHeaders       func(providerID string) (http.Header, bool)
	ResolveRawCapability func(providerID string, protocol RawProtocol) (RawProviderBinding, error)
}

// ProviderBinding describes a provider's inference capability as resolved
// from the catalog registry.
type ProviderBinding struct {
	Protocol string
	Endpoint string
}

// CallText performs a single-turn LLM call returning just the text.
func CallText(deps CallDeps, model, prompt, system string, maxTokens int) (string, error) {
	if maxTokens <= 0 {
		maxTokens = 1024
	}
	result, err := Call(deps, Request{Model: model, Prompt: prompt, System: system, MaxTokens: maxTokens})
	if err != nil {
		return "", err
	}
	return result.Text, nil
}

// Call routes a single-turn LLM call through the catalog provider's inference binding.
func Call(deps CallDeps, req Request) (*Result, error) {
	return CallWithOptions(deps, req, DefaultTransportOptions())
}

// CallWithOptions routes a single-turn LLM call with explicit transport
// timeout and bounded transient retry behavior.
func CallWithOptions(deps CallDeps, req Request, opts TransportOptions) (*Result, error) {
	providerID, modelName, err := ParseProviderModel(req.Model)
	if err != nil {
		return nil, err
	}

	// Reject unsupported direct transport for Codex native providers.
	// Native profile login can be valid while direct transport is unsupported.
	if providerID == "codex" || providerID == "codex-spark" {
		return nil, fmt.Errorf("provider %q supports native profile login but does not support direct LLM transport", providerID)
	}

	binding, err := deps.ResolveBinding(providerID)
	if err != nil {
		return nil, fmt.Errorf("unknown provider %q", providerID)
	}

	// Resolve credential and headers from the auth SSOT.
	cred, ok := deps.ResolveCredential(providerID)
	if !ok || cred == "" {
		return nil, fmt.Errorf("no credential for provider %q", providerID)
	}

	// Get provider-specific context headers if available.
	var extraHeaders http.Header
	if deps.ResolveHeaders != nil {
		extraHeaders, _ = deps.ResolveHeaders(providerID)
	}

	switch binding.Protocol {
	case "openai-chat-completions":
		return CallOpenAIWithOptions(binding, modelName, cred, req, opts, extraHeaders)
	case "anthropic-messages":
		return CallAnthropicWithOptions(Provider{APIKind: "anthropic", BaseURL: binding.Endpoint}, modelName, cred, req, opts)
	default:
		return nil, fmt.Errorf("unsupported protocol %q for provider %q", binding.Protocol, providerID)
	}
}

// CallRaw performs a native raw LLM protocol pass-through for the given
// provider, protocol, and body. It resolves capability metadata and credentials
// through the existing deps, then delegates to the raw pass-through
// implementation. The body is passed through unchanged.
func CallRaw(deps CallDeps, providerID string, protocol RawProtocol, body []byte) (*RawResult, error) {
	return CallRawWithOptions(deps, providerID, protocol, body, DefaultTransportOptions())
}

// CallRawWithOptions performs a native raw LLM protocol pass-through with
// explicit transport timeout and bounded transient retry behavior.
func CallRawWithOptions(deps CallDeps, providerID string, protocol RawProtocol, body []byte, opts TransportOptions) (*RawResult, error) {
	if deps.ResolveRawCapability == nil {
		return nil, fmt.Errorf("raw capability resolver not configured")
	}
	if deps.ResolveCredential == nil {
		return nil, fmt.Errorf("credential resolver not configured")
	}

	// Codex native providers have no verified direct inference endpoint.
	if providerID == "codex" || providerID == "codex-spark" {
		return nil, fmt.Errorf("provider %q supports native profile login but does not support direct LLM transport", providerID)
	}

	return callRawImplWithOptions(RawDeps{
		ResolveRawBinding: deps.ResolveRawCapability,
		ResolveCredential: deps.ResolveCredential,
		ResolveHeaders:    deps.ResolveHeaders,
	}, RawRequest{Provider: providerID, Protocol: protocol, Body: body}, opts)
}
