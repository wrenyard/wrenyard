package claudeapp

import (
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Proxy is the Claude app gateway HTTP handler.
type Proxy struct {
	cfg    Config
	client *http.Client
}

// NewProxy builds the Claude app gateway HTTP handler from an explicit Config.
func NewProxy(cfg Config) http.Handler {
	return &Proxy{
		cfg:    cfg,
		client: newUpstreamClient(),
	}
}

func newUpstreamClient() *http.Client {
	return &http.Client{
		Transport: &http.Transport{
			Proxy: http.ProxyFromEnvironment,
			DialContext: (&net.Dialer{
				Timeout:   30 * time.Second,
				KeepAlive: 30 * time.Second,
			}).DialContext,
			ForceAttemptHTTP2:     true,
			MaxIdleConns:          100,
			IdleConnTimeout:       90 * time.Second,
			TLSHandshakeTimeout:   10 * time.Second,
			ResponseHeaderTimeout: 60 * time.Second,
			ExpectContinueTimeout: 1 * time.Second,
		},
	}
}

func (p *Proxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	p.writeCORS(w)
	if r.Method == http.MethodOptions {
		logRequest("OPTIONS %s", r.URL.Path)
		w.WriteHeader(http.StatusNoContent)
		return
	}
	requestPath := gatewayPath(r.URL.Path)
	switch requestPath {
	case "/":
		if r.Method == http.MethodPost {
			if !p.authorized(r) {
				writeError(w, http.StatusUnauthorized, "authentication_error", "invalid Forge Claude app gateway key")
				return
			}
			p.handleMessages(w, r)
			return
		}
		p.handleHealth(w)
	case "/health", "/status":
		p.handleHealth(w)
	case "/v1/models", "/claude/v1/models":
		if !p.authorized(r) {
			writeError(w, http.StatusUnauthorized, "authentication_error", "invalid Forge Claude app gateway key")
			return
		}
		p.handleModels(w, r)
	case "/v1/messages", "/claude/v1/messages":
		if !p.authorized(r) {
			writeError(w, http.StatusUnauthorized, "authentication_error", "invalid Forge Claude app gateway key")
			return
		}
		p.handleMessages(w, r)
	case "/v1/messages/count_tokens", "/claude/v1/messages/count_tokens":
		if !p.authorized(r) {
			writeError(w, http.StatusUnauthorized, "authentication_error", "invalid Forge Claude app gateway key")
			return
		}
		p.handleCountTokens(w, r)
	default:
		logRequest("404 %s %s", r.Method, r.URL.Path)
		writeError(w, http.StatusNotFound, "not_found_error", "unknown Forge Claude app gateway endpoint")
	}
}

func (p *Proxy) writeCORS(w http.ResponseWriter) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "*")
	w.Header().Set("Access-Control-Expose-Headers", "*")
}

func gatewayPath(path string) string {
	clean := strings.TrimSpace(path)
	if clean == "" {
		return "/"
	}
	if strings.HasPrefix(clean, "/claude-desktop/") {
		return strings.TrimPrefix(clean, "/claude-desktop")
	}
	if clean == "/claude-desktop" {
		return "/"
	}
	return clean
}

func (p *Proxy) authorized(r *http.Request) bool {
	tokens := requestAuthTokens(r)
	if len(tokens) == 0 {
		return false
	}
	for _, token := range tokens {
		if tokenMatchesAny(token, p.allowedAuthTokens()) {
			return true
		}
	}
	return false
}

func (p *Proxy) allowedAuthTokens() []string {
	tokens := []string{strings.TrimSpace(p.cfg.GatewayAPIKey)}
	tokens = append(tokens, desktopOAuthAccessTokens()...)
	return tokens
}

func requestAuthTokens(r *http.Request) []string {
	tokens := []string{}
	auth := strings.TrimSpace(r.Header.Get("Authorization"))
	if strings.HasPrefix(strings.ToLower(auth), "bearer ") {
		tokens = append(tokens, strings.TrimSpace(auth[len("bearer "):]))
	}
	if key := strings.TrimSpace(r.Header.Get("x-api-key")); key != "" {
		tokens = append(tokens, key)
	}
	if key := strings.TrimSpace(r.Header.Get("anthropic-api-key")); key != "" {
		tokens = append(tokens, key)
	}
	return tokens
}

