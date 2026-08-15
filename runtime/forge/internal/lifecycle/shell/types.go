package shell

import "github.com/wrenyard/wrenyard/runtime/forge/internal/lifecycle/change"

// Profile is a neutral DTO that carries all profile data the shell
// rendering pipeline needs. The root package is responsible for
// converting root profile values into this DTO before calling shell
// functions.
type Profile struct {
	Name       string
	Client     string
	Provider   string
	SecretRef  *string
	Launcher   map[string]interface{}
	Env        map[string]string
	Settings   map[string]interface{}
	Supports1M bool
}

// Conflict describes an unmanaged shell shortcut that collides with a
// Forge-managed function name.
type Conflict struct {
	Name string `json:"name"`
	Kind string `json:"kind"`
	Line int    `json:"line"`
	Text string `json:"text"`
}

// InstallPlan is a neutral DTO for a shell install plan. It uses
// change.Plan directly (as required by the architecture spec).
type InstallPlan struct {
	ChangePlan         change.Plan
	Shell              string
	ManagedFile        string
	ProfilePath        string
	Zshrc              string
	Conflicts          []Conflict
	LegacyBlockFound   bool
	SourceBlockPresent bool
	Actions            []string
}

// MigrationResult captures the outcome of a Claude/CodeBuddy shell-CC
// state migration.
type MigrationResult struct {
	CopiedFiles int  `json:"copied_files"`
	SeededState bool `json:"seeded_state"`
}
