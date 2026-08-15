package install

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
)

// --- Provider migration ---

// MigrateProvidersIntoConfig folds old providers.json entries into config.json's
// provider field (idempotent), then renames providers.json to .migrated.
func MigrateProvidersIntoConfig(providersPath, configPath string) error {
	provData, err := os.ReadFile(providersPath)
	if err != nil {
		return fmt.Errorf("read %s: %w", providersPath, err)
	}
	var oldManifest providerManifestDTO
	if err := json.Unmarshal(provData, &oldManifest); err != nil {
		fmt.Printf("  providers.json parse failed (%v); renaming to .migrated without merging\n", err)
		return os.Rename(providersPath, providersPath+".migrated")
	}
	if len(oldManifest.Providers) == 0 {
		return os.Rename(providersPath, providersPath+".migrated")
	}

	cfgData, err := os.ReadFile(configPath)
	if err != nil {
		return fmt.Errorf("read %s: %w", configPath, err)
	}
	var cfg map[string]interface{}
	if err := json.Unmarshal(cfgData, &cfg); err != nil {
		return fmt.Errorf("parse %s: %w", configPath, err)
	}

	if cfg["provider"] == nil {
		cfg["provider"] = map[string]interface{}{}
	}
	provField, ok := cfg["provider"].(map[string]interface{})
	if !ok {
		return fmt.Errorf("provider field in %s is not an object", configPath)
	}

	for name, entry := range oldManifest.Providers {
		if _, exists := provField[name]; exists {
			continue
		}
		provField[name] = map[string]interface{}{
			"name":     name,
			"api_kind": entry.APIKind,
		}
		if entry.BaseURL != "" {
			provField[name].(map[string]interface{})["options"] = map[string]string{
				"base_url": entry.BaseURL,
			}
		}
		if len(entry.Models) > 0 {
			provField[name].(map[string]interface{})["models"] = entry.Models
		}
	}
	cfg["provider"] = provField

	newData, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal config: %w", err)
	}
	if err := os.WriteFile(configPath, append(newData, '\n'), 0o644); err != nil {
		return fmt.Errorf("write %s: %w", configPath, err)
	}
	fmt.Printf("  migrated providers from %s into %s\n", providersPath, configPath)

	return os.Rename(providersPath, providersPath+".migrated")
}

type providerManifestDTO struct {
	SchemaVersion int                    `json:"schema_version"`
	Providers     map[string]providerDTO `json:"providers"`
}

type providerDTO struct {
	APIKind string             `json:"api_kind"`
	BaseURL string             `json:"base_url,omitempty"`
	Models  []providerModelDTO `json:"models,omitempty"`
}

type providerModelDTO struct {
	Name string `json:"name"`
}

// --- Gitignore helpers ---

// EnsureGitignoreEntry adds a line to .gitignore if not already present.
func EnsureGitignoreEntry(gitignorePath, entry string) error {
	content, err := os.ReadFile(gitignorePath)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	lines := strings.Split(string(content), "\n")
	for _, line := range lines {
		if strings.TrimSpace(line) == entry {
			return nil
		}
	}
	f, err := os.OpenFile(gitignorePath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	defer f.Close()
	if len(content) > 0 && !strings.HasSuffix(string(content), "\n") {
		if _, err := f.WriteString("\n"); err != nil {
			return err
		}
	}
	_, err = f.WriteString(entry + "\n")
	return err
}

// IsGitTracked checks whether a file path is tracked by git in the given repo.
func IsGitTracked(repo, path string) bool {
	cmd := exec.Command("git", "-C", repo, "ls-files", "--error-unmatch", path)
	cmd.Stdout = nil
	cmd.Stderr = nil
	return cmd.Run() == nil
}

// --- GeneratedFrom / drift helpers ---

// InjectGeneratedFrom adds a _generated_from field to a JSON object and
// returns the modified byte slice.
func InjectGeneratedFrom(data []byte, version string) []byte {
	h := dataSHA256(data)
	tag := fmt.Sprintf("forge/%s sha256:%s", version, h)
	if len(data) == 0 {
		return data
	}
	s := strings.TrimRight(string(data), " \t\n\r")
	if strings.HasPrefix(s, "{") && strings.HasSuffix(s, "}") {
		inner := strings.TrimSpace(s[1 : len(s)-1])
		if inner == "" {
			result := fmt.Sprintf("{\"_generated_from\": %q}", tag)
			return append([]byte(result), '\n')
		}
		result := strings.TrimRight(s[:len(s)-1], " \t\n\r")
		result += fmt.Sprintf(",\n  \"_generated_from\": %q", tag)
		result += "\n}\n"
		return []byte(result)
	}
	return data
}

// ProfileContentMatchesEmbeddedCanonical reports whether the on-disk profile
// content matches the embedded canonical form of the given profile data.
func ProfileContentMatchesEmbeddedCanonical(content []byte, canonicalProfileBytes []byte) bool {
	var wrapper struct {
		GeneratedFrom string `json:"_generated_from"`
	}
	if err := json.Unmarshal(content, &wrapper); err != nil {
		return false
	}

	var canonical []byte
	if wrapper.GeneratedFrom == "" {
		canonical = canonicalizeJSONBytes(content)
	} else {
		canonical = stripGeneratedFromBytes(content)
	}

	canonicalEmbed := canonicalizeJSONBytes(canonicalProfileBytes)
	return dataSHA256(canonical) == dataSHA256(canonicalEmbed)
}

// --- Internal helpers ---

func canonicalizeJSONBytes(data []byte) []byte {
	var obj map[string]interface{}
	if err := json.Unmarshal(data, &obj); err != nil {
		return data
	}
	cleaned, err := json.MarshalIndent(obj, "", "  ")
	if err != nil {
		return data
	}
	return cleaned
}

func stripGeneratedFromBytes(data []byte) []byte {
	var obj map[string]interface{}
	if err := json.Unmarshal(data, &obj); err != nil {
		return data
	}
	delete(obj, "_generated_from")
	cleaned, err := json.MarshalIndent(obj, "", "  ")
	if err != nil {
		return data
	}
	return cleaned
}

func dataSHA256(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

// ReadSecretsFile reads a JSON file and returns a flat map of secrets.
func ReadSecretsFile(path string) (map[string]interface{}, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var result map[string]interface{}
	if err := json.Unmarshal(data, &result); err != nil {
		return nil, err
	}
	return result, nil
}
