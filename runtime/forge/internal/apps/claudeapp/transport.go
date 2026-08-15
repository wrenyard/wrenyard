package claudeapp

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
)

func (p *Proxy) handleMessages(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "invalid_request_error", "messages endpoint requires POST")
		return
	}
	body, err := io.ReadAll(r.Body)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request_error", err.Error())
		return
	}
	payload := map[string]interface{}{}
	if err := json.Unmarshal(body, &payload); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request_error", "invalid JSON body")
		return
	}
	routeModel, _ := payload["model"].(string)
	mappedModel := routeModel
	if model, ok := payload["model"].(string); ok {
		mappedModel = p.mapModel(model)
		payload["model"] = mappedModel
	}
	stream, _ := payload["stream"].(bool)
	logRequest("POST %s stream=%v model=%s -> %s", r.URL.Path, stream, emptyModel(routeModel), emptyModel(mappedModel))
	outboundBody, err := json.Marshal(payload)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request_error", err.Error())
		return
	}
	upstreamURL := buildUpstreamURL(p.cfg.UpstreamBaseURL)
	upstreamReq, err := http.NewRequestWithContext(r.Context(), http.MethodPost, upstreamURL, bytes.NewReader(outboundBody))
	if err != nil {
		writeError(w, http.StatusBadGateway, "api_error", err.Error())
		return
	}
	upstreamReq.Header.Set("Content-Type", "application/json")
	if stream {
		upstreamReq.Header.Set("Accept", "text/event-stream")
	} else {
		upstreamReq.Header.Set("Accept", "application/json")
	}
	upstreamReq.Header.Set("anthropic-version", firstNonEmpty(r.Header.Get("anthropic-version"), "2023-06-01"))
	if beta := r.Header.Get("anthropic-beta"); beta != "" {
		upstreamReq.Header.Set("anthropic-beta", beta)
	}
	upstreamReq.Header.Set("Authorization", "Bearer "+p.cfg.UpstreamToken)
	upstreamReq.Header.Set("User-Agent", "forge-claude-app-gateway/1")

	resp, err := p.client.Do(upstreamReq)
	if err != nil {
		logRequest("POST %s upstream error: %s", r.URL.Path, err)
		writeError(w, http.StatusBadGateway, "api_error", err.Error())
		return
	}
	defer resp.Body.Close()
	logRequest("POST %s upstream status=%d stream=%v", r.URL.Path, resp.StatusCode, stream)
	for name, values := range resp.Header {
		if strings.EqualFold(name, "Content-Length") || strings.EqualFold(name, "Transfer-Encoding") {
			continue
		}
		for _, value := range values {
			w.Header().Add(name, value)
		}
	}
	if stream {
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
	}
	w.WriteHeader(resp.StatusCode)
	if stream {
		copyAndNormalizeSSE(w, resp.Body, firstNonEmpty(routeModel, mappedModel))
		return
	}
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		content, err := io.ReadAll(resp.Body)
		if err == nil {
			normalized := normalizeMessageJSON(content, firstNonEmpty(routeModel, mappedModel))
			_, _ = w.Write(normalized)
			return
		}
	}
	_, _ = io.Copy(w, resp.Body)
}

func (p *Proxy) handleCountTokens(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "invalid_request_error", "count_tokens endpoint requires POST")
		return
	}
	body, err := io.ReadAll(r.Body)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request_error", err.Error())
		return
	}
	payload := map[string]interface{}{}
	if err := json.Unmarshal(body, &payload); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request_error", "invalid JSON body")
		return
	}
	if model, ok := payload["model"].(string); ok {
		payload["model"] = p.mapModel(model)
	}
	logRequest("POST %s count_tokens model=%s", r.URL.Path, emptyModel(fmt.Sprint(payload["model"])))
	outboundBody, _ := json.Marshal(payload)
	upstreamReq, err := http.NewRequestWithContext(r.Context(), http.MethodPost, buildCountTokensURL(p.cfg.UpstreamBaseURL), bytes.NewReader(outboundBody))
	if err == nil {
		upstreamReq.Header.Set("Content-Type", "application/json")
		upstreamReq.Header.Set("Accept", "application/json")
		upstreamReq.Header.Set("anthropic-version", firstNonEmpty(r.Header.Get("anthropic-version"), "2023-06-01"))
		upstreamReq.Header.Set("Authorization", "Bearer "+p.cfg.UpstreamToken)
		resp, err := p.client.Do(upstreamReq)
		if err == nil {
			defer resp.Body.Close()
			if resp.StatusCode >= 200 && resp.StatusCode < 300 {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(resp.StatusCode)
				_, _ = io.Copy(w, resp.Body)
				return
			}
			logRequest("POST %s upstream count_tokens status=%d; using local estimate", r.URL.Path, resp.StatusCode)
		} else {
			logRequest("POST %s upstream count_tokens error=%s; using local estimate", r.URL.Path, err)
		}
	}
	writeHTTPJSON(w, http.StatusOK, map[string]interface{}{"input_tokens": estimateInputTokens(payload)})
}

