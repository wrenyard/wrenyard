package auth

import (
	"net/http"
	"regexp"
	"strings"
)

const RedactionPlaceholder = "<REDACTED>"

var secretAssignmentRE = regexp.MustCompile(`(?i)\b([A-Za-z0-9_-]*(?:api[_-]?key|authorization|bearer|password|secret|token)[A-Za-z0-9_-]*)(\s*[:=]\s*)([^\s,;]+)`)
var bearerRE = regexp.MustCompile(`(?i)\bBearer\s+[^\s,;]+`)
var secretValueRE = regexp.MustCompile(`(?i)\b(?:sk|pk|ghp|rio|token)[-_][A-Za-z0-9._-]{6,}\b|AIza[0-9A-Za-z_-]{20,}`)
var contentSecretRE = regexp.MustCompile(`(?i)\b(?:sk|pk|ghp|rio|token)[-_][A-Za-z0-9._-]{6,}\b|AIza[0-9A-Za-z_-]{20,}|Bearer\s+[^\s,;]+`)

func Redact(value interface{}) interface{} {
	switch v := value.(type) {
	case map[string]interface{}:
		out := map[string]interface{}{}
		for key, item := range v {
			if isSecretKey(key) {
				out[key] = RedactionPlaceholder
				continue
			}
			if key == "content" {
				if s, ok := item.(string); ok {
					out[key] = contentSecretRE.ReplaceAllString(s, RedactionPlaceholder)
					continue
				}
			}
			out[key] = Redact(item)
		}
		return out
	case map[string]string:
		out := make(map[string]interface{})
		for key, item := range v {
			if isSecretKey(key) {
				out[key] = RedactionPlaceholder
			} else {
				out[key] = RedactString(item)
			}
		}
		return out
	case map[string][]string:
		out := make(map[string]interface{})
		for key, items := range v {
			if isSecretKey(key) {
				out[key] = RedactionPlaceholder
			} else {
				redactedItems := make([]interface{}, len(items))
				for i, item := range items {
					redactedItems[i] = RedactString(item)
				}
				out[key] = redactedItems
			}
		}
		return out
	case http.Header:
		out := make(http.Header)
		for key, items := range v {
			if isSecretKey(key) {
				out[key] = []string{RedactionPlaceholder}
			} else {
				redactedItems := make([]string, len(items))
				for i, item := range items {
					redactedItems[i] = RedactString(item)
				}
				out[key] = redactedItems
			}
		}
		return out
	case []interface{}:
		out := make([]interface{}, 0, len(v))
		for _, item := range v {
			out = append(out, Redact(item))
		}
		return out
	case []map[string]interface{}:
		out := make([]interface{}, 0, len(v))
		for _, item := range v {
			out = append(out, Redact(item))
		}
		return out
	case []map[string]string:
		out := make([]interface{}, 0, len(v))
		for _, item := range v {
			out = append(out, Redact(item))
		}
		return out
	case []string:
		out := make([]interface{}, 0, len(v))
		for _, item := range v {
			out = append(out, RedactString(item))
		}
		return out
	case string:
		return RedactString(v)
	default:
		return value
	}
}

func RedactString(value string) string {
	redacted := secretAssignmentRE.ReplaceAllString(value, `${1}${2}`+RedactionPlaceholder)
	redacted = bearerRE.ReplaceAllString(redacted, "Bearer "+RedactionPlaceholder)
	return secretValueRE.ReplaceAllString(redacted, RedactionPlaceholder)
}

func isSecretKey(key string) bool {
	normalized := strings.ReplaceAll(strings.ToLower(key), "-", "_")
	for _, part := range []string{"api_key", "authorization", "password", "secret", "token"} {
		if strings.Contains(normalized, part) {
			return true
		}
	}
	return false
}
