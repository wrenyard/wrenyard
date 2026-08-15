// Package capability owns the capability manifest DTOs, loading from an
// explicit user override path plus embedded bytes, normalization, validation,
// merge/dedup and resolution to neutral driver.CapabilityServer values. It may
// import the driver package but never the root forge package.
package capability

import (
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"strings"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/catalog"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/driver"
)

type pack struct {
	Description string             `json:"description"`
	MCPServers  map[string]mcpSpec `json:"mcp_servers"`
	Tools       toolContributions  `json:"tools"`
	BashGate    bashContributions  `json:"bash"`
}

type toolContributions struct {
	Cap []string `json:"cap"`
}

type bashContributions struct {
	Cap []string `json:"cap"`
}

type mcpSpec struct {
	Command           string            `json:"command,omitempty"`
	Args              []string          `json:"args,omitempty"`
	Env               map[string]string `json:"env,omitempty"`
	URL               string            `json:"url,omitempty"`
	StartupTimeoutSec int               `json:"startup_timeout_sec,omitempty"`
}

// Manifest is the resolved capability registry (normalized lookup).
type Manifest map[string]pack

// LoadManifest loads the capability registry: the embedded bytes provide the
// base set, and the user override file at userPath (if present) overlays on
// top of it. Precedence and ordering match the previous root behavior.
func LoadManifest(userPath string, embeddedData []byte) (Manifest, error) {
	var manifest Manifest
	if err := decodeManifest(embeddedData, &manifest); err != nil {
		return nil, fmt.Errorf("invalid embedded capability registry: %w", err)
	}

	data, err := readOptionalFile(userPath)
	if err != nil {
		return nil, fmt.Errorf("read user capability registry: %w", err)
	}
	if data != nil {
		var overlay Manifest
		if err := decodeManifest(data, &overlay); err != nil {
			return nil, fmt.Errorf("invalid user capability registry: %w", err)
		}
		for name, p := range overlay {
			manifest[name] = p
		}
	}

	normalizeManifest(manifest)
	return manifest, nil
}

func readOptionalFile(path string) ([]byte, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	return data, nil
}

func decodeManifest(data []byte, manifest *Manifest) error {
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	*manifest = make(Manifest, len(raw))
	for key, val := range raw {
		name := strings.ToLower(strings.TrimSpace(key))
		if name == "" || strings.HasPrefix(name, "_") {
			continue
		}
		var p pack
		if err := json.Unmarshal(val, &p); err != nil {
			return err
		}
		(*manifest)[name] = p
	}
	return nil
}

func normalizeManifest(manifest Manifest) {
	for name, p := range manifest {
		if p.MCPServers == nil {
			p.MCPServers = map[string]mcpSpec{}
		}
		manifest[name] = p
	}
}

// NormalizeNames lower-cases, trims, and deduplicates capability names,
// preserving first-seen order. Returns an error on an empty name.
func NormalizeNames(names []string) ([]string, error) {
	seen := map[string]bool{}
	normalized := make([]string, 0, len(names))
	for _, raw := range names {
		name := strings.ToLower(strings.TrimSpace(raw))
		if name == "" {
			return nil, fmt.Errorf("capability name must not be empty")
		}
		if seen[name] {
			continue
		}
		seen[name] = true
		normalized = append(normalized, name)
	}
	return normalized, nil
}

