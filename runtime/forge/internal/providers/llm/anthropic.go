package llm

import (
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"
	"strings"
)

// ParseProviderModel splits "provider/model" into (provider, model).
func ParseProviderModel(composite string) (providerID, modelName string, err error) {
	parts := strings.SplitN(composite, "/", 2)
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return "", "", fmt.Errorf("invalid model %q; expected provider/model format", composite)
	}
	return parts[0], parts[1], nil
}

// CallAnthropic performs a single Anthropic Messages API call.
func CallAnthropic(provider Provider, modelName, apiKey string, req Request) (*Result, error) {
	return CallAnthropicWithOptions(provider, modelName, apiKey, req, DefaultTransportOptions())
}

// CallAnthropicWithOptions performs an Anthropic Messages API call with
// caller-selected transport timeout and retry behavior.
func CallAnthropicWithOptions(provider Provider, modelName, apiKey string, req Request, opts TransportOptions) (*Result, error) {
	url := provider.BaseURL

	messages := []map[string]interface{}{
		{"role": "user", "content": req.Prompt},
	}

	body := map[string]interface{}{
		"model":      modelName,
		"max_tokens": req.MaxTokens,
		"messages":   messages,
	}
	if req.System != "" {
		body["system"] = req.System
	}

	bodyBytes, err := json.Marshal(body)
	if err != nil {
		return nil, fmt.Errorf("marshal request: %w", err)
	}

	headers := make(http.Header)
	headers.Set("Content-Type", "application/json")
	headers.Set("x-api-key", apiKey)
	headers.Set("anthropic-version", "2023-06-01")
	status, respBody, err := doJSONPost(url, headers, bodyBytes, opts)
	if err != nil {
		return nil, err
	}

	if status != http.StatusOK {
		return nil, fmt.Errorf("anthropic api error %d: %s", status, SanitizeErrorBody(respBody))
	}

	return ParseAnthropicResponse(respBody, modelName)
}

// ParseAnthropicResponse parses an Anthropic Messages API response body.
func ParseAnthropicResponse(body []byte, modelName string) (*Result, error) {
	var resp struct {
		Content []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
		Usage struct {
			InputTokens  int `json:"input_tokens"`
			OutputTokens int `json:"output_tokens"`
		} `json:"usage"`
	}
	if err := json.Unmarshal(body, &resp); err != nil {
		return nil, fmt.Errorf("parse response: %w", err)
	}

	var text string
	for _, block := range resp.Content {
		if block.Type == "text" {
			text += block.Text
		}
	}

	return &Result{
		Model: modelName,
		Text:  text,
		Usage: &Usage{
			InputTokens:  resp.Usage.InputTokens,
			OutputTokens: resp.Usage.OutputTokens,
		},
	}, nil
}

// SanitizeErrorBody produces a safe error snippet from an upstream error
// response body. It parses JSON and recursively sanitizes objects/arrays,
// replacing sensitive field values (credentials, tokens, context headers)
// with a redacted placeholder. Non-JSON bodies are replaced with a fixed
// generic placeholder to prevent accidental credential exposure.
func SanitizeErrorBody(raw []byte) string {
	var v interface{}
	if err := json.Unmarshal(raw, &v); err != nil {
		return "[REDACTED-UPSTREAM-BODY]"
	}

	sanitized := sanitizeJSONValue(v, 0)
	sanitizedBytes, err := json.Marshal(sanitized)
	if err != nil {
		return "[REDACTED-UPSTREAM-BODY]"
	}

	return string(sanitizedBytes)
}

var sensitiveKeyPrefixes = []string{
	"authorization", "apikey", "token", "accesstoken",
	"password", "secret",
	"xdomain", "xenterpriseid", "xtenantid",
	"xuserid", "xdepartmentinfo", "xproduct",
	"xrequestedwith", "cookie", "session",
}

var keyNormalizer = strings.NewReplacer(
	"-", "",
	"_", "",
	" ", "",
	".", "",
)

// isSensitiveKey reports whether a map key should be treated as sensitive.
// Comparison is case-insensitive and delimiter-agnostic: the key is lowered
// and stripped of hyphens, underscores, spaces, and dots, then checked
// against known compact sensitive markers.
func isSensitiveKey(key string) bool {
	normalized := keyNormalizer.Replace(strings.ToLower(key))
	for _, prefix := range sensitiveKeyPrefixes {
		if strings.Contains(normalized, prefix) {
			return true
		}
	}
	return false
}

// sanitizeJSONValue recursively sanitizes a parsed JSON value. It replaces
// sensitive map values, string array elements, and root-level scalar strings
// with a redaction placeholder. Non-sensitive object string values are
// preserved but run through RedactAuthPatterns.
func sanitizeJSONValue(v interface{}, depth int) interface{} {
	switch val := v.(type) {
	case map[string]interface{}:
		result := make(map[string]interface{}, len(val))
		for k, child := range val {
			if isSensitiveKey(k) {
				result[k] = "[REDACTED]"
			} else {
				result[k] = sanitizeJSONValue(child, depth+1)
			}
		}
		return result
	case []interface{}:
		result := make([]interface{}, len(val))
		for i, child := range val {
			if _, ok := child.(string); ok {
				result[i] = "[REDACTED]"
			} else {
				result[i] = sanitizeJSONValue(child, depth+1)
			}
		}
		return result
	case string:
		if depth == 0 {
			return "[REDACTED]"
		}
		return RedactAuthPatterns(val)
	default:
		return v
	}
}

var (
	// reAuthKey matches auth-related keys in both header-style (key: value) and
	// JSON-style ("key":"value") formats.
	reAuthKey = regexp.MustCompile(`(?i)(x-api-key|x_api_key|api-key|api_key|apikey|authorization|bearer|access-token|access_token|accesstoken|token)[\":=\s]+([^",'}\]]+)`)
	// reBase64Long matches base64-like strings of 40+ characters.
	reBase64Long = regexp.MustCompile(`[A-Za-z0-9+/=]{40,}`)
)

// RedactAuthPatterns removes sensitive patterns from a string.
func RedactAuthPatterns(s string) string {
	s = reAuthKey.ReplaceAllString(s, `${1}: [REDACTED]`)
	s = reBase64Long.ReplaceAllString(s, `[BASE64_REDACTED]`)
	return s
}
