package forge

import (
	"os"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/lifecycle/install"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/profiles/config"
)

func updateCommand(args []string) int {
	ctx := install.UpdateCommandContext{
		Home: userHome(), Args: args, Assets: makeInstallAssets(), Deps: makeInstallDeps(),
	}
	return install.UpdateCommand(ctx)
}

func setupCommand(args []string) int {
	return install.SetupCommand(install.SetupCommandContext{
		Home: userHome(), Args: args, Assets: makeInstallAssets(), Deps: makeInstallDeps(),
	})
}

func RunStableLauncherIfNeeded() (int, bool) {
	return install.RunStableLauncherIfNeeded(userHome())
}

func makeInstallAssets() install.Assets {
	return install.Assets{
		EmbeddedConfig: config.EmbeddedData(),
	}
}

func makeInstallDeps() install.Dependencies {
	return install.Dependencies{
		Version:                func() string { return version },
		RepoDir:                repoDir,
		UserHome:               userHome,
		MigrateAuthFromSecrets: MigrateAuthFromSecrets,
		ApplyPlan:              makeApplyPlan,
		BuildShellInstallPlan:  makeShellPlan,
		ShellPlanPayload:       makeShellPayload,
		MigrateShellCCState:    makeShellCCMigrate,
		BuildDoctorReport:      buildDoctorReport,
		ReadSecretsFile:        readSecretsFile,
		InjectGeneratedFrom:    func(data []byte) []byte { return install.InjectGeneratedFrom(data, version) },
		Redact:                 redact,
	}
}

func makeApplyPlan(rawPlan interface{}, dryRun bool) (install.ApplyPlanResult, error) {
	cp, ok := rawPlan.(changePlan)
	if !ok {
		return install.ApplyPlanResult{}, os.ErrInvalid
	}
	r := applyPlan(cp, dryRun)
	return install.ApplyPlanResult{Succeeded: r.Succeeded, Entries: r.Entries, JournalPath: r.JournalPath}, nil
}

func makeShellPlan(home, target string) (install.ShellInstallPlan, error) {
	bp, err := buildShellInstallPlanFor(home, target)
	if err != nil {
		return install.ShellInstallPlan{}, err
	}
	out := install.ShellInstallPlan{ProfilePath: bp.ProfilePath, Actions: bp.Actions, ChangePlan: bp.ChangePlan}
	for _, c := range bp.Conflicts {
		out.Conflicts = append(out.Conflicts, install.ShellConflict{Line: c.Line, Kind: c.Kind, Name: c.Name})
	}
	return out, nil
}

func makeShellPayload(p install.ShellInstallPlan) map[string]interface{} {
	bp := shellInstallPlan{ProfilePath: p.ProfilePath, Actions: p.Actions}
	for _, c := range p.Conflicts {
		bp.Conflicts = append(bp.Conflicts, shellConflict{Line: c.Line, Kind: c.Kind, Name: c.Name})
	}
	if cp, ok := p.ChangePlan.(changePlan); ok {
		bp.ChangePlan = cp
	}
	return shellPlanPayload(bp)
}

func makeShellCCMigrate(home string) (install.ShellCCMigrationResult, error) {
	m, err := migrateShellCCClaudeState(home)
	return install.ShellCCMigrationResult{CopiedFiles: m.CopiedFiles, SeededState: m.SeededState}, err
}
