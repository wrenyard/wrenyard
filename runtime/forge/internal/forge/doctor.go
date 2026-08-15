package forge

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/health/doctor"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/lifecycle/shell"
)

func newDoctorDeps() doctor.Dependencies {
	return doctor.Dependencies{
		Exists: exists, UserHome: userHome, ReadFile: os.ReadFile, ReadText: readTextIfExists,
		ExpandHome: expandHome, RepoDir: repoDir,
		LocalAppData:    os.Getenv("LOCALAPPDATA"),
		LoadForgeConfig: LoadForgeConfig, LoadManifest: loadManifestAsDTO,
		ManifestSources: manifestSources,
		UserSecretsPath: userSecretsPath(), UserConfigPath: userConfigPath(),
		AuthPath: authPath(),
		ReadAuth: readAuthAsInterface, AuthPermsOK: AuthPermsOK,
		ResolveCredential: ResolveCredential, ReadSecretsFile: readSecretsFile,
		SecretsFilePermsOK: secretsFilePermsOK, ProviderSources: providerSources,
		CatalogRegistry: catalogRegistryOrDefault(),
		ClientInstalled: clientInstalled,
		ClientKnown: func(clientID string) bool {
			_, err := catalogRegistryOrDefault().LookupDescriptor(clientID)
			return err == nil
		},
		ClientIDs:                   func() []string { return catalogRegistryOrDefault().ClientNames() },
		IsAliasShortcutClient:       clientEmitsAliasShortcut,
		IsCCShortcutProvider:        providerSupportsCCShortcut,
		ProviderCredentialAvailable: providerCredentialAvailableAsCallback,
		BuildShellPlan:              buildShellPlanAsInterface, ShellHasConflicts: shellPlanHasConflicts,
		ShellHasActions: shellPlanHasActions, SafeShellPlanDetails: safeShellPlanDetailsAsInterface,
		GetStringSlice:    stringSliceField,
		CodebuddyShimPath: codebuddyShimPath,
		ProviderAuthStatus: func(providerID string) doctor.ProviderAuthState {
			status := providerAuthStatus(providerID)
			return doctor.ProviderAuthState{OK: status.OK, SourcePath: status.SourcePath}
		},
		ResolveSecretRef:    resolveSecret,
		GrokBinaryInstalled: grokBinaryInstalled,
		DSHCheck:            dshCLIDoctorCheck,
	}
}

func doctorCommand(args []string) int {
	target := ""
	asJSON := false
	for _, arg := range args {
		if arg == "--json" {
			asJSON = true
		} else {
			target = arg
		}
	}
	if target != "" && target != "codex" {
		fmt.Fprintf(os.Stderr, "forge doctor: unknown target %q\n", target)
		return 2
	}
	report := buildDoctorReport(target)
	if asJSON {
		printJSON(redact(report))
	} else {
		checks, _ := report["checks"].([]map[string]interface{})
		for _, check := range checks {
			for _, line := range doctor.FormatCheckLines(check) {
				fmt.Println(line)
			}
		}
	}
	if ok, _ := report["ok"].(bool); ok {
		return 0
	}
	return 1
}

func buildDoctorReport(target string) map[string]interface{} {
	return doctor.BuildReport(newDoctorDeps(), target)
}

func codebuddyShimPath() string { return codebuddyShimPathImpl() }

func codebuddyShimPathImpl() string {
	if runtime.GOOS == "windows" {
		appData := os.Getenv("APPDATA")
		if appData == "" {
			appData = filepath.Join(userHome(), "AppData", "Roaming")
		}
		return filepath.Join(appData, "npm", "codebuddy.cmd")
	}
	return filepath.Join(userHome(), ".npm", "codebuddy.cmd")
}

func loadManifestAsDTO() (doctor.ProfileManifest, error) {
	m, err := loadManifest()
	if err != nil {
		return doctor.ProfileManifest{}, err
	}
	profiles := make(map[string]doctor.Profile, len(m.Profiles))
	for name, p := range m.Profiles {
		profiles[name] = doctor.Profile{
			Client: p.Client, Provider: p.Provider,
			Launcher: p.Launcher, Env: p.Env, SecretRef: p.SecretRef,
		}
	}
	return doctor.ProfileManifest{SchemaVersion: m.SchemaVersion, Profiles: profiles}, nil
}

