package install

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
)

// InstallResult captures the outcome of installing a built binary into the
// versioned layout.
type InstallResult struct {
	VersionID                      string
	VersionPath                    string
	StableLauncherPath             string
	StableLauncherDeferredPath     string
	StableFDSHLauncherPath         string
	StableFDSHLauncherDeferredPath string
}

// Assets bundles the embedded data the install lifecycle needs without
// importing the root forge package.
type Assets struct {
	EmbeddedConfig []byte
}

// Dependencies bundles the explicit callbacks the install lifecycle needs
// so the package never imports the root forge package. Every callback that
// used to call into the root package is wired here.
type Dependencies struct {
	// Version returns the current forge version string.
	Version func() string
	// RepoDir returns the repo directory or an error.
	RepoDir func() (string, error)
	// UserHome returns the current user's home directory.
	UserHome func() string
	// MigrateAuthFromSecrets copies legacy secrets.json entries into auth.json.
	MigrateAuthFromSecrets func() ([]string, error)
	// ApplyPlan executes a change.Plan with the given dryRun flag.
	ApplyPlan func(plan interface{}, dryRun bool) (ApplyPlanResult, error)
	// BuildShellInstallPlan builds a shell-install plan for the given home and target shell.
	BuildShellInstallPlan func(home string, targetShell string) (ShellInstallPlan, error)
	// ShellPlanPayload converts an install plan to a JSON-serializable payload map.
	ShellPlanPayload func(plan ShellInstallPlan) map[string]interface{}
	// MigrateShellCCState performs the shell CC state migration.
	MigrateShellCCState func(home string) (ShellCCMigrationResult, error)
	// BuildDoctorReport builds a doctor check report for the given target.
	BuildDoctorReport func(target string) map[string]interface{}
	// ReadSecretsFile reads a JSON secrets file and returns the flat key-value map.
	ReadSecretsFile func(path string) map[string]interface{}
	// InjectGeneratedFrom adds a _generated_from field to JSON bytes.
	InjectGeneratedFrom func(data []byte) []byte
	// Redact scrubs sensitive values from a JSON-serializable payload.
	Redact func(v interface{}) interface{}
}

// ApplyPlanResult mirrors change.Result (without importing the change package).
type ApplyPlanResult struct {
	Succeeded   bool
	Entries     []map[string]interface{}
	JournalPath *string
}

// ShellInstallPlan mirrors the shape of a shell install plan.
type ShellInstallPlan struct {
	ProfilePath string
	Actions     []string
	Conflicts   []ShellConflict
	ChangePlan  interface{} // opaque; passed through to ApplyPlan
}

// ShellConflict mirrors a shell conflict entry.
type ShellConflict struct {
	Line int
	Kind string
	Name string
}

// ShellCCMigrationResult mirrors the shell CC state migration result.
type ShellCCMigrationResult struct {
	CopiedFiles int
	SeededState bool
}

// FileSHA256Prefix returns the first prefix hex characters of a file's SHA-256.
func FileSHA256Prefix(path string, prefix int) (string, error) {
	content, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(content)
	encoded := hex.EncodeToString(sum[:])
	if prefix > len(encoded) {
		prefix = len(encoded)
	}
	return encoded[:prefix], nil
}
