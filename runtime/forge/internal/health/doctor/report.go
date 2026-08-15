package doctor

import "fmt"

// BuildReport constructs a doctor report with exact adapter order and schema.
func BuildReport(deps Dependencies, target string) map[string]interface{} {
	checks := []map[string]interface{}{}
	if target == "codex" {
		checks = append(checks, CodexConfigCheck(deps))
	} else {
		checks = append(checks,
			ForgeConfigCheck(deps),
			ConfigFileCheck(deps),
			SecretsDoctorCheck(deps),
			CodexConfigCheck(deps),
			ShellEntriesCheck(deps),
			ProfileConflictsCheck(),
			SkillsCheck(deps),
			DeadShellSourcesCheck(deps),
			InstallationDoctorCheck(),
			CodebuddyCLIDoctorCheck(deps),
			CBModelWhitelistCheck(deps),
			WindowsConfigRootsCheck(deps),
			GrokDoctorCheck(deps),
		)
		if deps.DSHCheck != nil {
			if check := deps.DSHCheck(); check != nil {
				checks = append(checks, check)
			}
		}
		checks = append(checks,
			ClientsDoctorChecks(deps)...,
		)
		checks = append(checks,
			ProvidersDoctorChecks(deps)...,
		)
		checks = append(checks,
			ProfilesDoctorChecks(deps)...,
		)
	}
	summary := map[string]int{"ok": 0, "warning": 0, "error": 0}
	ok := true
	for _, check := range checks {
		if check == nil {
			continue
		}
		status := fmt.Sprint(check["status"])
		summary[status]++
		if status == "error" {
			ok = false
		}
	}
	return map[string]interface{}{
		"schema_version": 1,
		"ok":             ok,
		"adapters": []string{
			"config", "forge-config", "secrets",
			"shell", "codex", "skills",
			"installation",
			"codebuddy-cli", "cb-models", "windows", "grok", "dsh",
			"clients", "providers", "profiles",
		},
		"checks":  checks,
		"summary": summary,
	}
}
