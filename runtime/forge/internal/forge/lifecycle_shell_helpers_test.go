package forge

import (
	"path/filepath"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/lifecycle/shell"
)

func isWrapperProfile(p profile) bool { return false }

func managedShortcutUsesWrapper(funcNames []string) bool { return false }

func shellDaemonCheck(funcNames []string) ([]planAction, []string, error) {
	return nil, nil, nil
}

func renderManagedShellFile() (string, error) {
	return shell.RenderManagedShellFile(shellDeps())
}

func renderManagedShellFileFor(funcNames []string) (string, error) {
	return shell.RenderManagedShellFileFor(shellDeps(), funcNames)
}

func renderManagedPowerShellFile(funcNames []string, forgeBin string) string {
	return shell.RenderManagedPowerShellFile(shellDeps(), funcNames, forgeBin)
}

func removePowerShellSourceBlocks(content string) (string, bool) {
	return shell.RemovePowerShellSourceBlocks(content)
}

func removePowerShellLegacySourceBlocks(content string) (string, bool) {
	return shell.RemovePowerShellLegacySourceBlocks(content)
}

func appendPowerShellSourceBlock(content string) string {
	return shell.AppendPowerShellSourceBlock(content)
}

func powershellProfilePathForHome(home string) string {
	return shell.PowerShellProfilePathForHome(home)
}

func forgeConfigDir() string {
	return userConfigDir()
}

func powershellManagedFilePath() string {
	return filepath.Join(forgeConfigDir(), "shell", "forge.ps1")
}

func toShellProfiles(profiles map[string]profile) map[string]shell.Profile {
	out := make(map[string]shell.Profile, len(profiles))
	for name, p := range profiles {
		if !profileInstallsShortcut(p) {
			continue
		}
		sp := shell.Profile{
			Name: p.Name, Client: p.Client, Provider: p.Provider, SecretRef: nil,
			Launcher: p.Launcher, Env: p.Env, Settings: p.Settings, Supports1M: p.Supports1M,
		}
		if p.SecretRef != nil {
			if resolved, err := resolveSecret(p.SecretRef); err == nil && resolved != nil {
				sp.Env = copyEnvWith(p.Env, "ANTHROPIC_API_KEY", *resolved)
			}
		}
		out[name] = sp
	}
	return out
}

func claudeModelOverrides(p profile) map[string]string {
	return shell.ModelOverridesFromManifest(p)
}

func copyEnvWith(orig map[string]string, key, value string) map[string]string {
	out := make(map[string]string, len(orig)+1)
	for k, v := range orig {
		out[k] = v
	}
	out[key] = value
	return out
}

func daemonClientMarkers() []string { return nil }

func shellCCRootForHome(home string) string { return shell.CCRootForHome(home) }

func shellCCConfigDirForHome(home string) string { return shell.CCConfigDirForHome(home) }

func forgeDataHomeForHome(home string) string { return shell.DataHomeForHome(home) }
