// Package catalog owns the static client and provider capability catalog.
package catalog

import "github.com/wrenyard/wrenyard/runtime/forge/internal/providers/schema"

// Dialect is shared with provider modules so catalog registration stays acyclic.
type Dialect = schema.Dialect

const (
	DialectClaudeCode = schema.DialectClaudeCode
	DialectCodeBuddy  = schema.DialectCodeBuddy
	DialectCodex      = schema.DialectCodex
	DialectOpenCode   = schema.DialectOpenCode
	DialectGrok       = schema.DialectGrok
	DialectDSH        = schema.DialectDSH
)

// DSH-specific client and transcript constants. They are distinct from the
// CodeBuddy and Grok families; the DSH transcript family is its own codec.
const (
	// EnvDSHModel is the environment variable carrying the canonical
	// provider/model value to the DSH client.
	EnvDSHModel = "DSH_MODEL"
	// TranscriptFamilyDSH is the transcript family for DSH client sessions.
	TranscriptFamilyDSH = "dsh"
)

// BinarySpec describes how to locate and invoke the client binary.
type BinarySpec struct {
	// Name is the primary binary name (e.g. "claude", "codebuddy").
	Name string
	// WindowsCmd is the .cmd shim name on Windows (e.g. "codebuddy.cmd").
	// Empty means the primary Name works as-is on all platforms.
	WindowsCmd string
	// NodeEntry is the path relative to the npm global prefix for node-based
	// binaries (e.g. "node_modules/@tencent-ai/codebuddy-code/bin/codebuddy").
	// When set, resolution prefers ["node", "<npm_prefix>/<NodeEntry>"] over
	// LookPath, avoiding corrupt .cmd shims.
	NodeEntry string
}

// ConfigIsolation describes the env-var and directory strategy for config
// isolation.
type ConfigIsolation struct {
	// EnvVar is the environment variable that controls the config directory
	// (e.g. "CLAUDE_CONFIG_DIR", "CODEBUDDY_CONFIG_DIR").
	EnvVar string
	// PersistentDir is a path segment relative to the forge data dir for a
	// persistent config directory. Empty means no persistent dir.
	PersistentDir string
}

// DialectFlags records which dialect-level flags this binary supports.
type DialectFlags struct {
	SupportsVerbose             bool
	SupportsBare                bool
	SupportsReplayUserMessages  bool
	SupportsDevelopmentChannels bool
}

const (
	ResumeFlagLong = "--resume"
)

// PermissionMode is the canonical Forge permission taxonomy.
type PermissionMode string

const (
	PermissionReadonly PermissionMode = "readonly"
	PermissionEdit     PermissionMode = "edit"
	PermissionYolo     PermissionMode = "yolo"
)

// Client describes a client: what binary, what dialect, and how to configure it.
type Client struct {
	// Name is the client identifier used in profiles.json (e.g. "claude",
	// "codebuddy").
	Name string
	// Dialect determines which parser/runner machinery to reuse.
	Dialect Dialect
	// Binary describes how to locate and invoke the client.
	Binary BinarySpec
	// ConfigIsolation describes env-var and directory strategy.
	ConfigIsolation ConfigIsolation
	// PermissionAdapter selects how this client consumes the central Forge
	// permission policy.
	PermissionAdapter PermissionAdapter
	// DialectFlags records supported dialect-level flags.
	DialectFlags DialectFlags
	// TranscriptFamily is the runner transcript family used when a client
	// owns a dedicated transcript codec. Empty means the runtime resolves
	// the family from the client name.
	TranscriptFamily string
	// Hygiene is a list of env vars (KEY=VALUE) injected for unattended runs.
	Hygiene []string
	// ResumeFlag is the native flag used to resume a session.
	ResumeFlag string
	// DefaultProvider is the Provider name used when a profile omits one.
	DefaultProvider string
}

// BuildPermissionArgs returns the CLI argument slice for the given permission
// mode on this client. Native clients such as Codex return no tool flags.
func (c Client) BuildPermissionArgs(mode PermissionMode) []string {
	return EncodePermissionArgs(c.PermissionAdapter, mode)
}

// FilterFlags filters a flag list by dropping entries that are not supported
// by this client's DialectFlags. Unsorted entries appear in the result in their
// original order.
func (c Client) FilterFlags(flags []string) []string {
	var result []string
	for _, f := range flags {
		switch f {
		case "--verbose":
			if c.DialectFlags.SupportsVerbose {
				result = append(result, f)
			}
		case "--bare":
			if c.DialectFlags.SupportsBare {
				result = append(result, f)
			}
		case "--replay-user-messages":
			if c.DialectFlags.SupportsReplayUserMessages {
				result = append(result, f)
			}
		default:
			result = append(result, f)
		}
	}
	return result
}
