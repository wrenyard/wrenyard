package llm

import (
	"fmt"
	"net/http"
)

// RawProviderBinding is the resolved raw capability for a provider/protocol,
// produced by a capability resolver from catalog metadata.
type RawProviderBinding struct {
	// Endpoint is the complete endpoint and is used verbatim.
	Endpoint string
	// Protocol is the canonical raw protocol.
	Protocol RawProtocol
}

// RawDeps carries the minimal callbacks needed for a raw pass-through call.
type RawDeps struct {
	// ResolveRawBinding returns the raw capability binding for a provider and
	// canonical protocol, or an error when the combination is not advertised.
	ResolveRawBinding func(providerID string, protocol RawProtocol) (RawProviderBinding, error)
	// ResolveCredential returns the credential for a provider.
	ResolveCredential func(providerID string) (string, bool)
	// ResolveHeaders returns the context headers (Authorization + account
	// context) for a provider, or nil/false if unavailable.
	ResolveHeaders func(providerID string) (http.Header, bool)
}

func rawAuthHeader(p RawProtocol) (name, prefix string) {
	switch p {
	case RawProtocolOpenAI:
		return "Authorization", "Bearer "
	case RawProtocolAnthropic:
		return "x-api-key", ""
	default:
		return "Authorization", "Bearer "
	}
}

// callRawImpl performs a native raw LLM protocol pass-through of req.Body to
// the provider's native endpoint. The body is NOT unmarshalled/remarshalled
// and no fields are injected or changed. The upstream response body is returned
// unchanged. Unsupported provider/protocol combinations fail clearly.
func callRawImpl(deps RawDeps, req RawRequest) (*RawResult, error) {
	return callRawImplWithOptions(deps, req, DefaultTransportOptions())
}

func callRawImplWithOptions(deps RawDeps, req RawRequest, opts TransportOptions) (*RawResult, error) {
	if req.Provider == "" {
		return nil, fmt.Errorf("raw call: provider is required")
	}
	if req.Protocol == "" {
		return nil, fmt.Errorf("raw call: protocol is required")
	}

	// Codex native providers have no verified direct inference endpoint.
	if req.Provider == "codex" || req.Provider == "codex-spark" {
		return nil, fmt.Errorf("provider %q supports native profile login but does not support direct LLM transport", req.Provider)
	}

	binding, err := deps.ResolveRawBinding(req.Provider, req.Protocol)
	if err != nil {
		return nil, err
	}
	cred, ok := deps.ResolveCredential(req.Provider)
	if !ok || cred == "" {
		return nil, fmt.Errorf("no credential for provider %q", req.Provider)
	}

	url := binding.Endpoint

	headers := make(http.Header)
	headers.Set("Content-Type", "application/json")

	// Preserve provider-specific context headers, then make sure the selected
	// raw protocol's canonical credential header is present.
	if deps.ResolveHeaders != nil {
		if authHeaders, ok := deps.ResolveHeaders(req.Provider); ok {
			for k, v := range authHeaders {
				headers[k] = v
			}
		}
	}
	headerName, prefix := rawAuthHeader(req.Protocol)
	if headers.Get(headerName) == "" {
		headers.Set(headerName, prefix+cred)
	}
	status, respBody, err := doJSONPost(url, headers, req.Body, opts)
	if err != nil {
		return nil, fmt.Errorf("raw call: %w", err)
	}

	if status != http.StatusOK {
		return nil, fmt.Errorf("raw call: upstream error %d: %s", status, SanitizeErrorBody(respBody))
	}

	return &RawResult{Body: respBody}, nil
}
