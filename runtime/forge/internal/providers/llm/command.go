package llm

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
	"time"
)

const defaultProtocol = "openai"

// CommandDeps bundles explicit dependencies for the llm command.
type CommandDeps struct {
	CallLLMWithResult func(req Request) (*Result, error)
	// CallLLMWithOptions performs a text call with explicit transport options.
	// When nil, Command falls back to CallLLMWithResult for compatibility.
	CallLLMWithOptions func(req Request, opts TransportOptions) (*Result, error)
	// CallRawLLM performs a native raw LLM protocol pass-through. May be nil
	// if raw calls are unavailable in the host wiring.
	CallRawLLM func(providerID string, protocol RawProtocol, body []byte) (*RawResult, error)
	// CallRawLLMWithOptions performs a raw call with explicit transport
	// options. When nil, Command falls back to CallRawLLM for compatibility.
	CallRawLLMWithOptions func(providerID string, protocol RawProtocol, body []byte, opts TransportOptions) (*RawResult, error)
	// ConfigModel is the config default for llm_model (provider/model).
	ConfigModel string
	// ConfigProtocol is the config default for llm_protocol.
	ConfigProtocol string
	Stdin          interface{ Read([]byte) (int, error) }
}

// Command dispatches the "forge llm" command.
// Usage: forge llm <text|request_body> [-m <provider/model>] [--protocol <openai|anthropic>]
//
//	[--timeout-ms <milliseconds>] [--max-retries <count>]
//	[--retry-backoff-ms <milliseconds>]
//	[--stdin] Read raw request body from stdin (replaces positional input)
func Command(deps CommandDeps, args []string) int {
	var model string
	var protocol string
	var text []string
	var stdinFlag bool
	transport := DefaultTransportOptions()

	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "--model", "-m":
			if i+1 >= len(args) {
				fmt.Fprintln(os.Stderr, "forge llm: --model requires a value")
				return 2
			}
			model = args[i+1]
			i++
		case "--protocol":
			if i+1 >= len(args) {
				fmt.Fprintln(os.Stderr, "forge llm: --protocol requires a value")
				return 2
			}
			protocol = args[i+1]
			i++
		case "--timeout-ms":
			value, next, ok := parseNonNegativeInt64Flag(args, i, "--timeout-ms", false)
			if !ok {
				return 2
			}
			transport.Timeout = time.Duration(value) * time.Millisecond
			i = next
		case "--max-retries":
			value, next, ok := parseNonNegativeInt64Flag(args, i, "--max-retries", true)
			if !ok {
				return 2
			}
			transport.MaxRetries = int(value)
			i = next
		case "--retry-backoff-ms":
			value, next, ok := parseNonNegativeInt64Flag(args, i, "--retry-backoff-ms", false)
			if !ok {
				return 2
			}
			transport.RetryBackoff = time.Duration(value) * time.Millisecond
			i = next
		case "--stdin":
			stdinFlag = true
		default:
			if strings.HasPrefix(args[i], "-") && args[i] != "-" {
				fmt.Fprintf(os.Stderr, "forge llm: unknown flag %s\n", args[i])
				return 2
			}
			text = append(text, args[i])
		}
	}

	var prompt string
	if stdinFlag {
		if len(text) > 0 {
			fmt.Fprintln(os.Stderr, "forge llm: --stdin cannot be combined with positional input")
			return 2
		}
		if deps.Stdin == nil {
			fmt.Fprintln(os.Stderr, "forge llm: --stdin requires a readable stdin (not available)")
			return 2
		}
		stdinBody, err := io.ReadAll(deps.Stdin)
		if err != nil {
			fmt.Fprintf(os.Stderr, "forge llm: failed to read stdin: %v\n", err)
			return 2
		}
		prompt = strings.TrimSpace(string(stdinBody))
		if prompt == "" {
			fmt.Fprintln(os.Stderr, "forge llm: --stdin input was empty")
			return 2
		}
	} else {
		prompt = strings.TrimSpace(strings.Join(text, " "))
		if prompt == "" {
			fmt.Fprintln(os.Stderr, "forge llm: text or request body is required")
			return 2
		}
	}

	// Model precedence: CLI flag > config; otherwise fail loudly with usage.
	if model == "" {
		model = deps.ConfigModel
	}
	if model == "" {
		fmt.Fprintln(os.Stderr, "forge llm: a provider/model is required; pass -m <provider/model> or set llm_model in config")
		return 2
	}

	// Detect raw JSON object request body; otherwise treat as text.
	if isJSONObject(prompt) {
		return runRaw(deps, model, protocol, []byte(prompt), transport)
	}

	req := Request{
		Model:     model,
		Prompt:    prompt,
		MaxTokens: 1024,
	}
	var result *Result
	var err error
	if deps.CallLLMWithOptions != nil {
		result, err = deps.CallLLMWithOptions(req, transport)
	} else if deps.CallLLMWithResult != nil {
		result, err = deps.CallLLMWithResult(req)
	} else {
		err = fmt.Errorf("text calls are not available")
	}
	if err != nil {
		fmt.Fprintf(os.Stderr, "forge llm: %v\n", err)
		return 1
	}

	fmt.Print(result.Text)
	if len(result.Text) > 0 && result.Text[len(result.Text)-1] != '\n' {
		fmt.Println()
	}

	return 0
}

