package doctor

import (
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

// ForgeConfigCheck validates the profile manifest.
func ForgeConfigCheck(deps Dependencies) map[string]interface{} {
	manifest, err := deps.LoadManifest()
	if err != nil || manifest.SchemaVersion != 1 {
		return Check("config", "error", "Unsupported or unreadable Forge profile manifest.", nil, nil)
	}
	if len(manifest.Profiles) == 0 {
		return Check("config", "error", "Forge profile manifest has no profiles.", nil, nil)
	}

	sources := deps.ManifestSources()
	sourceSummary := map[string]int{}
	for _, src := range sources {
		sourceSummary[src]++
	}
	details := map[string]interface{}{
		"profile_count": len(manifest.Profiles),
		"sources":       sourceSummary,
	}

	return Check("config", "ok", "Forge profile manifest loaded.", nil, details)
}

// ConfigFileCheck reports on forge config.json.
func ConfigFileCheck(deps Dependencies) map[string]interface{} {
	cfg, warnings, err := deps.LoadForgeConfig()
	if err != nil {
		return Check("forge-config", "error", "Failed to load forge config.", nil, map[string]interface{}{"error": err.Error()})
	}

	source := "embedded"
	if deps.Exists(deps.UserConfigPath) {
		source = "user"
	}

	details := map[string]interface{}{
		"source": source,
	}

	// Report disabled clients.
	disabled := []string{}
	for client, cc := range cfg.Clients {
		if !cc.Enabled {
			disabled = append(disabled, client)
		}
	}
	if len(disabled) > 0 {
		details["disabled_clients"] = disabled
	}

	for _, w := range warnings {
		details["warning"] = w
	}

	return Check("forge-config", "ok", "Forge config loaded.", nil, details)
}

// SecretsDoctorCheck reports user secrets and auth file presence/permissions.
func SecretsDoctorCheck(deps Dependencies) map[string]interface{} {
	details := map[string]interface{}{
		"user_secrets_path": deps.UserSecretsPath,
		"auth_path":         deps.AuthPath,
	}

	// Check auth.json (new credential store).
	authExists := deps.Exists(deps.AuthPath)
	details["auth_exists"] = authExists
	if authExists {
		details["auth_perms_ok"] = deps.AuthPermsOK(deps.AuthPath)
		if auth, err := deps.ReadAuth(); err == nil {
			details["auth_provider_count"] = len(auth)
		}
	}

	// Check legacy secrets.json (still present during transition).
	secretsExists := deps.Exists(deps.UserSecretsPath)
	details["secrets_exists"] = secretsExists
	if secretsExists {
		details["secrets_perms_ok"] = deps.SecretsFilePermsOK(deps.UserSecretsPath)
		userData := deps.ReadSecretsFile(deps.UserSecretsPath)
		details["secrets_key_count"] = len(userData)
	}

	// Provider sources from config.
	details["provider_sources"] = deps.ProviderSources()

	// Determine status.
	if !authExists && !secretsExists {
		return Check("secrets", "warning",
			"No credentials configured. Use 'forge auth login' to add provider credentials.",
			nil, details)
	}

	if authExists && details["auth_perms_ok"] == false {
		return Check("secrets", "warning",
			"auth.json has incorrect permissions (want 0600).",
			nil, details)
	}

	if !authExists && secretsExists {
		return Check("secrets", "warning",
			"Credentials are still in legacy secrets.json. Remove the legacy file and use 'forge auth login' to configure credentials in auth.json.",
			nil, details)
	}

	return Check("secrets", "ok", "Provider credentials are configured.", nil, details)
}

// CodexConfigCheck verifies that Codex is installed and has local auth state.
func CodexConfigCheck(deps Dependencies) map[string]interface{} {
	details := map[string]interface{}{}
	codexPath, err := exec.LookPath("codex")
	if err != nil {
		return Check("codex", "warning", "Codex CLI is not installed or is not on PATH.", []string{"codex"}, details)
	}
	details["binary"] = codexPath

	// Use the auth SSOT ProviderAuthStatus if available, otherwise fall back
	// to direct path checking (legacy fallback for isolated callers).
	if deps.ProviderAuthStatus != nil {
		status := deps.ProviderAuthStatus("codex")
		details["auth_path"] = status.SourcePath
		if !status.OK {
			details["login_hint"] = "run codex auth login to authenticate"
			return Check("codex", "warning",
				"Codex is installed but is not logged in.",
				[]string{status.SourcePath}, details)
		}
		return Check("codex", "ok", "Codex is installed and has local authentication state.", nil, details)
	}

	// Legacy fallback: direct file checking.
	authPath := codexAuthPath(deps.UserHome())
	details["auth_path"] = authPath
	if !deps.Exists(authPath) {
		details["login_hint"] = "run codex auth login to authenticate"
		return Check("codex", "warning", "Codex is installed but is not logged in.", []string{authPath}, details)
	}
	return Check("codex", "ok", "Codex is installed and has local authentication state.", nil, details)
}

func codexAuthPath(home string) string {
	if codexHome := strings.TrimSpace(os.Getenv("CODEX_HOME")); codexHome != "" {
		return filepath.Join(codexHome, "auth.json")
	}
	return filepath.Join(home, ".codex", "auth.json")
}

// ShellEntriesCheck verifies forge shell entries.
func ShellEntriesCheck(deps Dependencies) map[string]interface{} {
	plan, err := deps.BuildShellPlan(deps.UserHome())
	if err != nil {
		return Check("shell", "warning", "Forge shell entries could not be inspected.", []string{"shell"}, map[string]interface{}{"error": err.Error()})
	}
	details := deps.SafeShellPlanDetails(plan)
	if deps.ShellHasConflicts(plan) {
		return Check("shell", "warning", "Unmanaged shell shortcuts conflict with Forge shortcuts.", nil, details)
	}
	if deps.ShellHasActions(plan) {
		return Check("shell", "warning", "Forge shell entries are missing or stale.", nil, details)
	}
	return Check("shell", "ok", "Forge shell entries are current.", nil, details)
}

// ProfileConflictsCheck detects profile environment variable conflicts.
func ProfileConflictsCheck() map[string]interface{} {
	conflicts := []string{}
	for _, name := range []string{"ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"} {
		if os.Getenv(name) != "" {
			conflicts = append(conflicts, name)
		}
	}
	if len(conflicts) > 0 {
		return Check("shell", "warning", "Profile environment variables may override Forge launchers.", conflicts, nil)
	}
	return Check("shell", "ok", "No obvious profile environment conflicts detected.", nil, nil)
}

// SkillsCheck validates skill frontmatter.
func SkillsCheck(deps Dependencies) map[string]interface{} {
	repo, err := deps.RepoDir()
	if err != nil {
		return Check("skills", "ok", "Skills check skipped (repo not available — repo-dev-only).", nil, map[string]interface{}{"note": "repo-dev-only"})
	}
	skillsDir := filepath.Join(repo, "data", "skills")
	if _, err := os.Stat(skillsDir); os.IsNotExist(err) {
		return Check("skills", "ok", "Skills check skipped (no bundled skills found).", nil, map[string]interface{}{"note": "no-bundled-skills"})
	}
	count := 0
	missing := []string{}
	filepath.WalkDir(skillsDir, func(path string, d fs.DirEntry, err error) error {
		if err == nil && !d.IsDir() && d.Name() == "SKILL.md" {
			count++
			text := deps.ReadText(path)
			if !strings.HasPrefix(text, "---\n") || !strings.Contains(text[4:], "\n---\n") {
				rel, _ := filepath.Rel(repo, path)
				missing = append(missing, rel)
			}
		}
		return nil
	})
	if len(missing) > 0 {
		return Check("skills", "warning", "Some skill files are missing YAML frontmatter.", missing, nil)
	}
	return Check("skills", "ok", "Skill frontmatter is present.", nil, map[string]interface{}{"count": count})
}

// DeadShellSourcesCheck detects dead shell source references.
func DeadShellSourcesCheck(deps Dependencies) map[string]interface{} {
	dead := []map[string]string{}
	for _, path := range []string{
		filepath.Join(deps.UserHome(), ".zshrc"),
		filepath.Join(deps.UserHome(), ".bashrc"),
		filepath.Join(deps.UserHome(), ".bash_profile"),
	} {
		for _, ref := range sourceReferences(deps, path) {
			expanded := deps.ExpandHome(os.ExpandEnv(ref))
			if !deps.Exists(expanded) {
				dead = append(dead, map[string]string{"file": path, "source": ref})
			}
		}
	}
	if len(dead) > 0 {
		return Check("shell", "warning", "Dead shell source references detected.", nil, map[string]interface{}{"dead_sources": dead})
	}
	return Check("shell", "ok", "No dead shell source references found.", nil, nil)
}

func sourceReferences(deps Dependencies, path string) []string {
	refs := []string{}
	for _, line := range strings.Split(deps.ReadText(path), "\n") {
		stripped := strings.TrimSpace(line)
		if stripped == "" || strings.HasPrefix(stripped, "#") {
			continue
		}
		parts := strings.Fields(stripped)
		if len(parts) >= 2 && (parts[0] == "source" || parts[0] == ".") {
			refs = append(refs, strings.Trim(parts[1], "'\""))
		}
	}
	return refs
}

// WindowsConfigRootsCheck detects duplicate forge config roots on Windows.
func WindowsConfigRootsCheck(deps Dependencies) map[string]interface{} {
	if runtime.GOOS != "windows" {
		return Check("windows", "ok", "Windows config root check not applicable on this platform.", nil, nil)
	}
	homeForge := filepath.Join(deps.UserHome(), ".config", "forge")
	appData := os.Getenv("APPDATA")
	var roots []string
	if deps.Exists(homeForge) {
		roots = append(roots, homeForge)
	}
	if appData != "" {
		appDataForge := filepath.Join(appData, "forge")
		if deps.Exists(appDataForge) {
			roots = append(roots, appDataForge)
		}
	}
	canonical := filepath.Join(deps.UserHome(), ".config", "wrenyard", "runtime")
	if len(roots) > 1 {
		return Check("windows", "warning",
			fmt.Sprintf("Multiple legacy forge config roots detected: %s. Wrenyard runtime config at %s is canonical; legacy roots are read-only for migration.", strings.Join(roots, ", "), canonical),
			nil, map[string]interface{}{"config_roots": roots})
	}
	return Check("windows", "ok", "No duplicate legacy forge config roots detected; Wrenyard runtime config is canonical.", nil, nil)
}
