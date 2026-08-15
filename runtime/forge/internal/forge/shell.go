package forge

import (
	"runtime"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/lifecycle/shell"
)

const (
	shellTargetZsh        = "zsh"
	shellTargetPowerShell = "powershell"
)

// RunFDSHIfNeeded detects an fdsh invocation (basename or hidden marker) and
// dispatches to the Forge-owned DSH launcher before stable-launcher dispatch
// or public CLI parsing.
func RunFDSHIfNeeded() (int, bool) {
	return runFDSHIfNeeded()
}

// shellDSHCommand routes `forge shell dsh plan|exec` so the resolved DSH
// launch plan is inspectable; the hidden --forge-agent mode stays internal.
func shellDSHCommand(args []string) int {
	return runShellDSHCommand(args)
}

func buildShellInstallPlan(home string) (shellInstallPlan, error) {
	return buildShellInstallPlanFor(home, defaultShellInstallTarget())
}

func buildShellInstallPlanFor(home, targetShell string) (shellInstallPlan, error) {
	plan, err := shell.BuildInstallPlan(home, targetShell, shellDeps())
	return shellInstallPlan(plan), err
}

func defaultShellInstallTarget() string {
	if runtime.GOOS == "windows" {
		return shellTargetPowerShell
	}
	return shellTargetZsh
}

func shellPlanPayload(plan shellInstallPlan) map[string]interface{} {
	return shell.PlanPayload(plan)
}

func safeShellPlanDetails(plan shellInstallPlan) map[string]interface{} {
	return shell.SafePlanDetails(plan)
}

func shellDeps() shell.InstallDeps {
	return shell.InstallDeps{
		FunctionNames:           managedProfileFunctionNames,
		LoadManifest:            loadManifest,
		ProfileInstallsShortcut: profileInstallsShortcut,
		ResolveSecret:           resolveSecret,
		CurrentForgePath:        currentForgePath,
		ResolveCredential:       ResolveCredential,
		IsManagedProvider:       IsManagedProvider,
	}
}

type shellCCMigrationResult = shell.MigrationResult

func migrateShellCCClaudeState(home string) (shellCCMigrationResult, error) {
	result, err := shell.MigrateCCState(home)
	return shellCCMigrationResult(result), err
}
