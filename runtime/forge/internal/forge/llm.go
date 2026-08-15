package forge

import (
	"fmt"
	"net/http"
	"os"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/providers/llm"
)

type llmRequest = llm.Request
type llmResult = llm.Result
type llmUsage = llm.Usage

func callLLM(model, prompt, system string, maxTokens int) (string, error) {
	return llm.CallText(llmCallDeps(), model, prompt, system, maxTokens)
}

func callLLMWithResult(req llmRequest) (*llmResult, error) {
	return llm.Call(llmCallDeps(), req)
}

func llmCommand(args []string) int {
	cfg, _, err := LoadForgeConfig()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	if _, err := catalogRegistryForConfig(cfg); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	deps := llm.CommandDeps{
		CallLLMWithResult:     callLLMWithResult,
		CallLLMWithOptions:    callLLMWithOptions,
		CallRawLLM:            callRawLLM,
		CallRawLLMWithOptions: callRawLLMWithOptions,
		ConfigModel:           cfg.LLMModel,
		ConfigProtocol:        cfg.LLMProtocol,
		Stdin:                 os.Stdin,
	}
	return llm.Command(deps, args)
}

func llmCallDeps() llm.CallDeps {
	reg := catalogRegistryOrDefault()
	return llm.CallDeps{
		ResolveBinding: func(providerID string) (llm.ProviderBinding, error) {
			binding, err := reg.LookupBinding(providerID)
			if err != nil {
				return llm.ProviderBinding{}, err
			}
			if binding.Inference == nil {
				return llm.ProviderBinding{}, &bindingNotFoundError{providerID}
			}
			return llm.ProviderBinding{
				Protocol: binding.Inference.Protocol,
				Endpoint: binding.Inference.Endpoint,
			}, nil
		},
		ResolveCredential: authStatusCredential,
		ResolveHeaders:    authStatusHeaders,
		ResolveRawCapability: func(providerID string, protocol llm.RawProtocol) (llm.RawProviderBinding, error) {
			binding, err := reg.LookupBinding(providerID)
			if err != nil {
				return llm.RawProviderBinding{}, err
			}
			for _, c := range binding.RawLLM {
				if llm.RawProtocol(c.Protocol) == protocol {
					return llm.RawProviderBinding{Endpoint: c.BaseEndpoint, Protocol: protocol}, nil
				}
			}
			return llm.RawProviderBinding{}, fmt.Errorf("provider %q does not advertise raw %q protocol", providerID, protocol)
		},
	}
}

// authStatusHeaders resolves the full headers (Authorization + context) for a
// provider using the unified auth SSOT.
func authStatusHeaders(providerID string) (http.Header, bool) {
	if IsManagedProvider(providerID) {
		credential, ok := ResolveCredential(providerID)
		if !ok {
			return nil, false
		}
		headers := make(http.Header)
		headers.Set("Authorization", "Bearer "+credential)
		return headers, true
	}
	resolver := authStatusResolver()
	headers := resolver.Headers(providerID)
	if headers == nil {
		return nil, false
	}
	return headers, true
}

// callRawLLM performs a native raw LLM protocol pass-through using the catalog
// capability metadata and existing credential resolution (no second transport
// stack).
func callRawLLM(providerID string, protocol llm.RawProtocol, body []byte) (*llm.RawResult, error) {
	return llm.CallRaw(llmCallDeps(), providerID, protocol, body)
}

func callLLMWithOptions(req llmRequest, opts llm.TransportOptions) (*llmResult, error) {
	return llm.CallWithOptions(llmCallDeps(), req, opts)
}

func callRawLLMWithOptions(providerID string, protocol llm.RawProtocol, body []byte, opts llm.TransportOptions) (*llm.RawResult, error) {
	return llm.CallRawWithOptions(llmCallDeps(), providerID, protocol, body, opts)
}

type bindingNotFoundError struct {
	providerID string
}

func (e *bindingNotFoundError) Error() string {
	return "no inference binding for provider " + e.providerID
}