func runRaw(deps CommandDeps, model, protocol string, body []byte, transport TransportOptions) int {
	if deps.CallRawLLMWithOptions == nil && deps.CallRawLLM == nil {
		fmt.Fprintln(os.Stderr, "forge llm: raw calls are not available")
		return 1
	}

	// B5: ParseProviderModel yields providerID and upstream modelID.
	encodedProviderID, upstreamModel, err := ParseProviderModel(model)
	if err != nil {
		fmt.Fprintf(os.Stderr, "forge llm: invalid -m %q; expected provider/model: %v\n", model, err)
		return 2
	}
	// TrimSpace is explicitly allowed at the CLI boundary.
	encodedProviderID = strings.TrimSpace(encodedProviderID)
	upstreamModel = strings.TrimSpace(upstreamModel)

	// Decode the valid JSON object body, replace body.model with modelID,
	// re-encode, and pass composite provider separately for routing.
	var requestBody map[string]interface{}
	if err := json.Unmarshal(body, &requestBody); err != nil {
		fmt.Fprintf(os.Stderr, "forge llm: invalid JSON request body: %v\n", err)
		return 2
	}
	if upstreamModel == "" {
		fmt.Fprintln(os.Stderr, "forge llm: empty model in -m provider/model")
		return 2
	}
	requestBody["model"] = upstreamModel
	updatedBody, err := json.Marshal(requestBody)
	if err != nil {
		fmt.Fprintf(os.Stderr, "forge llm: failed to encode request body: %v\n", err)
		return 2
	}

	// Protocol precedence: CLI flag > config > default.
	if protocol == "" {
		protocol = deps.ConfigProtocol
	}
	if protocol == "" {
		protocol = defaultProtocol
	}
	rp := RawProtocol(protocol)
	if rp != RawProtocolOpenAI && rp != RawProtocolAnthropic {
		fmt.Fprintf(os.Stderr, "forge llm: unsupported --protocol %q (want openai or anthropic)\n", protocol)
		return 2
	}

	var result *RawResult
	if deps.CallRawLLMWithOptions != nil {
		result, err = deps.CallRawLLMWithOptions(encodedProviderID, rp, updatedBody, transport)
	} else {
		result, err = deps.CallRawLLM(encodedProviderID, rp, updatedBody)
	}
	if err != nil {
		fmt.Fprintf(os.Stderr, "forge llm: %v\n", err)
		return 1
	}

	// Return response bytes unchanged.
	if len(result.Body) > 0 {
		os.Stdout.Write(result.Body)
	} else {
		fmt.Println()
	}
	return 0
}

func parseNonNegativeInt64Flag(args []string, index int, name string, allowZero bool) (int64, int, bool) {
	if index+1 >= len(args) {
		fmt.Fprintf(os.Stderr, "forge llm: %s requires a value\n", name)
		return 0, index, false
	}
	value, err := strconv.ParseInt(args[index+1], 10, 32)
	if err != nil || value < 0 || (!allowZero && value == 0) {
		requirement := "a positive integer"
		if allowZero {
			requirement = "a non-negative integer"
		}
		fmt.Fprintf(os.Stderr, "forge llm: %s requires %s\n", name, requirement)
		return 0, index, false
	}
	return value, index + 1, true
}

// isJSONObject reports whether s is a valid JSON object (not array/scalar).
func isJSONObject(s string) bool {
	s = strings.TrimSpace(s)
	if !strings.HasPrefix(s, "{") {
		return false
	}
	var probe map[string]interface{}
	if err := json.Unmarshal([]byte(s), &probe); err != nil {
		return false
	}
	return true
}
