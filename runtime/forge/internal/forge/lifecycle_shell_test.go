package forge

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/lifecycle/change"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/lifecycle/layout"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/lifecycle/shell"
)

func TestClientEmitsAliasShortcutCapabilities(t *testing.T) {
	for _, tc := range []struct {
		client string
		want   bool
	}{
		{"claude", true},
		{"codebuddy", false},
		{"codex", false},
		{"opencode", false},
		{"", false},
	} {
		if got := clientEmitsAliasShortcut(tc.client); got != tc.want {
			t.Fatalf("clientEmitsAliasShortcut(%q) = %v, want %v", tc.client, got, tc.want)
		}
	}
}

func TestUnauthedRichProviderSkipsShortcut(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", "")
	t.Setenv("XDG_DATA_HOME", filepath.Join(home, ".local", "share"))
	t.Setenv("FORGE_REPO_DIR", t.TempDir())
	setFakeClientsOnPath(t, "claude")

	// cc-glm is a built-in rich Claude Code profile (zhipu-coding provider).
	// Without auth, it should not appear in managed shortcut names or render a shell alias.
	if names := managedProfileFunctionNames(); contains(names, "cc-glm") {
		t.Fatalf("unauthed rich provider should skip managed shortcut names: %#v", names)
	}
	zsh, err := renderManagedShellFileFor([]string{"cc-glm"})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(zsh, "cc-glm()") || strings.Contains(zsh, "unavailable") {
		t.Fatalf("unauthed rich provider should not render a shortcut or unavailable stub:\n%s", zsh)
	}
}

func TestRenderManagedShellOnlyIncludesClaudeShortcuts(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	setFakeClientsOnPath(t, "claude")
	setTestAuth(t, "zhipu-coding", "token-zhipu")
	setTestAuth(t, "kimi-coding", "token-kimi")
	got, err := renderManagedShellFile()
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(got, "agent run") {
		t.Fatalf("managed shell should not include removed agent run passthrough shortcuts:\n%s", got)
	}
	if strings.Contains(got, "fg()") || strings.Contains(got, "builtin fg") {
		t.Fatalf("managed shell should not override fg:\n%s", got)
	}
	// Verify core managed profiles appear in output.
	for _, profile := range []string{"cc-glm", "cc-kimi"} {
		if !strings.Contains(got, profile+"()") {
			t.Fatalf("managed shell should include %s profile:\n%s", profile, got)
		}
	}
	for _, profile := range []string{"codex-terra", "cb-ds", "cb-dsf"} {
		if strings.Contains(got, profile+"()") {
			t.Fatalf("managed shell should not include non-Claude profile %s:\n%s", profile, got)
		}
	}
	// Verify none of the five removed legacy Codex ids are materialized.
	for _, profile := range []string{"codex", "codex-high", "codex-xhigh", "codex-lite", "codex-mini"} {
		if strings.Contains(got, profile+"()") {
			t.Fatalf("managed shell should not include removed profile %s:\n%s", profile, got)
		}
	}
}

func TestCCKimiShellCCSettingsJSONUsesForgeAuthAndManagedSettings(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("XDG_CONFIG_HOME", "")
	t.Setenv("XDG_DATA_HOME", t.TempDir())
	setFakeClientsOnPath(t, "claude")
	setTestAuth(t, "kimi-coding", "token-kimi")

	got, err := renderManagedShellFileFor([]string{"cc-kimi"})
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		`cc-kimi() {`,
		`command forge shell exec 'cc-kimi' -- 'claude' 'agents' '--permission-mode' 'bypassPermissions'`,
		`env -u ANTHROPIC_AUTH_TOKEN \`,
		`-u ANTHROPIC_API_KEY \`,
		`"ANTHROPIC_BASE_URL":"https://api.kimi.com/coding/"`,
		`"ANTHROPIC_MODEL":"k3[1m]"`,
		`"CLAUDE_CODE_SUBAGENT_MODEL":"k3[1m]"`,
		`"ENABLE_TOOL_SEARCH":"false"`,
		`"CLAUDE_CODE_AUTO_COMPACT_WINDOW":"1048576"`,
		`"CLAUDE_CODE_MAX_CONTEXT_TOKENS":"1048576"`,
		`"claude-opus-4-8":"k3[1m]"`,
		`"statusLine":{"type":"command","command":"forge statusline --claude-code"}`,
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("cc-kimi shell should contain %q in:\n%s", want, got)
		}
	}
	for _, forbidden := range []string{
		`token-kimi`,
		`"ANTHROPIC_API_KEY":`,
		`"ANTHROPIC_AUTH_TOKEN":`,
		`ANTHROPIC_API_KEY=token-kimi`,
		`ANTHROPIC_BASE_URL=https://api.kimi.com/coding/`,
	} {
		if strings.Contains(got, forbidden) {
			t.Fatalf("cc-kimi shell should not inject provider env outside settings.json: %q in:\n%s", forbidden, got)
		}
	}
	for _, want := range []string{
		`"model":"opus[1m]"`,
		`"opus[1m]"`,
		`"sonnet[1m]"`,
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("cc-kimi shell settings should contain 1M model variants: %q not found in:\n%s", want, got)
		}
	}
}

