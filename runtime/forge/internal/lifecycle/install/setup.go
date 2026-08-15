package install

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/health/doctor"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/lifecycle/layout"
)

// SetupCommandContext holds all context needed for the setup pipeline.
type SetupCommandContext struct {
	Home   string
	Args   []string
	Assets Assets
	Deps   Dependencies
}

// SetupCommand runs the setup pipeline (self-install, shell integration, and
// doctor). Provider API keys are managed exclusively through auth.json by the
// providers auth commands; setup never imports legacy secret sources.
func SetupCommand(ctx SetupCommandContext) int {
	selfInstall := hasSetupFlag(ctx.Args, "--self-install")

	ok := true
	steps := []struct {
		name string
		fn   func() bool
	}{
		{"self-install binary", func() bool { return stepSelfInstall(ctx, selfInstall) }},
		{"install shell integration", func() bool { return stepShellIntegration(ctx) }},
	}

	for _, step := range steps {
		fmt.Printf("forge setup: %s...\n", step.name)
		if !step.fn() {
			ok = false
		}
	}

	fmt.Println("forge setup: run doctor...")
	doctorOK := stepDoctor(ctx)
	if !doctorOK {
		ok = false
	}

	if ok {
		fmt.Println("Forge setup complete.")
		return 0
	}
	return 1
}

// StepSelfInstall is the exported thin wrapper around stepSelfInstall.
func StepSelfInstall(ctx SetupCommandContext, force bool) bool {
	return stepSelfInstall(ctx, force)
}

// StepShellIntegration is the exported thin wrapper around stepShellIntegration.
func StepShellIntegration(ctx SetupCommandContext) bool {
	return stepShellIntegration(ctx)
}

// StepMigrateAuth is the exported thin wrapper around stepMigrateAuth.
func StepMigrateAuth(ctx SetupCommandContext) bool {
	return stepMigrateAuth(ctx)
}

// StepDoctor is the exported thin wrapper around stepDoctor.
func StepDoctor(ctx SetupCommandContext) bool {
	return stepDoctor(ctx)
}

func stepSelfInstall(ctx SetupCommandContext, force bool) bool {
	lp := layout.NewPaths(ctx.Home)
	if !force && lp.StableForgeLauncherReady() {
		current := strings.TrimSpace(readTextIfExists(lp.CurrentPointerPath()))
		if current != "" {
			if info, err := os.Stat(current); err == nil && info.Mode().IsRegular() {
				if _, _, err := EnsureStableFDSHLauncher(ctx.Home, current); err != nil {
					fmt.Fprintf(os.Stderr, "  error: ensure stable fdsh launcher: %v\n", err)
					return false
				}
				fmt.Println("  versioned install already current")
				return true
			}
		}
	}

	exe, err := os.Executable()
	if err != nil {
		fmt.Fprintf(os.Stderr, "  error: resolve executable: %v\n", err)
		return false
	}
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}

	targetVersion := ""
	if ctx.Deps.Version != nil {
		targetVersion = ctx.Deps.Version()
	}

	// Forced installs go through the idempotent versioned update seam so
	// repeated recovery runs do not create duplicate version slots.
	if force {
		if err := UpdateVersionedInstallVersion(ctx.Home, exe, targetVersion); err != nil {
			fmt.Fprintf(os.Stderr, "  error: %v\n", err)
			return false
		}
		return true
	}

	result, err := InstallBuiltForgeBinaryVersion(ctx.Home, exe, targetVersion, time.Now().UTC())
	if err != nil {
		fmt.Fprintf(os.Stderr, "  error: %v\n", err)
		return false
	}

	fmt.Printf("  installed %s\n", result.VersionPath)
	if result.StableLauncherDeferredPath != "" {
		fmt.Fprintf(os.Stderr, "  stable launcher locked; wrote replacement to %s. Stop running forge processes and replace %s with it.\n",
			result.StableLauncherDeferredPath, result.StableLauncherPath)
	}
	return true
}

func stepShellIntegration(ctx SetupCommandContext) bool {
	if ctx.Deps.BuildShellInstallPlan == nil {
		return true
	}
	return InstallShellWrappers(ctx, nil, false) == 0
}

func stepDoctor(ctx SetupCommandContext) bool {
	if ctx.Deps.BuildDoctorReport == nil {
		return true
	}
	report := ctx.Deps.BuildDoctorReport("")
	checks, ok := report["checks"].([]map[string]interface{})
	if !ok {
		fmt.Println("  doctor: unexpected report format")
		return false
	}
	summary := map[string]int{"ok": 0, "warning": 0, "error": 0}
	for _, check := range checks {
		status := fmt.Sprint(check["status"])
		summary[status]++
		for _, line := range doctor.FormatCheckLines(check) {
			fmt.Printf("  %s\n", line)
		}
	}
	fmt.Printf("  summary: %d ok, %d warning, %d error\n", summary["ok"], summary["warning"], summary["error"])
	return summary["error"] == 0
}

