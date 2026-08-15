package driver

import (
	"encoding/json"
	"fmt"
	"io"
	"strings"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/catalog"
)

// MCPHTTPHeadersEnvVar is the environment variable for per-run HTTP MCP headers.
const MCPHTTPHeadersEnvVar = "FORGE_MCP_HTTP_HEADERS_JSON"

// ParseMCPHTTPHeaders parses the FORGE_MCP_HTTP_HEADERS_JSON env var value.
// The expected JSON shape is object keyed by resolved MCP server name, each
// value an object of HTTP header name to string value, for example:
//
//	{"ure":{"x-tai-identity":"...","X-URE-Profile":"internal-qa"}}
//
// Validation rejects malformed JSON, empty names, CR/LF in names or values,
// unknown server keys, and headers targeting non-HTTP MCP servers. Header
// values are never echoed in errors, summaries, argv, or logs.
func ParseMCPHTTPHeaders(raw string, knownServerNames []string) (map[string]map[string]string, error) {
	if strings.TrimSpace(raw) == "" {
		return nil, nil
	}

	known := make(map[string]bool, len(knownServerNames))
	for _, name := range knownServerNames {
		known[name] = true
	}

	var parsed map[string]map[string]interface{}
	if err := json.Unmarshal([]byte(raw), &parsed); err != nil {
		return nil, fmt.Errorf("invalid %s: malformed JSON", MCPHTTPHeadersEnvVar)
	}

	result := make(map[string]map[string]string, len(parsed))
	for serverName, headers := range parsed {
		if strings.ContainsAny(serverName, "\r\n") {
			return nil, fmt.Errorf("invalid %s: server name contains CR or LF", MCPHTTPHeadersEnvVar)
		}
		serverName = strings.TrimSpace(serverName)
		if serverName == "" {
			return nil, fmt.Errorf("invalid %s: empty server name", MCPHTTPHeadersEnvVar)
		}
		if !known[serverName] && len(knownServerNames) > 0 {
			return nil, fmt.Errorf("invalid %s: unknown server %q", MCPHTTPHeadersEnvVar, serverName)
		}
		if headers == nil {
			return nil, fmt.Errorf("invalid %s: server %q has nil headers", MCPHTTPHeadersEnvVar, serverName)
		}

		headerMap := make(map[string]string, len(headers))
		for hdrName, rawVal := range headers {
			if strings.ContainsAny(hdrName, "\r\n") {
				return nil, fmt.Errorf("invalid %s: header name for server %q contains CR or LF", MCPHTTPHeadersEnvVar, serverName)
			}
			hdrName = strings.TrimSpace(hdrName)
			if hdrName == "" {
				return nil, fmt.Errorf("invalid %s: empty header name for server %q", MCPHTTPHeadersEnvVar, serverName)
			}
			if strings.ContainsAny(hdrName, "\r\n") {
				return nil, fmt.Errorf("invalid %s: header name for server %q contains CR or LF", MCPHTTPHeadersEnvVar, serverName)
			}

			valStr, ok := rawVal.(string)
			if !ok {
				return nil, fmt.Errorf("invalid %s: header %q for server %q must be a string", MCPHTTPHeadersEnvVar, hdrName, serverName)
			}
			if strings.ContainsAny(valStr, "\r\n") {
				return nil, fmt.Errorf("invalid %s: header value for server %q contains CR or LF", MCPHTTPHeadersEnvVar, serverName)
			}
			headerMap[hdrName] = valStr
		}
		result[serverName] = headerMap
	}
	return result, nil
}

// CommandPlan is the compact, serializable result of planning a direct client
// invocation. It carries exactly the normalized fields the runner needs and
// nothing else: the resolved binary argv, the working directory, the isolated
// environment, the stdin prompt payload, the permission mode, and the
// runner-only transcript family. The runner uses TranscriptFamily to select the
// transcript normalization codec; the public ClientFamily reported to callers
// is independent and stays the resolved public family (codebuddy profiles keep
// claude publicly while normalizing transcripts with the codebuddy codec).
type CommandPlan struct {
	ProfileName string
	Dialect     catalog.Dialect
	Command     []string
	Env         map[string]string
	Stdin       io.Reader
	WorkDir     string
	ConfigDir   string
	Permission  catalog.PermissionMode
	Resources   []ExecutionResource
	// TranscriptFamily is the runner-only transcript normalization family,
	// independent of the public ClientFamily. Supported native families select
	// their own codec (codebuddy -> codebuddy) while the public family stays
	// claude; empty falls back to the public client family in the runner.
	TranscriptFamily string
}

// ExecutionResource is a generic child-lifecycle resource. Execution verifies
// that Path remains strictly below OwnershipRoot before recursive cleanup.
type ExecutionResource struct {
	Path               string
	OwnershipRoot      string
	RemoveOnSuccess    bool
	RemoveOnCompletion bool
}

