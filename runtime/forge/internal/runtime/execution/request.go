package execution

import (
	"context"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/catalog"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/driver"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/profile"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/protocol"
)

// Request is the self-contained execution request. It carries exactly the
// normalized per-invocation inputs the execution boundary needs and nothing
// else. The root CLI builds one from its flag parsing and hands it to Run or
// Execute; the boundary never reads the manifest directly.
type Request struct {
	// Selector distinguishes exact-profile execution from an ordered policy
	// snapshot. Empty retains exact-profile compatibility for direct callers.
	Selector         string
	ProfileName      string
	PolicyName       string
	PolicyCandidates []string
	Prompt           string
	WorkDir          string
	Permission       catalog.PermissionMode
	Format           protocol.OutputFormat
	ResumeID         string
	Clean            bool
	Capabilities     []string
	MCPHTTPHeaders   map[string]map[string]string
	Context          context.Context
}

// ProfileDefinition carries the raw loaded profile fields the execution
// boundary needs to run the client/MCP/profile.Resolve/driver
// pipeline. It is a minimal, behavior-preserving snapshot of a root manifest
// profile and intentionally avoids any root-provider types so execution stays
// import-clean with respect to the root forge package.
type ProfileDefinition struct {
	Name         string
	Client       string
	Provider     string
	SecretRef    *string
	Launcher     map[string]interface{}
	Env          map[string]string
	Settings     map[string]interface{}
	Capabilities []string
	Supports1M   bool
	Deprecated   bool
	Reason       string
}

// Dependencies injects the minimal root-side callbacks/values the execution
// boundary needs. This keeps execution import-clean (catalog/profile/driver/
// protocol/stdlib only) while preserving the exact current behavior, side
// effect order, and error text.
type Dependencies struct {
	// LoadProfile loads the named profile definition, returning found=false
	// when the profile does not exist (mirroring "profile %q not found").
	LoadProfile func(name string) (ProfileDefinition, bool, error)
	// ClientEnabled reports whether the named client is enabled in config
	// (true when load fails, matching current IsClientEnabled fallback).
	ClientEnabled func(client string) bool
	// ResolveProfile resolves a loaded profile definition through the profile
	// package against the current catalog, returning a ResolvedProfile.
	ResolveProfile func(def ProfileDefinition) (profile.ResolvedProfile, error)
	// PrepareRuntime builds a generic per-run materialization descriptor after
	// profile/auth resolution and before driver planning. Nil means no files.
	PrepareRuntime func(def ProfileDefinition, resolved profile.ResolvedProfile) (driver.RuntimePreparation, error)
	// DataDir is the resolved forge data directory.
	DataDir string
	// ResolveCapabilities resolves capability pack names into driver capability
	// server data. It performs only resolution; the driver owns all command
	// mutation. It is nil-safe when no capabilities are requested.
	ResolveCapabilities driver.CapabilityResolver

	// The following seams govern only resilience behavior. Nil values use
	// production defaults; they do not alter planning, permissions, or prompt
	// construction.
	Clock     Clock
	Sleeper   Sleeper
	StateRoot string
	JitterFn  JitterFn
	Runner    ChildRunner
}