func buildUpstreamURL(baseURL string) string {
	return strings.TrimSpace(baseURL)
}

func buildCountTokensURL(baseURL string) string {
	return strings.TrimSpace(baseURL)
}

func copyAndNormalizeSSE(w http.ResponseWriter, r io.Reader, routeModel string) {
	reader := bufio.NewReader(r)
	flusher, _ := w.(http.Flusher)
	for {
		line, err := reader.ReadString('\n')
		if line != "" {
			normalized := normalizeSSELine(line, routeModel)
			_, _ = w.Write([]byte(normalized))
			if flusher != nil {
				flusher.Flush()
			}
		}
		if err != nil {
			return
		}
	}
}

func normalizeMessageJSON(content []byte, routeModel string) []byte {
	payload := map[string]interface{}{}
	if err := json.Unmarshal(content, &payload); err != nil {
		return content
	}
	if _, ok := payload["error"]; ok {
		return content
	}
	normalizeMessage(payload, routeModel)
	normalized, err := json.Marshal(payload)
	if err != nil {
		return content
	}
	return normalized
}

func normalizeSSELine(line, routeModel string) string {
	trimmed := strings.TrimRight(line, "\r\n")
	if strings.HasPrefix(trimmed, "event:") {
		eventName := strings.TrimSpace(strings.TrimPrefix(trimmed, "event:"))
		return "event: " + eventName + "\n"
	}
	if !strings.HasPrefix(trimmed, "data:") {
		return line
	}
	data := strings.TrimSpace(strings.TrimPrefix(trimmed, "data:"))
	if data == "" || data == "[DONE]" {
		return "data: " + data + "\n"
	}
	payload := map[string]interface{}{}
	if err := json.Unmarshal([]byte(data), &payload); err != nil {
		return "data: " + data + "\n"
	}
	normalizeSSEEvent(payload, routeModel)
	normalized, err := json.Marshal(payload)
	if err != nil {
		return "data: " + data + "\n"
	}
	return "data: " + string(normalized) + "\n"
}

func normalizeSSEEvent(event map[string]interface{}, routeModel string) {
	switch event["type"] {
	case "message_start":
		message, _ := event["message"].(map[string]interface{})
		if message == nil {
			message = map[string]interface{}{}
			event["message"] = message
		}
		normalizeMessage(message, routeModel)
	case "message_delta":
		event["usage"] = normalizeUsage(event["usage"])
	default:
		if _, ok := event["usage"]; ok {
			event["usage"] = normalizeUsage(event["usage"])
		}
	}
}

func normalizeMessage(message map[string]interface{}, routeModel string) {
	if strings.TrimSpace(fmt.Sprint(message["id"])) == "" || message["id"] == nil {
		key, _ := newGatewayKey()
		message["id"] = "msg_" + strings.TrimPrefix(key, "forge_")[:12]
	}
	if strings.TrimSpace(fmt.Sprint(message["type"])) == "" || message["type"] == nil {
		message["type"] = "message"
	}
	if strings.TrimSpace(fmt.Sprint(message["role"])) == "" || message["role"] == nil {
		message["role"] = "assistant"
	}
	if strings.TrimSpace(routeModel) != "" {
		message["model"] = routeModel
	} else if strings.TrimSpace(fmt.Sprint(message["model"])) == "" || message["model"] == nil {
		message["model"] = sonnetID
	}
	if _, ok := message["content"].([]interface{}); !ok {
		message["content"] = []interface{}{}
	}
	message["usage"] = normalizeUsage(message["usage"])
}

func normalizeUsage(value interface{}) map[string]interface{} {
	usage, _ := value.(map[string]interface{})
	if usage == nil {
		usage = map[string]interface{}{}
	}
	if _, ok := usage["input_tokens"]; !ok {
		usage["input_tokens"] = 0
	}
	if _, ok := usage["output_tokens"]; !ok {
		if completion, ok := usage["completion_tokens"]; ok {
			usage["output_tokens"] = completion
		} else {
			usage["output_tokens"] = 0
		}
	}
	return usage
}

func estimateInputTokens(payload map[string]interface{}) int {
	text := fmt.Sprint(payload["system"]) + " " + fmt.Sprint(payload["messages"])
	estimate := len([]rune(text))/4 + 1
	if estimate < 1 {
		return 1
	}
	return estimate
}
