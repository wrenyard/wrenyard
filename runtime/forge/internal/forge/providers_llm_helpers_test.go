package forge

import (
	"time"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/providers/llm"
)

const llmTimeout = 20 * time.Second
const llmDefaultMaxTokens = 1024
const llmMaxResponseBytes = 4 * 1024 * 1024

func parseProviderModel(composite string) (providerID, modelName string, err error) {
	return llm.ParseProviderModel(composite)
}

func callAnthropic(p llm.Provider, modelName, apiKey string, req llmRequest) (*llmResult, error) {
	return llm.CallAnthropic(p, modelName, apiKey, req)
}

func parseAnthropicResponse(body []byte, modelName string) (*llmResult, error) {
	return llm.ParseAnthropicResponse(body, modelName)
}

func sanitizeErrorBody(raw []byte) string {
	return llm.SanitizeErrorBody(raw)
}

func redactAuthPatterns(s string) string {
	return llm.RedactAuthPatterns(s)
}