func tokenMatchesAny(token string, allowed []string) bool {
	token = strings.TrimSpace(token)
	if token == "" {
		return false
	}
	for _, candidate := range allowed {
		candidate = strings.TrimSpace(candidate)
		if candidate == "" || len(token) != len(candidate) {
			continue
		}
		if subtle.ConstantTimeCompare([]byte(token), []byte(candidate)) == 1 {
			return true
		}
	}
	return false
}

func desktopOAuthAccessTokens() []string {
	paths := []string{}
	if dir := strings.TrimSpace(os.Getenv("CLAUDE_CONFIG_DIR")); dir != "" {
		paths = append(paths, filepath.Join(dir, ".credentials.json"))
	}
	if home := userHome(); home != "" {
		paths = append(paths, filepath.Join(home, ".claude", ".credentials.json"))
	}
	tokens := []string{}
	seen := map[string]bool{}
	for _, path := range paths {
		for _, token := range readDesktopOAuthAccessTokens(path) {
			if !seen[token] {
				tokens = append(tokens, token)
				seen[token] = true
			}
		}
	}
	return tokens
}

func readDesktopOAuthAccessTokens(path string) []string {
	content, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var data map[string]interface{}
	if err := json.Unmarshal(content, &data); err != nil {
		return nil
	}
	values := []string{}
	collectDesktopOAuthTokens(data, &values)
	return values
}

func collectDesktopOAuthTokens(value interface{}, values *[]string) {
	switch v := value.(type) {
	case map[string]interface{}:
		for key, child := range v {
			if strings.EqualFold(key, "accessToken") || strings.EqualFold(key, "access_token") {
				if token, ok := child.(string); ok && strings.TrimSpace(token) != "" {
					*values = append(*values, strings.TrimSpace(token))
				}
				continue
			}
			collectDesktopOAuthTokens(child, values)
		}
	case []interface{}:
		for _, child := range v {
			collectDesktopOAuthTokens(child, values)
		}
	}
}

func (p *Proxy) handleHealth(w http.ResponseWriter) {
	writeHTTPJSON(w, http.StatusOK, map[string]interface{}{
		"status":           "ok",
		"profile":          p.cfg.Profile.Name,
		"provider":         p.cfg.Profile.Provider,
		"gateway_base_url": p.cfg.GatewayBaseURL,
	})
}

func (p *Proxy) handleModels(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "invalid_request_error", "models endpoint requires GET")
		return
	}
	logRequest("GET %s -> models profile=%s provider=%s", r.URL.Path, p.cfg.Profile.Name, p.cfg.Profile.Provider)
	data := []map[string]interface{}{}
	for _, route := range p.cfg.Routes {
		row := map[string]interface{}{
			"type":         "model",
			"id":           publicModelID(route),
			"display_name": publicModelDisplayName(route),
			"created_at":   "2024-01-01T00:00:00Z",
		}
		data = append(data, row)
	}
	firstID, lastID := interface{}(nil), interface{}(nil)
	if len(data) > 0 {
		firstID = data[0]["id"]
		lastID = data[len(data)-1]["id"]
	}
	writeHTTPJSON(w, http.StatusOK, map[string]interface{}{
		"data":     data,
		"has_more": false,
		"first_id": firstID,
		"last_id":  lastID,
	})
}

func (p *Proxy) mapModel(requested string) string {
	clean := strings.TrimSpace(requested)
	if clean == "" {
		return clean
	}
	for _, route := range p.cfg.Routes {
		if clean == route.Name || clean == route.UpstreamModel || clean == publicModelID(route) {
			return route.UpstreamModel
		}
	}
	slot := requestedSlot(clean)
	for _, route := range p.cfg.Routes {
		if route.Slot == slot {
			return route.UpstreamModel
		}
	}
	return clean
}

func writeError(w http.ResponseWriter, status int, typ, message string) {
	writeHTTPJSON(w, status, map[string]interface{}{
		"type": "error",
		"error": map[string]string{
			"type":    typ,
			"message": message,
		},
	})
}

func writeHTTPJSON(w http.ResponseWriter, status int, value interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	content, _ := json.Marshal(value)
	_, _ = w.Write(content)
}

func emptyModel(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return "<empty>"
	}
	return value
}

func logRequest(format string, args ...interface{}) {
	fmt.Fprintf(os.Stdout, "%s "+format+"\n", append([]interface{}{time.Now().Format(time.RFC3339)}, args...)...)
}
