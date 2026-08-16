package shell

import "github.com/wrenyard/wrenyard/runtime/forge/internal/profiles/manifest"

type InstallDeps struct {
	FunctionNames           func() []string
	LoadManifest            func() (manifest.Manifest, error)
	ProfileInstallsShortcut func(manifest.Profile) bool
	ResolveSecret           func(*string) (*string, error)
	CurrentForgePath        func() (string, error)
	ResolveCredential       func(string) (string, bool)
	IsManagedProvider       func(string) bool
}

func BuildInstallPlan(home, targetShell string, deps InstallDeps) (InstallPlan, error) {
	funcNames := deps.FunctionNames()
	m, _ := deps.LoadManifest()
	profiles := profilesFromManifest(m.Profiles, deps)
	// conflictNames extends funcNames with the fgrok entry point so that
	// PlanZsh/PlanPowerShell can detect an existing user fgrok alias/function
	// without treating fgrok as a profile.
	conflictNames := make([]string, len(funcNames), len(funcNames)+1)
	copy(conflictNames, funcNames)
	conflictNames = append(conflictNames, grokFunctionName)
	if targetShell == "powershell" {
		// PowerShell and Grok output are built with the public Wrenyard
		// launcher name; the retired stable Forge launcher path is never
		// resolved or embedded.
		launcher := "wrenyard"
		managed := RenderManagedPowerShell(profiles, funcNames, launcher, deps.ResolveCredential, deps.IsManagedProvider)
		managed += "\n" + RenderGrokPowerShell(launcher)
		return PlanPowerShell(home, managed, conflictNames)
	}
	managed, err := RenderManagedZsh(profiles, funcNames, deps.ResolveCredential, deps.IsManagedProvider)
	if err != nil {
		return InstallPlan{}, err
	}
	managed += "\n" + RenderGrokZsh()
	return PlanZsh(home, managed, conflictNames)
}

func RenderManagedShellFile(deps InstallDeps) (string, error) {
	return RenderManagedShellFileFor(deps, deps.FunctionNames())
}

func RenderManagedShellFileFor(deps InstallDeps, funcNames []string) (string, error) {
	m, _ := deps.LoadManifest()
	return RenderManagedZsh(profilesFromManifest(m.Profiles, deps), funcNames, deps.ResolveCredential, deps.IsManagedProvider)
}

func RenderManagedPowerShellFile(deps InstallDeps, funcNames []string, forgeBin string) string {
	m, _ := deps.LoadManifest()
	return RenderManagedPowerShell(profilesFromManifest(m.Profiles, deps), funcNames, forgeBin, deps.ResolveCredential, deps.IsManagedProvider)
}

func ModelOverridesFromManifest(p manifest.Profile) map[string]string {
	return ModelOverrides(profileFromManifest(p))
}

func profilesFromManifest(profiles map[string]manifest.Profile, deps InstallDeps) map[string]Profile {
	out := make(map[string]Profile, len(profiles))
	for name, p := range profiles {
		if deps.ProfileInstallsShortcut != nil && !deps.ProfileInstallsShortcut(p) {
			continue
		}
		sp := profileFromManifest(p)
		if sp.Name == "" {
			sp.Name = name
		}
		if p.SecretRef != nil && deps.ResolveSecret != nil {
			if resolved, err := deps.ResolveSecret(p.SecretRef); err == nil && resolved != nil {
				sp.Env = copyEnvWith(p.Env, "ANTHROPIC_API_KEY", *resolved)
			}
		}
		out[name] = sp
	}
	return out
}

func profileFromManifest(p manifest.Profile) Profile {
	return Profile{
		Name: p.Name, Client: p.Client, Provider: p.Provider, SecretRef: p.SecretRef,
		Launcher: p.Launcher, Env: p.Env, Settings: p.Settings, Supports1M: p.Supports1M,
	}
}

func copyEnvWith(orig map[string]string, key, value string) map[string]string {
	out := make(map[string]string, len(orig)+1)
	for k, v := range orig {
		out[k] = v
	}
	out[key] = value
	return out
}