// PreparedFile and PreparedCopy describe client-owned files to materialize in
// a fresh per-run home without exposing client-specific logic to execution.
type PreparedFile struct {
	RelativePath string
	Data         []byte
	Mode         uint32
}

type PreparedCopy struct {
	SourcePath   string
	RelativePath string
	Mode         uint32
	Sensitive    bool
}

// PreparedSensitiveSource identifies a readable credential source that the
// child must not be able to inspect. It deliberately carries only filesystem
// identity metadata; credential values never cross this boundary.
type PreparedSensitiveSource struct {
	Path string
}

// RuntimePreparation is a generic fresh-home materialization descriptor built
// by the composition root from catalog/provider/auth state.
type RuntimePreparation struct {
	HomeParent       string
	HomeEnvVar       string
	Env              map[string]string
	SensitiveEnvKeys []string
	SensitiveSources []PreparedSensitiveSource
	Files            []PreparedFile
	Copies           []PreparedCopy
}

// ProfileSpec is the boundary DTO holding only the normalized data the driver
// needs from the root-loaded profile/resolver. It deliberately avoids any
// dependency on the root forge or profile packages so the planning layer stays
// self-contained and side-effect free with respect to secret resolution.
type ProfileSpec struct {
	// Raw fields carried through unchanged from the root profile.
	Name         string
	Client       string
	ProviderName string
	Launcher     map[string]interface{}
	Env          map[string]string
	Settings     map[string]interface{}
	Supports1M   bool

	// Resolved catalog data. When UseCatalog is false the profile resolved
	// through a compatibility path and the driver must use legacy construction
	// driven only by the raw fields above.
	UseCatalog bool
	ClientDesc catalog.Client
	Provider   catalog.Provider

	// Resolved credential overlay (target env + value). Value is sensitive and
	// must never be formatted into errors or logs.
	CredentialTarget string
	CredentialValue  string

	// ForgeDataDir is the resolved forge data directory used to locate the
	// isolated CC config/job directories.
	ForgeDataDir string
	Runtime      RuntimePreparation
}

// PlanRequest is the single input to BuildPlan: a normalized profile spec plus
// the per-invocation runtime inputs. BuildPlan owns the sole Dialect switch and
// dispatches to the family planners; no family selection happens in callers.
type PlanRequest struct {
	Spec            ProfileSpec
	Prompt          string
	WorkDir         string
	ResumeSessionID string
	Clean           bool
	Permission      catalog.PermissionMode

	// Capabilities is the list of requested capability pack names (already
	// validated by the caller). It is empty when no capability injection is
	// requested.
	Capabilities []string
	// ResolveCapabilities resolves capability names into driver capability
	// server data. It is nil-safe; family finalizers only resolve when
	// Capabilities is non-empty. The driver owns all command mutation.
	ResolveCapabilities CapabilityResolver
	// MCPHTTPHeaders is an optional map of MCP server name to HTTP header
	// entries. Keys are resolved MCP server names; values are header name to
	// string value. Only HTTP URL MCP servers receive headers. The map is
	// populated from the FORGE_MCP_HTTP_HEADERS_JSON env var, validated
	// before Grok launch, and never echoed in argv, logs, or errors.
	MCPHTTPHeaders map[string]map[string]string
}

// BuildPlan plans a direct client invocation for the given request. It performs
// no filesystem side effects beyond directory creation required by the selected
// family planner (e.g. CC config/job dirs), and never reads the root manifest
// or resolves credentials itself. Family selection happens here exclusively via
// the catalog.Dialect switch. The selected family planner finalizes capability
// injection before returning the CommandPlan.
func BuildPlan(req PlanRequest) (CommandPlan, error) {
	spec := req.Spec
	switch spec.ClientDesc.Dialect {
	case catalog.DialectClaudeCode, catalog.DialectCodeBuddy:
		return buildClaudeCodePlan(req)
	case catalog.DialectCodex:
		return buildCodexPlan(req)
	case catalog.DialectOpenCode:
		return buildOpenCodePlan(req)
	case catalog.DialectGrok:
		return buildGrokPlan(req)
	case catalog.DialectDSH:
		return buildDSHPlan(req)
	default:
		return CommandPlan{}, catalogDialectError(spec)
	}
}

// Parser is the log-parsing boundary used by the runner to extract session ids
// and results from a client transcript.
type Parser interface {
	ParseSessionID(logPath string) (string, error)
	ParseResult(logPath string) (string, error)
}

// ParserForDialect returns the concrete log parser for the given dialect.
func ParserForDialect(dialect catalog.Dialect) Parser {
	switch dialect {
	case catalog.DialectClaudeCode, catalog.DialectCodeBuddy:
		return &ClaudeAdapter{}
	case catalog.DialectCodex:
		return &CodexAdapter{}
	case catalog.DialectOpenCode:
		return &OpenCodeAdapter{}
	case catalog.DialectGrok:
		return &GrokAdapter{}
	case catalog.DialectDSH:
		return &DSHAdapter{}
	default:
		return nil
	}
}
