package grok

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/pelletier/go-toml/v2"
)

// AgentHomeParent is the parent of collision-resistant ephemeral agent homes.
// It is deliberately distinct from the persistent shell-grok home.
func AgentHomeParent(forgeDataDir string) string {
	return filepath.Join(forgeDataDir, "grok", "agent-grok")
}

// AgentConfigBytes renders a complete, secret-free config containing the
// eligible Forge-managed projections and the selected profile model. Setting
// the ephemeral default keeps Grok's auxiliary requests on the same provider.
// No existing config or shell overlay participates.
func AgentConfigBytes(projections []Projection, defaultModel string) ([]byte, error) {
	tree := map[string]interface{}{}
	if defaultModel != "" {
		tree["models"] = map[string]interface{}{
			"default":         defaultModel,
			"session_summary": defaultModel,
		}
	}
	models := map[string]interface{}{}
	for _, projection := range projections {
		models[projection.ID] = projectionToMap(projection)
	}
	if len(models) > 0 {
		tree["model"] = models
	}
	data, err := toml.Marshal(tree)
	if err != nil {
		return nil, fmt.Errorf("grok: encode agent config: %w", err)
	}
	return data, nil
}

// MCPServerConfig is one HTTP MCP entry in an ephemeral Grok config.
type MCPServerConfig struct {
	Name    string
	URL     string
	Headers map[string]string
}

// MCPConfigBytes renders all HTTP MCP servers into one TOML tree. Rendering
// them together is required because appending independently marshalled trees
// repeats the parent [mcp_servers] table and Grok rejects the result as a
// duplicate key when a profile exposes more than one server.
func MCPConfigBytes(servers []MCPServerConfig) ([]byte, error) {
	serverTable := make(map[string]interface{}, len(servers))
	for _, server := range servers {
		if strings.TrimSpace(server.Name) == "" {
			return nil, fmt.Errorf("grok: MCP server name must not be empty")
		}
		if strings.TrimSpace(server.URL) == "" {
			return nil, fmt.Errorf("grok: MCP server %q URL must not be empty", server.Name)
		}
		nested := map[string]interface{}{
			"url":     server.URL,
			"enabled": true,
		}
		if len(server.Headers) > 0 {
			headerTable := make(map[string]interface{}, len(server.Headers))
			for key, value := range server.Headers {
				headerTable[key] = value
			}
			nested["headers"] = headerTable
		}
		// Capability resolution already defines last-wins behavior for
		// duplicate server names; the map keeps the TOML structurally valid.
		serverTable[server.Name] = nested
	}

	data, err := toml.Marshal(map[string]interface{}{"mcp_servers": serverTable})
	if err != nil {
		return nil, fmt.Errorf("grok: encode MCP servers: %w", err)
	}
	return data, nil
}

// MCPTomlSection preserves the single-server helper contract used by callers
// and tests while delegating to the multi-server-safe encoder.
func MCPTomlSection(serverName, url string, headers map[string]string) ([]byte, error) {
	return MCPConfigBytes([]MCPServerConfig{{Name: serverName, URL: url, Headers: headers}})
}

// OAuthCandidates returns native xAI OAuth sources in required precedence:
// Forge's persistent shell-grok home, then the official default Grok home.
func OAuthCandidates(forgeDataDir, home string) []string {
	return []string{
		filepath.Join(forgeDataDir, "grok", "shell-grok", "auth.json"),
		filepath.Join(home, ".grok", "auth.json"),
	}
}

// PreparedOAuth records the selected copy source separately from every
// readable credential source discovered during precedence evaluation. The
// latter is guard metadata only and never causes an unselected file to be
// copied.
type PreparedOAuth struct {
	SourcePath    string
	ReadablePaths []string
}

// PrepareOAuth evaluates every precedence candidate so a lower-precedence
// readable credential remains protected even when shell-grok wins. Selection
// still uses the first readable regular file and no credential bytes are
// retained.
func PrepareOAuth(forgeDataDir, home string) (PreparedOAuth, error) {
	prepared, inaccessible := inspectOAuthCandidates(forgeDataDir, home)
	if prepared.SourcePath != "" {
		return prepared, nil
	}
	if inaccessible {
		return PreparedOAuth{}, fmt.Errorf("xAI OAuth auth.json is present but not copyable")
	}
	return PreparedOAuth{}, fmt.Errorf("xAI OAuth auth.json is missing; run grok login outside Forge")
}

// ReadableOAuthSources returns every readable regular OAuth candidate without
// selecting or copying one. Grok projections for non-xAI providers still use
// this metadata to protect credentials that the child could otherwise inspect.
func ReadableOAuthSources(forgeDataDir, home string) []string {
	prepared, _ := inspectOAuthCandidates(forgeDataDir, home)
	return append([]string(nil), prepared.ReadablePaths...)
}

func inspectOAuthCandidates(forgeDataDir, home string) (PreparedOAuth, bool) {
	prepared := PreparedOAuth{}
	var inaccessible bool
	for _, candidate := range OAuthCandidates(forgeDataDir, home) {
		info, err := os.Stat(candidate)
		if err != nil {
			if !os.IsNotExist(err) {
				inaccessible = true
			}
			continue
		}
		if !info.Mode().IsRegular() {
			inaccessible = true
			continue
		}
		file, err := os.Open(candidate)
		if err != nil {
			inaccessible = true
			continue
		}
		_, readErr := io.Copy(io.Discard, file)
		closeErr := file.Close()
		if readErr != nil || closeErr != nil {
			inaccessible = true
			continue
		}
		prepared.ReadablePaths = append(prepared.ReadablePaths, candidate)
		if prepared.SourcePath == "" {
			prepared.SourcePath = candidate
		}
	}
	return prepared, inaccessible
}

// SelectOAuthSource selects the first readable regular OAuth file. It reads
// only to prove copyability and never parses, logs, or rewrites the bytes.
func SelectOAuthSource(forgeDataDir, home string) (string, error) {
	prepared, err := PrepareOAuth(forgeDataDir, home)
	return prepared.SourcePath, err
}
