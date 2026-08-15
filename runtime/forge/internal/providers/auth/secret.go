package auth

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// SecretDeps provides the external dependencies for secret resolution.
type SecretDeps struct {
	ResolveCredential func(providerID string) (string, bool)
	RepoDir           func() (string, error)
	UserSecretsPath   func() string
}

// ResolveSecret resolves a profile secret reference into a secret value
// or an error. It is the moved-root implementation.
func ResolveSecret(ref *string, deps SecretDeps) (*string, error) {
	if ref == nil {
		return nil, nil
	}
	parts := splitRef(*ref)
	if len(parts) != 2 {
		return nil, fmt.Errorf("forge profile secret has unsupported ref: %s", *ref)
	}
	switch parts[0] {
	case "env":
		value := os.Getenv(parts[1])
		if value == "" {
			if key, ok := resolveByProviderAuth(parts[1], deps); ok {
				return &key, nil
			}
			return nil, fmt.Errorf("forge profile secret missing: set %s", *ref)
		}
		return &value, nil
	case "repo":
		if key, ok := resolveByProviderAuth(parts[1], deps); ok {
			return &key, nil
		}
		value := userSecret(parts[1], deps)
		if value == "" {
			value = repoSecret(parts[1], deps)
		}
		if value == "" {
			return nil, fmt.Errorf("forge profile secret missing: data/secrets.json key %s", parts[1])
		}
		return &value, nil
	case "profile":
		return nil, nil
	case "system":
		return nil, nil
	default:
		return nil, fmt.Errorf("forge profile secret has unsupported ref: %s", *ref)
	}
}

func splitRef(ref string) []string {
	if ref == "" {
		return nil
	}
	var parts []string
	start := 0
	for i := 0; i < len(ref); i++ {
		if ref[i] == ':' {
			parts = append(parts, ref[start:i])
			start = i + 1
			break
		}
	}
	if start < len(ref) {
		parts = append(parts, ref[start:])
	}
	return parts
}

func resolveByProviderAuth(legacyKey string, deps SecretDeps) (string, bool) {
	providerID := LegacyKeyToProviderID(legacyKey)
	if providerID == "" {
		return "", false
	}
	return deps.ResolveCredential(providerID)
}

func LegacyKeyToProviderID(key string) string {
	switch key {
	case "glm-anthropic-auth-token", "glm-Tencent-auth-token", "glm-api-key", "zhipu-api-key",
		"FORGE_GLM_ANTHROPIC_AUTH_TOKEN", "GLM_ANTHROPIC_AUTH_TOKEN":
		return "zhipu-coding"
	case "kimi-coding-api-key", "kimi-api-key", "moonshot-api-key",
		"FORGE_KIMI_CODING_API_KEY", "KIMI_CODING_API_KEY", "MOONSHOT_API_KEY":
		return "kimi-coding"
	case "deepseek-anthropic-auth-token", "FORGE_DEEPSEEK_ANTHROPIC_AUTH_TOKEN":
		return "deepseek"
	}
	return ""
}

func repoSecret(name string, deps SecretDeps) string {
	repo, err := deps.RepoDir()
	if err != nil {
		return ""
	}
	return readSecretJSON(filepath.Join(repo, "data", repoSecretsFile), name)
}

func userSecret(name string, deps SecretDeps) string {
	return readSecretJSON(deps.UserSecretsPath(), name)
}

func FirstSecret(keys []string, deps SecretDeps) string {
	for _, key := range keys {
		if value := userSecret(key, deps); strings.TrimSpace(value) != "" {
			return value
		}
	}
	for _, key := range keys {
		if value := repoSecret(key, deps); strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

func RepoSecret(name string, deps SecretDeps) string {
	return repoSecret(name, deps)
}

func UserSecret(name string, deps SecretDeps) string {
	return userSecret(name, deps)
}

const repoSecretsFile = "secrets.json"

func readSecretJSON(path string, name string) string {
	data, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	var m map[string]interface{}
	if json.Unmarshal(data, &m) != nil {
		return ""
	}
	if v, ok := m[name].(string); ok {
		return v
	}
	return ""
}

func ReadSecretsFile(path string) map[string]interface{} {
	data := map[string]interface{}{}
	content, err := os.ReadFile(path)
	if err == nil {
		_ = json.Unmarshal(content, &data)
	}
	return data
}