func readAuthAsInterface() (map[string]interface{}, error) {
	entries, err := readAuth()
	if err != nil {
		return nil, err
	}
	result := make(map[string]interface{}, len(entries))
	for k, v := range entries {
		result[k] = v
	}
	return result, nil
}

func buildShellPlanAsInterface(home string) (interface{}, error) {
	return buildShellInstallPlan(home)
}

func safeShellPlanDetailsAsInterface(raw interface{}) map[string]interface{} {
	return safeShellPlanDetails(raw.(shell.InstallPlan))
}

func shellPlanHasConflicts(raw interface{}) bool {
	return len(raw.(shell.InstallPlan).Conflicts) > 0
}

func shellPlanHasActions(raw interface{}) bool {
	return len(raw.(shell.InstallPlan).Actions) > 0
}

func providerCredentialAvailableAsCallback(p doctor.Profile) bool {
	return providerCredentialAvailable(profile{
		Client: p.Client, Provider: p.Provider, SecretRef: p.SecretRef,
	})
}

func grokBinaryInstalled() bool {
	_, err := exec.LookPath("grok")
	return err == nil
}

// dshExpectedProtocol is the dsh protocol version Forge's DSH projection is
// built against. The dsh CLI must report a matching version to be compatible.
const dshExpectedProtocol = "@deepseek-ai/dsh@0.1.0-rc.6"

// dshExpectedVersion is the version token extracted from the expected protocol
// that `dsh --version` output must contain.
const dshExpectedVersion = "0.1.0-rc.6"

// dshCLIDoctorCheck diagnoses the FDSH protocol/launcher chain after native
// dsh is already present. Missing native dsh is owned by the installation
// group; this check returns nil in that case so doctor does not duplicate
// an install recipe here. Incompatible versions and broken launchers are
// reported as errors. It returns the standard doctor.Check shape with
// adapter "dsh".
func dshCLIDoctorCheck() map[string]interface{} {
	dshPath, dshErr := resolveRealDSH()
	details := map[string]interface{}{"dsh_binary": dshPath}
	if dshErr != nil {
		return nil
	}

	version := ""
	if reported, err := dshProtocolVersion(dshPath); err == nil {
		version = reported
	}
	details["dsh_version"] = version
	details["expected_protocol"] = dshExpectedProtocol
	if !strings.Contains(version, dshExpectedVersion) {
		message := fmt.Sprintf("dsh version %q is incompatible with this Forge protocol (%s). Upgrade Forge or dsh.", version, dshExpectedProtocol)
		if version == "" {
			message = fmt.Sprintf("could not determine dsh version; this Forge expects protocol %s. Upgrade Forge or dsh.", dshExpectedProtocol)
		}
		return doctor.Check("dsh", "error", message, nil, details)
	}

	fdshPath, fdshErr := exec.LookPath("fdsh")
	details["fdsh_binary"] = fdshPath
	if fdshErr != nil {
		return doctor.Check("dsh", "error", "fdsh launcher is not installed. Run forge setup or forge update.", nil, details)
	}
	info, statErr := os.Stat(fdshPath)
	if statErr != nil || !fdshLauncherLooksExecutable(fdshPath, info) {
		return doctor.Check("dsh", "error", "fdsh launcher is present but not executable", nil, details)
	}
	return doctor.Check("dsh", "ok", "dsh dependency chain is healthy", nil, details)
}

// fdshLauncherLooksExecutable reports whether doctor should treat the resolved
// fdsh launcher as runnable. Windows .exe launchers copied at 0644 still run
// via PATHEXT; Unix execute bits are the only portable signal there.
func fdshLauncherLooksExecutable(path string, info os.FileInfo) bool {
	if info == nil {
		return false
	}
	if runtime.GOOS == "windows" {
		switch strings.ToLower(filepath.Ext(path)) {
		case ".exe", ".cmd", ".bat", ".com":
			return true
		}
		return false
	}
	return info.Mode()&0o111 != 0
}
