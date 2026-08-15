package claudeapp

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

func localConfigRoot() string {
	if isWindows() {
		if base := os.Getenv("LOCALAPPDATA"); base != "" {
			return filepath.Join(base, "Claude-3p")
		}
	}
	if base := os.Getenv("LOCALAPPDATA"); base != "" {
		return filepath.Join(base, "Claude-3p")
	}
	if isDarwin() {
		if home := userHome(); home != "" {
			return filepath.Join(home, "Library", "Application Support", "Claude-3p")
		}
	}
	return ""
}

func ApplyLocalConfig(cfg Config) error {
	root := localConfigRoot()
	if root == "" {
		return nil
	}
	enterpriseConfig := map[string]interface{}{
		"inferenceProvider":             "gateway",
		"inferenceGatewayBaseUrl":       cfg.GatewayBaseURL,
		"inferenceGatewayApiKey":        cfg.GatewayAPIKey,
		"inferenceGatewayAuthScheme":    gatewayAuthScheme,
		"inferenceGatewayHeaders":       gatewayHeaders(cfg.GatewayAPIKey),
		"isClaudeCodeForDesktopEnabled": true,
		"coworkEgressAllowedHosts":      []string{"*"},
		"disableDeploymentModeChooser":  true,
		"forge_managed":                 true,
		"forge_profile":                 cfg.Profile.Name,
		"forge_provider":                cfg.Profile.Provider,
		"forge_updated_at":              time.Now().UTC().Format(time.RFC3339),
	}
	enterpriseConfig["inferenceModels"] = localModelEntries(cfg.Routes)
	configPath := filepath.Join(root, "claude_desktop_config.json")
	config := readJSONMap(configPath)
	if config == nil {
		config = map[string]interface{}{}
	}
	config["deploymentMode"] = "3p"
	config["enterpriseConfig"] = enterpriseConfig
	if err := writeJSON(configPath, config); err != nil {
		return fmt.Errorf("forge app: write Claude-3p config failed: %w", err)
	}

	libraryDir := filepath.Join(root, "configLibrary")
	if err := os.MkdirAll(libraryDir, 0o700); err != nil {
		return err
	}
	if err := removeStaleSwitchConfigs(libraryDir); err != nil {
		return err
	}
	entryPath := filepath.Join(libraryDir, configLibraryID+".json")
	entry := map[string]interface{}{}
	for key, value := range enterpriseConfig {
		entry[key] = value
	}
	if err := writeJSON(entryPath, entry); err != nil {
		return fmt.Errorf("forge app: write Claude-3p config library entry failed: %w", err)
	}
	meta := map[string]interface{}{
		"appliedId": configLibraryID,
		"entries": []map[string]string{{
			"id":   configLibraryID,
			"name": "Forge " + cfg.Profile.Name,
		}},
	}
	if err := writeJSON(filepath.Join(libraryDir, "_meta.json"), meta); err != nil {
		return fmt.Errorf("forge app: write Claude-3p config library metadata failed: %w", err)
	}
	return nil
}

func gatewayHeaders(apiKey string) map[string]string {
	return map[string]string{"x-api-key": apiKey}
}

func GatewayHeadersJSON(apiKey string) string {
	content, err := json.Marshal(gatewayHeaders(apiKey))
	if err != nil {
		return "{}"
	}
	return string(content)
}

func removeStaleSwitchConfigs(libraryDir string) error {
	entries, err := os.ReadDir(libraryDir)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		name := entry.Name()
		if name == "_meta.json" || name == configLibraryID+".json" || !strings.HasSuffix(strings.ToLower(name), ".json") {
			continue
		}
		path := filepath.Join(libraryDir, name)
		content, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		text := strings.ToLower(string(content))
		if strings.Contains(text, "ccs-") || strings.Contains(text, "ccds_") || strings.Contains(text, "ccswitch") ||
			strings.Contains(text, "127.0.0.1:15721") || strings.Contains(text, "/claude-desktop") {
			if err := os.Remove(path); err != nil {
				return fmt.Errorf("forge app: remove stale Claude-3p switch config %s failed: %w", path, err)
			}
		}
	}
	return nil
}

// QueryLocalConfigPolicy reads the current Claude Desktop local config policy,
// redacting sensitive values.
func QueryLocalConfigPolicy() map[string]interface{} {
	root := localConfigRoot()
	if root == "" {
		return nil
	}
	policy := map[string]interface{}{}
	config := readJSONMap(filepath.Join(root, "claude_desktop_config.json"))
	if enterprise, ok := config["enterpriseConfig"].(map[string]interface{}); ok {
		for key, value := range enterprise {
			policy[key] = redactInterfaceValue(key, value)
		}
	}
	if len(policy) > 0 {
		return policy
	}
	entry := readJSONMap(filepath.Join(root, "configLibrary", configLibraryID+".json"))
	for key, value := range entry {
		policy[key] = redactInterfaceValue(key, value)
	}
	return policy
}