func TestPowerShellManagedBlockReplacesExistingBlock(t *testing.T) {
	existing := "Write-Host before\n\n" +
		powershellSourceBlockStart + "\n" +
		". \"$HOME\\.config\\wrenyard\\runtime\\shell\\old.ps1\"\n" +
		powershellSourceBlockEnd + "\n\n" +
		"Write-Host after\n"

	cleaned, found := removePowerShellSourceBlocks(existing)
	if !found {
		t.Fatal("expected existing PowerShell managed block to be found")
	}
	if strings.Contains(cleaned, "old.ps1") {
		t.Fatalf("expected old managed block to be removed:\n%s", cleaned)
	}

	got := appendPowerShellSourceBlock(cleaned)
	if strings.Count(got, powershellSourceBlockStart) != 1 || strings.Count(got, powershellSourceBlockEnd) != 1 {
		t.Fatalf("expected one PowerShell managed block:\n%s", got)
	}
	if !strings.Contains(got, powershellSourceLine) {
		t.Fatalf("expected PowerShell source line in managed block:\n%s", got)
	}
	if !strings.Contains(got, "Write-Host before") || !strings.Contains(got, "Write-Host after") {
		t.Fatalf("expected unmanaged profile content to be preserved:\n%s", got)
	}
}

func TestPowerShellLegacySourceBlockIsRemoved(t *testing.T) {
	existing := "# -- Forge-managed shell shortcuts (auto-generated) --\n" +
		". \"$HOME\\.config\\forge\\shell\\forge.ps1\"\n\n" +
		"# theme\n" +
		". \"$HOME\\.config\\forge\\shell\\theme.ps1\"\n"
	cleaned, found := removePowerShellLegacySourceBlocks(existing)
	if !found {
		t.Fatal("expected legacy PowerShell source block to be found")
	}
	if strings.Contains(cleaned, "forge.ps1") {
		t.Fatalf("expected legacy forge.ps1 source to be removed:\n%s", cleaned)
	}
	if !strings.Contains(cleaned, "theme.ps1") {
		t.Fatalf("expected unrelated theme source to remain:\n%s", cleaned)
	}
	got := appendPowerShellSourceBlock(cleaned)
	if strings.Count(got, powershellSourceLine) != 1 {
		t.Fatalf("expected exactly one managed PowerShell source line:\n%s", got)
	}
}

func TestPowerShellProfilePathFallsBackToWindowsPowerShell(t *testing.T) {
	home := t.TempDir()
	legacyDir := filepath.Join(home, "Documents", "WindowsPowerShell")
	if err := os.MkdirAll(legacyDir, 0o755); err != nil {
		t.Fatal(err)
	}
	want := filepath.Join(legacyDir, "Microsoft.PowerShell_profile.ps1")
	if got := powershellProfilePathForHome(home); got != want {
		t.Fatalf("expected legacy PowerShell profile path %q, got %q", want, got)
	}
}

func TestBackupRelativePathSanitizesWindowsVolume(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("windows-specific path syntax")
	}
	got := backupRelativePath(`C:\Users\test\.zshrc`)
	if strings.Contains(got, ":") {
		t.Fatalf("backup path should not contain a drive colon: %q", got)
	}
	if !strings.HasPrefix(got, `C\Users\test`) {
		t.Fatalf("backup path should preserve the drive as a safe path segment, got %q", got)
	}
}

func TestShellPlanSourceBlocksFollowXDGConfigHome(t *testing.T) {
	home := t.TempDir()
	xdgConfig := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", xdgConfig)
	configDir := layout.NewPaths(home).ConfigDir()
	findWrite := func(actions []change.Action, path string) (string, bool) {
		for _, action := range actions {
			if action.Type == "file_write" && action.File != nil && action.File.Path == path {
				return action.File.Content, true
			}
		}
		return "", false
	}

	// Zsh: the managed file and the generated source block must agree on the
	// resolved path and must not fall back to $HOME/.config.
	zshPlan, err := shell.PlanZsh(home, "managed-content", nil)
	if err != nil {
		t.Fatal(err)
	}
	if want := filepath.Join(configDir, "shell", "forge.zsh"); zshPlan.ManagedFile != want {
		t.Fatalf("zsh managed file = %q, want %q", zshPlan.ManagedFile, want)
	}
	zshProfile, ok := findWrite(zshPlan.ChangePlan.Actions, zshPlan.Zshrc)
	if !ok {
		t.Fatalf("expected a zshrc file_write action for %q", zshPlan.Zshrc)
	}
	if !strings.Contains(zshProfile, zshPlan.ManagedFile) {
		t.Fatalf("zsh source block must reference the resolved managed file %q:\n%s", zshPlan.ManagedFile, zshProfile)
	}
	if strings.Contains(zshProfile, "$HOME/.config") || strings.Contains(zshProfile, filepath.Join(home, ".config")) {
		t.Fatalf("zsh source block must not reference $HOME/.config:\n%s", zshProfile)
	}

	// PowerShell: the same path agreement must hold for the managed file and
	// the generated source block, with no legacy Forge config references.
	psPlan, err := shell.PlanPowerShell(home, "managed-content", nil)
	if err != nil {
		t.Fatal(err)
	}
	if want := filepath.Join(configDir, "shell", "forge.ps1"); psPlan.ManagedFile != want {
		t.Fatalf("powershell managed file = %q, want %q", psPlan.ManagedFile, want)
	}
	psProfile, ok := findWrite(psPlan.ChangePlan.Actions, psPlan.ProfilePath)
	if !ok {
		t.Fatalf("expected a PowerShell profile file_write action for %q", psPlan.ProfilePath)
	}
	if !strings.Contains(psProfile, psPlan.ManagedFile) {
		t.Fatalf("powershell source block must reference the resolved managed file %q:\n%s", psPlan.ManagedFile, psProfile)
	}
	for _, legacy := range []string{`$HOME\.config`, `forge\shell\forge.ps1`} {
		if strings.Contains(psProfile, legacy) {
			t.Fatalf("powershell source block must not reference legacy %q:\n%s", legacy, psProfile)
		}
	}
}