// ResolvePacks resolves capability pack names into driver capability servers,
// validating and merging duplicate servers. It takes the user override path
// and embedded registry bytes explicitly so it stays root-independent and has
// no mutable global wiring.
func ResolvePacks(names []string, userPath string, embeddedData []byte) (driver.CapabilityResult, error) {
	normalized, err := NormalizeNames(names)
	if err != nil {
		return driver.CapabilityResult{}, err
	}
	if len(normalized) == 0 {
		return driver.CapabilityResult{}, nil
	}

	manifest, err := LoadManifest(userPath, embeddedData)
	if err != nil {
		return driver.CapabilityResult{}, err
	}

	var result driver.CapabilityResult
	for _, name := range normalized {
		p, ok := manifest[name]
		if !ok {
			available := sortedKeys(manifest)
			if len(available) == 0 {
				return driver.CapabilityResult{}, fmt.Errorf("unknown capability pack %q; no capability packs are available", name)
			}
			return driver.CapabilityResult{}, fmt.Errorf("unknown capability pack %q; available packs: %s", name, strings.Join(available, ", "))
		}
		if len(p.MCPServers) == 0 && len(p.Tools.Cap) == 0 && len(p.BashGate.Cap) == 0 {
			return driver.CapabilityResult{}, fmt.Errorf("capability pack %q does not define any tool, Bash, or MCP contributions", name)
		}
		for _, toolID := range p.Tools.Cap {
			toolID = strings.TrimSpace(toolID)
			if !validToolID(toolID) {
				return driver.CapabilityResult{}, fmt.Errorf("capability pack %q has unsafe tool id %q", name, toolID)
			}
			result.Tools.Cap = appendUnique(result.Tools.Cap, toolID)
		}
		for _, pattern := range p.BashGate.Cap {
			rule := catalog.BashRule{Pattern: pattern}
			if err := catalog.ValidateCapabilityBashRule(rule); err != nil {
				return driver.CapabilityResult{}, fmt.Errorf("capability pack %q: %w", name, err)
			}
			result.BashGate.Cap = appendUniqueBash(result.BashGate.Cap, rule)
		}

		serverNames := make([]string, 0, len(p.MCPServers))
		for serverName := range p.MCPServers {
			serverNames = append(serverNames, serverName)
		}
		sort.Strings(serverNames)
		for _, serverName := range serverNames {
			spec := p.MCPServers[serverName]
			server := driver.CapabilityServer{
				Name:              strings.TrimSpace(serverName),
				Command:           strings.TrimSpace(spec.Command),
				Args:              append([]string(nil), spec.Args...),
				Env:               copyStringMap(spec.Env),
				URL:               strings.TrimSpace(spec.URL),
				StartupTimeoutSec: spec.StartupTimeoutSec,
			}
			if err := validateMCPServer(name, server); err != nil {
				return driver.CapabilityResult{}, err
			}
			result.Tools.MCP = append(result.Tools.MCP, server)
		}
	}
	result.Tools.MCP = mergeServers(result.Tools.MCP)
	return result, nil
}

func validToolID(id string) bool {
	if id == "" || strings.ContainsAny(id, ",\r\n\t ") {
		return false
	}
	for _, r := range id {
		if !((r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || strings.ContainsRune("_.:-", r)) {
			return false
		}
	}
	return true
}

func appendUnique(values []string, value string) []string {
	for _, existing := range values {
		if existing == value {
			return values
		}
	}
	return append(values, value)
}

func appendUniqueBash(values []catalog.BashRule, value catalog.BashRule) []catalog.BashRule {
	for _, existing := range values {
		if existing.Pattern == value.Pattern {
			return values
		}
	}
	return append(values, value)
}

func validateMCPServer(packName string, server driver.CapabilityServer) error {
	if strings.TrimSpace(server.Name) == "" {
		return fmt.Errorf("capability pack %q has an MCP server with an empty name", packName)
	}
	if server.URL == "" && server.Command == "" {
		return fmt.Errorf("capability pack %q MCP server %q must define command or url", packName, server.Name)
	}
	return nil
}

func mergeServers(servers []driver.CapabilityServer) []driver.CapabilityServer {
	merged := map[string]driver.CapabilityServer{}
	order := []string{}
	for _, server := range servers {
		name := strings.TrimSpace(server.Name)
		if name == "" {
			continue
		}
		server.Name = name
		if _, exists := merged[name]; !exists {
			order = append(order, name)
		}
		merged[name] = server
	}

	out := make([]driver.CapabilityServer, 0, len(order))
	for _, name := range order {
		out = append(out, merged[name])
	}
	return out
}

func copyStringMap(in map[string]string) map[string]string {
	if len(in) == 0 {
		return nil
	}
	out := make(map[string]string, len(in))
	for k, v := range in {
		out[k] = v
	}
	return out
}

func sortedKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}
