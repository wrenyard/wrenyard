package shell

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/lifecycle/change"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/lifecycle/layout"
)

// --- source-block constants (shell-domain, live in the shell package) ---

const (
	blockStartZsh        = "# >>> forge shell shortcuts >>>"
	blockEndZsh          = "# <<< forge shell shortcuts <<<"
	blockLineZsh         = `source "$HOME/.config/wrenyard/runtime/shell/forge.zsh"`
	blockStartPowerShell = "# >>> forge managed >>>"
	blockEndPowerShell   = "# <<< forge managed <<<"
	blockLinePowerShell  = `. "$HOME\.config\wrenyard\runtime\shell\forge.ps1"`
)

// --- plan construction ---

// PlanZsh builds an install plan for Zsh shell integration.
func PlanZsh(home string, managedShell string, funcNames []string) (InstallPlan, error) {
	managedFile := filepath.Join(layout.NewPaths(home).ConfigDir(), "shell", "forge.zsh")
	zshrc := filepath.Join(home, ".zshrc")
	existing := readTextIfExists(zshrc)
	cleaned, sourceBlockPresent := removeSourceBlocks(existing, blockStartZsh, blockEndZsh)
	migrated, legacyBlockFound := removeLegacyShortcuts(cleaned)
	conflicts := findUnmanagedConflicts(migrated, funcNames)
	actions := []change.Action{}
	labels := []string{}
	if readTextIfExists(managedFile) != managedShell {
		actions = append(actions, change.Action{Type: "file_write", File: &change.FileWrite{Path: managedFile, Content: managedShell, Encoding: "utf-8"}})
		labels = append(labels, "write managed shell file")
	}
	if len(conflicts) == 0 {
		nextZshrc := appendZshSourceBlock(migrated, managedFile)
		if nextZshrc != existing {
			actions = append(actions, change.Action{Type: "file_write", File: &change.FileWrite{Path: zshrc, Content: nextZshrc, Encoding: "utf-8"}})
			if legacyBlockFound {
				labels = append(labels, "replace legacy shortcuts with managed source block")
			} else {
				labels = append(labels, "add managed source block")
			}
		}
	}
	return InstallPlan{
		ChangePlan:         change.Plan{Name: "forge-install-shell", Actions: actions},
		Shell:              "zsh",
		ManagedFile:        managedFile,
		ProfilePath:        zshrc,
		Zshrc:              zshrc,
		Conflicts:          conflicts,
		LegacyBlockFound:   legacyBlockFound,
		SourceBlockPresent: sourceBlockPresent,
		Actions:            labels,
	}, nil
}

// PlanPowerShell builds an install plan for PowerShell shell integration.
func PlanPowerShell(home string, managedShell string, funcNames []string) (InstallPlan, error) {
	managedFile := filepath.Join(layout.NewPaths(home).ConfigDir(), "shell", "forge.ps1")
	profilePath := PowerShellProfilePathForHome(home)
	existing := readTextIfExists(profilePath)
	cleaned, sourceBlockPresent := removeSourceBlocks(existing, blockStartPowerShell, blockEndPowerShell)
	cleaned, legacyBlockFound := RemovePowerShellLegacySourceBlocks(cleaned)
	conflicts := findUnmanagedConflicts(cleaned, funcNames)
	actions := []change.Action{}
	labels := []string{}
	if readTextIfExists(managedFile) != managedShell {
		actions = append(actions, change.Action{Type: "file_write", File: &change.FileWrite{Path: managedFile, Content: managedShell, Encoding: "utf-8"}})
		labels = append(labels, "write managed PowerShell file")
	}
	if len(conflicts) == 0 {
		nextProfile := appendPowerShellSourceBlock(cleaned, managedFile)
		if nextProfile != existing {
			actions = append(actions, change.Action{Type: "file_write", File: &change.FileWrite{Path: profilePath, Content: nextProfile, Encoding: "utf-8"}})
			if legacyBlockFound {
				labels = append(labels, "replace legacy PowerShell source block with managed source block")
			} else {
				labels = append(labels, "add managed PowerShell source block")
			}
		}
	}
	return InstallPlan{
		ChangePlan:         change.Plan{Name: "forge-install-shell", Actions: actions},
		Shell:              "powershell",
		ManagedFile:        managedFile,
		ProfilePath:        profilePath,
		Conflicts:          conflicts,
		LegacyBlockFound:   legacyBlockFound,
		SourceBlockPresent: sourceBlockPresent,
		Actions:            labels,
	}, nil
}