func ClearLocalConfig() error {
	root := localConfigRoot()
	if root == "" {
		return nil
	}

	var failures []string

	configPath := filepath.Join(root, "claude_desktop_config.json")
	if config := readJSONMap(configPath); len(config) > 0 {
		removedManagedConfig := false
		if enterprise, ok := config["enterpriseConfig"].(map[string]interface{}); ok && interfaceBoolishTrue(enterprise["forge_managed"]) {
			delete(config, "enterpriseConfig")
			removedManagedConfig = true
		}
		if removedManagedConfig {
			delete(config, "deploymentMode")
		}
		if len(config) == 0 {
			if err := os.Remove(configPath); err != nil && !errorsIsNotExist(err) {
				failures = append(failures, fmt.Sprintf("forge app: remove Claude Desktop config failed: %v", err))
			}
		} else if err := writeJSON(configPath, config); err != nil {
			failures = append(failures, fmt.Sprintf("forge app: update Claude Desktop config failed: %v", err))
		}
	}

	libraryDir := filepath.Join(root, "configLibrary")
	entryPath := filepath.Join(libraryDir, configLibraryID+".json")
	if err := os.Remove(entryPath); err != nil && !errorsIsNotExist(err) {
		failures = append(failures, fmt.Sprintf("forge app: remove Claude-3p config library entry failed: %v", err))
	}
	metaPath := filepath.Join(libraryDir, "_meta.json")
	if meta := readJSONMap(metaPath); len(meta) > 0 {
		entries, _ := meta["entries"].([]interface{})
		filtered := make([]interface{}, 0, len(entries))
		for _, entry := range entries {
			item, ok := entry.(map[string]interface{})
			if !ok {
				filtered = append(filtered, entry)
				continue
			}
			id, _ := item["id"].(string)
			if id == configLibraryID {
				continue
			}
			filtered = append(filtered, item)
		}
		if appliedID, _ := meta["appliedId"].(string); appliedID == configLibraryID {
			delete(meta, "appliedId")
		}
		if len(filtered) == 0 {
			delete(meta, "entries")
		} else {
			meta["entries"] = filtered
		}
		if len(meta) == 0 {
			if err := os.Remove(metaPath); err != nil && !errorsIsNotExist(err) {
				failures = append(failures, fmt.Sprintf("forge app: remove Claude-3p config library metadata failed: %v", err))
			}
		} else if err := writeJSON(metaPath, meta); err != nil {
			failures = append(failures, fmt.Sprintf("forge app: update Claude-3p config library metadata failed: %v", err))
		}
	}

	if len(failures) > 0 {
		return errors.New(strings.Join(failures, "; "))
	}
	return nil
}

func redactInterfaceValue(name string, value interface{}) interface{} {
	text, ok := value.(string)
	if !ok {
		if policyValueIsSensitive(name) && !interfaceValueIsEmpty(value) {
			return "******"
		}
		return value
	}
	return redactValue(name, text)
}

func redactValue(name, value string) string {
	if policyValueIsSensitive(name) {
		if strings.TrimSpace(value) == "" || value == "[]" {
			return value
		}
		return "******"
	}
	return value
}

func readJSONMap(path string) map[string]interface{} {
	data := map[string]interface{}{}
	content, err := os.ReadFile(path)
	if err == nil {
		_ = json.Unmarshal(content, &data)
	}
	return data
}

func writeJSON(path string, value interface{}) error {
	content, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return os.WriteFile(path, append(content, '\n'), 0o644)
}

func interfaceBoolishTrue(value interface{}) bool {
	switch v := value.(type) {
	case bool:
		return v
	case string:
		return strings.EqualFold(strings.TrimSpace(v), "true")
	default:
		return false
	}
}

func interfaceValueIsEmpty(value interface{}) bool {
	switch v := value.(type) {
	case nil:
		return true
	case []interface{}:
		return len(v) == 0
	case []string:
		return len(v) == 0
	case map[string]interface{}:
		return len(v) == 0
	case map[string]string:
		return len(v) == 0
	default:
		return false
	}
}

func isDarwin() bool { return runtime.GOOS == "darwin" }

func errorsIsNotExist(err error) bool { return os.IsNotExist(err) }

func policyValueIsSensitive(name string) bool {
	lower := strings.ToLower(name)
	return strings.Contains(lower, "key") || strings.Contains(lower, "token") || strings.Contains(lower, "secret") || strings.Contains(lower, "headers")
}