func stepMigrateAuth(ctx SetupCommandContext) bool {
	if ctx.Deps.MigrateAuthFromSecrets == nil {
		fmt.Println("  auth migration not available")
		return true
	}
	migrated, err := ctx.Deps.MigrateAuthFromSecrets()
	if err != nil {
		fmt.Fprintf(os.Stderr, "  error: auth migration: %v\n", err)
		return true
	}
	if len(migrated) == 0 {
		fmt.Println("  no credentials to migrate (all already migrated)")
	} else {
		fmt.Printf("  migrated %d credential(s) to auth.json: %s\n", len(migrated), strings.Join(migrated, ", "))
	}
	return true
}

// --- Shell integration (inline) ---

func InstallShellWrappers(ctx SetupCommandContext, args []string, asJSON bool) int {
	deps := ctx.Deps
	if deps.BuildShellInstallPlan == nil {
		return 0
	}
	shell, err := parseInstallShellTarget(args)
	if err != nil {
		if asJSON {
			printJSON(map[string]interface{}{"name": "forge-install-shell", "succeeded": false, "error": err.Error()})
		} else {
			fmt.Fprintln(os.Stderr, err)
		}
		return 2
	}
	plan, err := deps.BuildShellInstallPlan(ctx.Home, shell)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	payload := deps.ShellPlanPayload(plan)
	if len(plan.Conflicts) > 0 {
		if asJSON {
			printJSON(payload)
		} else {
			fmt.Fprintln(os.Stderr, "forge setup: unmanaged shell conflicts detected")
			for _, conflict := range plan.Conflicts {
				fmt.Fprintf(os.Stderr, "  %s:%d: %s %s\n", plan.ProfilePath, conflict.Line, conflict.Kind, conflict.Name)
			}
		}
		return 2
	}
	if deps.ApplyPlan == nil {
		payload["succeeded"] = false
		if asJSON {
			printJSON(redactWithDeps(deps, payload))
		}
		return 2
	}
	result, err := deps.ApplyPlan(plan.ChangePlan, false)
	if err != nil {
		payload["succeeded"] = false
		if asJSON {
			printJSON(redactWithDeps(deps, payload))
		} else {
			fmt.Fprintln(os.Stderr, err)
		}
		return 1
	}
	payload["succeeded"] = result.Succeeded
	payload["entries"] = withoutEntryFileContent(result.Entries)
	payload["journal_path"] = unwrapJournalPath(result.JournalPath)
	migration := ShellCCMigrationResult{}
	var migrationErr error
	if result.Succeeded {
		if deps.MigrateShellCCState != nil {
			migration, migrationErr = deps.MigrateShellCCState(ctx.Home)
		}
		payload["shell_cc_state"] = migration
		if migrationErr != nil {
			payload["succeeded"] = false
			payload["shell_cc_state_error"] = migrationErr.Error()
		} else if migration.CopiedFiles > 0 {
			plan.Actions = append(plan.Actions, "migrate Claude Code session state")
		} else if migration.SeededState {
			plan.Actions = append(plan.Actions, "seed Claude Code onboarding state")
		}
	}
	if asJSON {
		printJSON(redactWithDeps(deps, payload))
	} else if len(plan.Actions) == 0 {
		fmt.Println("shell shortcuts already installed")
	} else {
		for _, action := range plan.Actions {
			fmt.Println(action)
		}
	}
	if migrationErr != nil {
		if !asJSON {
			fmt.Fprintln(os.Stderr, migrationErr)
		}
		return 1
	}
	if result.Succeeded {
		return 0
	}
	return 1
}

func redactWithDeps(deps Dependencies, payload map[string]interface{}) interface{} {
	if deps.Redact != nil {
		return deps.Redact(payload)
	}
	return payload
}

func printJSON(value interface{}) int {
	content, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	fmt.Println(string(content))
	return 0
}

func parseInstallShellTarget(args []string) (string, error) {
	usePowerShell := hasFlag(args, "--powershell")
	useZsh := hasFlag(args, "--zsh")
	if usePowerShell && useZsh {
		return "", fmt.Errorf("forge setup: specify only one of --powershell or --zsh")
	}
	if usePowerShell {
		return "powershell", nil
	}
	if useZsh {
		return "zsh", nil
	}
	if os.PathSeparator == '\\' {
		return "powershell", nil
	}
	return "zsh", nil
}

func hasFlag(args []string, flag string) bool {
	for _, arg := range args {
		if arg == flag {
			return true
		}
	}
	return false
}

func hasSetupFlag(args []string, flag string) bool {
	return hasFlag(args, flag)
}

func unwrapJournalPath(jp *string) string {
	if jp == nil {
		return ""
	}
	return *jp
}

// --- Helpers ---

func withoutEntryFileContent(entries []map[string]interface{}) []map[string]interface{} {
	cleaned := make([]map[string]interface{}, 0, len(entries))
	for _, source := range entries {
		entry := map[string]interface{}{}
		for key, value := range source {
			entry[key] = value
		}
		if action, ok := entry["action"].(map[string]interface{}); ok {
			copyAction := map[string]interface{}{}
			for key, value := range action {
				if key != "content" {
					copyAction[key] = value
				}
			}
			entry["action"] = copyAction
		}
		cleaned = append(cleaned, entry)
	}
	return cleaned
}
