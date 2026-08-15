package llm

import (
	"encoding/json"
	"fmt"
	"net/http"
)

// CallOpenAI performs a single OpenAI Chat Completions API call.
// Used for any provider with the openai-chat-completions protocol.
func CallOpenAI(binding ProviderBinding, modelName, apiKey string, req Request) (*Result, error) {
	return CallOpenAIWithOptions(binding, modelName, apiKey, req, DefaultTransportOptions(), nil)
}

// CallOpenAIWithOptions performs an OpenAI Chat Completions call with
// caller-selected transport timeout and retry behavior. extraHeaders are
// provider-specific context headers merged on top of standard headers. They
// are safely cloned and never appear in error messages.
func CallOpenAIWithOptions(binding ProviderBinding, modelName, apiKey string, req Request, opts TransportOptions, extraHeaders http.Header) (*Result, error) {
	url := binding.Endpoint

	var messages []map[string]string
	if req.System != "" {
		messages = append(messages, map[string]string{"role": "system", "content": req.System})
	}
	messages = append(messages, map[string]string{"role": "user", "content": req.Prompt})

	body := map[string]interface{}{
		"model":    modelName,
		"messages": messages,
	}

	if req.MaxTokens > 0 {
		body["max_tokens"] = req.MaxTokens
	}

	if req.JSONMode {
		body["response_format"] = map[string]string{"type": "json_object"}
	}

	bodyBytes, err := json.Marshal(body)
	if err != nil {
		return nil, fmt.Errorf("marshal request: %w", err)
	}

	headers := make(http.Header)
	headers.Set("Content-Type", "application/json")
	// Standard Authorization header using the resolved credential.
	headers.Set("Authorization", "Bearer "+apiKey)
	// Merge provider-specific extra context headers.
	// Extra headers override the standard Authorization when provided.
	if extraHeaders != nil {
		for k, v := range extraHeaders {
			headers[k] = v
		}
	}
	status, respBody, err := doJSONPost(url, headers, bodyBytes, opts)
	if err != nil {
		return nil, err
	}

	if status != http.StatusOK {
		return nil, fmt.Errorf("openai api error %d: %s", status, SanitizeErrorBody(respBody))
	}

	return parseOpenAIResponse(respBody, modelName)
}

func parseOpenAIResponse(body []byte, modelName string) (*Result, error) {
	var resp struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
		Usage struct {
			PromptTokens     int `json:"prompt_tokens"`
			CompletionTokens int `json:"completion_tokens"`
		} `json:"usage"`
	}
	if err := json.Unmarshal(body, &resp); err != nil {
		return nil, fmt.Errorf("parse response: %w", err)
	}

	if len(resp.Choices) == 0 {
		return nil, fmt.Errorf("no choices in response")
	}

	return &Result{
		Model: modelName,
		Text:  resp.Choices[0].Message.Content,
		Usage: &Usage{
			InputTokens:  resp.Usage.PromptTokens,
			OutputTokens: resp.Usage.CompletionTokens,
		},
	}, nil
}