// --- source-block manipulation ---

func removeSourceBlocks(content, start, end string) (string, bool) {
	re := regexp.MustCompile(`(?s)\n?` + regexp.QuoteMeta(start) + `\n.*?` + regexp.QuoteMeta(end) + `\n?`)
	found := re.MatchString(content)
	updated := re.ReplaceAllString(content, "\n")
	return strings.Trim(updated, "\n") + newlineIfNotBlank(content), found
}

// RemovePowerShellSourceBlocks removes the Forge-managed source block from
// PowerShell profile content. Exported for the root facade.
func RemovePowerShellSourceBlocks(content string) (string, bool) {
	return removeSourceBlocks(content, blockStartPowerShell, blockEndPowerShell)
}

func removeLegacyShortcuts(content string) (string, bool) {
	re := regexp.MustCompile(`(?ms)\n?# Claude Code shortcuts\n.*?^(?:cccb|ccb)\(\) \{.*?^\}\n?`)
	found := re.MatchString(content)
	updated := re.ReplaceAllString(content, "\n")
	return strings.Trim(updated, "\n") + newlineIfNotBlank(updated), found
}

// RemovePowerShellLegacySourceBlocks removes legacy Forge-managed PowerShell
// source blocks. Exported for the root facade.
func RemovePowerShellLegacySourceBlocks(content string) (string, bool) {
	re := regexp.MustCompile(`(?m)^\s*(?:#.*Forge-managed shell shortcuts.*\n)?\s*\.\s*"\$HOME\\\.config\\forge\\shell\\forge\.ps1"\s*\n?`)
	found := re.MatchString(content)
	updated := re.ReplaceAllString(content, "")
	return strings.Trim(updated, "\n") + newlineIfNotBlank(updated), found
}

func appendZshSourceBlock(content, managedFile string) string {
	return appendManagedBlock(content, zshSourceBlock(managedFile))
}

// AppendPowerShellSourceBlock appends the Forge-managed PowerShell source
// block to the given profile content. Exported for the root facade.
func AppendPowerShellSourceBlock(content string) string {
	block := blockStartPowerShell + "\nif (Test-Path \"$HOME\\.config\\wrenyard\\runtime\\shell\\forge.ps1\") {\n    " + blockLinePowerShell + "\n}\n" + blockEndPowerShell + "\n"
	return appendManagedBlock(content, block)
}

// appendPowerShellSourceBlock appends a Forge-managed PowerShell source block
// that sources the given resolved managed file path.
func appendPowerShellSourceBlock(content, managedFile string) string {
	return appendManagedBlock(content, powershellSourceBlock(managedFile))
}

func zshSourceBlock(managedFile string) string {
	quoted := zshQuotePath(managedFile)
	return blockStartZsh + "\nif [ -r " + quoted + " ]; then\n  source " + quoted + "\nfi\n" + blockEndZsh + "\n"
}

func powershellSourceBlock(managedFile string) string {
	quoted := powershellQuotePath(managedFile)
	return blockStartPowerShell + "\nif (Test-Path " + quoted + ") {\n    . " + quoted + "\n}\n" + blockEndPowerShell + "\n"
}

