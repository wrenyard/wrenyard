package llm

import "time"

// Provider is the minimal provider description needed for a single non-
// streaming LLM call. It carries only transport-relevant fields so the llm
// package does not import root config or auth types.
type Provider struct {
	// APIKind selects the transport (e.g. "anthropic").
	APIKind string `json:"api_kind"`
	// BaseURL is the complete provider URL and is used verbatim.
	BaseURL string `json:"base_url,omitempty"`
}

// Request is a single-turn, non-streaming LLM call request.
type Request struct {
	Model     string `json:"model"`
	Prompt    string `json:"prompt"`
	System    string `json:"system,omitempty"`
	MaxTokens int    `json:"max_tokens"`
	JSONMode  bool   `json:"json_mode,omitempty"`
}

// TransportOptions controls one Forge-managed LLM HTTP call. Zero values use
// the package defaults so existing callers keep their current timeout while
// gaining bounded transient retries.
type TransportOptions struct {
	Timeout      time.Duration
	MaxRetries   int
	RetryBackoff time.Duration
}

// Usage reports token accounting for a call.
type Usage struct {
	InputTokens  int `json:"input_tokens"`
	OutputTokens int `json:"output_tokens"`
}

// Result is the full result of a non-streaming LLM call.
type Result struct {
	Model string `json:"model"`
	Text  string `json:"text"`
	Usage *Usage `json:"usage,omitempty"`
}

// RawProtocol is a canonical raw LLM protocol selector, independent of the
// default text-inference protocol routing.
type RawProtocol string

const (
	// RawProtocolOpenAI selects the OpenAI Chat Completions raw protocol.
	RawProtocolOpenAI RawProtocol = "openai"
	// RawProtocolAnthropic selects the Anthropic Messages raw protocol.
	RawProtocolAnthropic RawProtocol = "anthropic"
)

// RawRequest is a native raw LLM protocol pass-through request. The body is
// passed through to the provider's native endpoint without modification.
type RawRequest struct {
	// Provider is the canonical provider id used to resolve credentials and
	// capability metadata.
	Provider string
	// Protocol is the canonical raw protocol selector.
	Protocol RawProtocol
	// Body is the raw JSON request body, passed through unchanged.
	Body []byte
}

// RawResult wraps the upstream raw response body, returned unchanged.
type RawResult struct {
	// Body is the upstream response body, returned unchanged.
	Body []byte
}