func zshQuotePath(path string) string {
	escaped := strings.ReplaceAll(path, `\`, `\\`)
	escaped = strings.ReplaceAll(escaped, `"`, `\"`)
	escaped = strings.ReplaceAll(escaped, "`", "\\`")
	escaped = strings.ReplaceAll(escaped, `$`, `\$`)
	return `"` + escaped + `"`
}

func powershellQuotePath(path string) string {
	escaped := strings.ReplaceAll(path, "`", "``")
	escaped = strings.ReplaceAll(escaped, `"`, "`\"")
	escaped = strings.ReplaceAll(escaped, `$`, "`$")
	return `"` + escaped + `"`
}

func appendManagedBlock(content, block string) string {
	prefix := strings.TrimRight(content, "\n")
	if prefix == "" {
		return block
	}
	return prefix + "\n\n" + block
}

func newlineIfNotBlank(content string) string {
	if strings.TrimSpace(content) == "" {
		return ""
	}
	return "\n"
}

// --- conflict detection ---

func findUnmanagedConflicts(content string, funcNames []string) []Conflict {
	conflicts := []Conflict{}
	for i, line := range strings.Split(content, "\n") {
		stripped := strings.TrimSpace(line)
		for _, name := range funcNames {
			if regexp.MustCompile(`^alias\s+` + regexp.QuoteMeta(name) + `=`).MatchString(stripped) {
				conflicts = append(conflicts, Conflict{name, "alias", i + 1, stripped})
			} else if regexp.MustCompile(`(?i)^(?:Set-Alias|New-Alias)\s+` + regexp.QuoteMeta(name) + `\b`).MatchString(stripped) {
				conflicts = append(conflicts, Conflict{name, "alias", i + 1, stripped})
			} else if regexp.MustCompile(`^(?:function\s+` + regexp.QuoteMeta(name) + `\b|` + regexp.QuoteMeta(name) + `\s*\(\s*\))`).MatchString(stripped) {
				conflicts = append(conflicts, Conflict{name, "function", i + 1, stripped})
			}
		}
	}
	return conflicts
}

// --- payload helpers ---

// PlanPayload builds the public JSON payload for a shell install plan.
func PlanPayload(plan InstallPlan) map[string]interface{} {
	data := map[string]interface{}{
		"name":                 plan.ChangePlan.Name,
		"shell":                plan.Shell,
		"managed_file":         plan.ManagedFile,
		"profile_path":         plan.ProfilePath,
		"legacy_block_found":   plan.LegacyBlockFound,
		"source_block_present": plan.SourceBlockPresent,
		"conflicts":            plan.Conflicts,
		"actions":              plan.Actions,
		"plan":                 planJournal(plan.ChangePlan),
	}
	if plan.Zshrc != "" {
		data["zshrc"] = plan.Zshrc
	}
	return data
}

// SafePlanDetails builds a payload safe for external consumption
// (omits file content from the journal).
func SafePlanDetails(plan InstallPlan) map[string]interface{} {
	data := PlanPayload(plan)
	if p, ok := data["plan"].(map[string]interface{}); ok {
		actions := []map[string]interface{}{}
		for _, action := range p["actions"].([]map[string]interface{}) {
			delete(action, "content")
			actions = append(actions, action)
		}
		p["actions"] = actions
	}
	return data
}

// planJournal builds the journal payload for a change plan, including
// full action content. Exported for the root facade's payload helpers.
func planJournal(plan change.Plan) map[string]interface{} {
	return change.PlanJournal(plan)
}

// --- filesystem helpers (private to this package for source-block I/O) ---

func readTextIfExists(path string) string {
	content, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return string(content)
}

func exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// PowerShellProfilePathForHome returns the path to the PowerShell profile
// for the given home directory. Exported for the root facade.
func PowerShellProfilePathForHome(home string) string {
	primary := filepath.Join(home, "Documents", "PowerShell", "Microsoft.PowerShell_profile.ps1")
	legacy := filepath.Join(home, "Documents", "WindowsPowerShell", "Microsoft.PowerShell_profile.ps1")
	if exists(primary) || exists(filepath.Dir(primary)) {
		return primary
	}
	if exists(legacy) || exists(filepath.Dir(legacy)) {
		return legacy
	}
	return primary
}
