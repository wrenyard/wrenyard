package shell

import (
	"os"
	"regexp"
	"strings"
	"testing"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/profiles/manifest"
)

func TestRenderGrokZsh(t *testing.T) {
	got := RenderGrokZsh()
	for _, want := range []string{
		"fgrok() {",
		`command wrenyard runtime shell grok exec -- "$@"`,
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("zsh fgrok should contain %q in:\n%s", want, got)
		}
	}
	// Must not shadow the official `grok` binary or define a per-provider fn.
	// A line starting with "grok() {" would shadow the official binary; the
	// "fgrok" definition legitimately contains the substring "grok() {".
	if regexp.MustCompile(`(?m)^grok\(\) \{`).MatchString(got) {
		t.Fatalf("fgrok must not shadow grok:\n%s", got)
	}
	if strings.Contains(got, "fgrok-kimi") || strings.Contains(got, "fgrok-glm") {
		t.Fatalf("fgrok must not be per-provider:\n%s", got)
	}
}

func TestRenderGrokPowerShell(t *testing.T) {
	got := RenderGrokPowerShell("wrenyard")
	for _, want := range []string{
		"function fgrok {",
		`& 'wrenyard' 'runtime' 'shell' 'grok' 'exec' '--' @args`,
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("powershell fgrok should contain %q in:\n%s", want, got)
		}
	}
	if regexp.MustCompile(`(?m)^grok \{`).MatchString(got) {
		t.Fatalf("fgrok must not shadow grok:\n%s", got)
	}
}

func TestBuildInstallPlanIncludesFgrok(t *testing.T) {
	deps := InstallDeps{
		FunctionNames:           func() []string { return nil },
		LoadManifest:            func() (manifest.Manifest, error) { return manifest.Manifest{}, nil },
		ProfileInstallsShortcut: func(manifest.Profile) bool { return true },
		ResolveSecret:           func(*string) (*string, error) { return nil, nil },
		CurrentForgePath:        func() (string, error) { return "wrenyard", nil },
		ResolveCredential:       func(string) (string, bool) { return "", false },
		IsManagedProvider:       func(string) bool { return false },
	}
	plan, err := BuildInstallPlan(t.TempDir(), "zsh", deps)
	if err != nil {
		t.Fatal(err)
	}
	payload := PlanPayload(plan)
	found := false
	if p, ok := payload["plan"].(map[string]interface{}); ok {
		if actions, ok := p["actions"].([]map[string]interface{}); ok {
			for _, a := range actions {
				if c, ok := a["content"].(string); ok && strings.Contains(c, "fgrok") {
					found = true
				}
			}
		}
	}
	if !found {
		t.Fatalf("fgrok not found in install plan payload:\n%#v", payload)
	}
}

func TestBuildInstallPlanDetectsFgrokFunctionConflict(t *testing.T) {
	home := t.TempDir()
	zshrc := home + "/.zshrc"
	writeFile(t, zshrc, "fgrok() {\n  echo 'user-owned'\n}\n")
	t.Setenv("HOME", home)

	deps := InstallDeps{
		FunctionNames:           func() []string { return nil },
		LoadManifest:            func() (manifest.Manifest, error) { return manifest.Manifest{}, nil },
		ProfileInstallsShortcut: func(manifest.Profile) bool { return true },
		ResolveSecret:           func(*string) (*string, error) { return nil, nil },
		CurrentForgePath:        func() (string, error) { return "wrenyard", nil },
		ResolveCredential:       func(string) (string, bool) { return "", false },
		IsManagedProvider:       func(string) bool { return false },
	}
	plan, err := BuildInstallPlan(home, "zsh", deps)
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.Conflicts) == 0 {
		t.Fatal("expected a conflict for pre-existing fgrok function")
	}
	found := false
	for _, c := range plan.Conflicts {
		if c.Name == "fgrok" && c.Kind == "function" {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected conflict for fgrok function, got: %#v", plan.Conflicts)
	}
	// Safe managed file write must be allowed even when conflict exists.
	managedLabel := "write managed shell file"
	if sl := plan.Actions; len(sl) != 1 || sl[0] != managedLabel {
		t.Fatalf("expected only managed file write action when conflict exists, got: %#v", sl)
	}
	// No action should modify the user .zshrc when a conflict exists.
	for _, a := range plan.ChangePlan.Actions {
		if a.File != nil && a.File.Path == plan.ProfilePath {
			t.Fatalf("expected no action modifying zshrc when conflict exists, got action on %s", a.File.Path)
		}
	}
}

func TestBuildInstallPlanDetectsFgrokAliasConflict(t *testing.T) {
	home := t.TempDir()
	zshrc := home + "/.zshrc"
	writeFile(t, zshrc, "alias fgrok='echo user-owned'\n")
	t.Setenv("HOME", home)

	deps := InstallDeps{
		FunctionNames:           func() []string { return nil },
		LoadManifest:            func() (manifest.Manifest, error) { return manifest.Manifest{}, nil },
		ProfileInstallsShortcut: func(manifest.Profile) bool { return true },
		ResolveSecret:           func(*string) (*string, error) { return nil, nil },
		CurrentForgePath:        func() (string, error) { return "wrenyard", nil },
		ResolveCredential:       func(string) (string, bool) { return "", false },
		IsManagedProvider:       func(string) bool { return false },
	}
	plan, err := BuildInstallPlan(home, "zsh", deps)
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.Conflicts) == 0 {
		t.Fatal("expected a conflict for pre-existing fgrok alias")
	}
	found := false
	for _, c := range plan.Conflicts {
		if c.Name == "fgrok" && c.Kind == "alias" {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected conflict for fgrok alias, got: %#v", plan.Conflicts)
	}
	// Safe managed file write must be allowed even when conflict exists.
	managedLabel := "write managed shell file"
	if sl := plan.Actions; len(sl) != 1 || sl[0] != managedLabel {
		t.Fatalf("expected only managed file write action when conflict exists, got: %#v", sl)
	}
	// No action should modify the user .zshrc when a conflict exists.
	for _, a := range plan.ChangePlan.Actions {
		if a.File != nil && a.File.Path == plan.ProfilePath {
			t.Fatalf("expected no action modifying zshrc when conflict exists, got action on %s", a.File.Path)
		}
	}
}

func TestBuildInstallPlanDetectsPowerShellFgrokFunctionConflict(t *testing.T) {
	home := t.TempDir()
	profileDir := home + "/Documents/PowerShell"
	mkdirAll(t, profileDir)
	profilePath := profileDir + "/Microsoft.PowerShell_profile.ps1"
	writeFile(t, profilePath, "function fgrok {\n    Write-Output 'user-owned'\n}\n")
	t.Setenv("HOME", home)

	deps := InstallDeps{
		FunctionNames:           func() []string { return nil },
		LoadManifest:            func() (manifest.Manifest, error) { return manifest.Manifest{}, nil },
		ProfileInstallsShortcut: func(manifest.Profile) bool { return true },
		ResolveSecret:           func(*string) (*string, error) { return nil, nil },
		CurrentForgePath:        func() (string, error) { return "wrenyard", nil },
		ResolveCredential:       func(string) (string, bool) { return "", false },
		IsManagedProvider:       func(string) bool { return false },
	}
	plan, err := BuildInstallPlan(home, "powershell", deps)
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.Conflicts) == 0 {
		t.Fatal("expected a PowerShell conflict for pre-existing fgrok function")
	}
	found := false
	for _, c := range plan.Conflicts {
		if c.Name == "fgrok" && c.Kind == "function" {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected PowerShell conflict for fgrok function, got: %#v", plan.Conflicts)
	}
	// Safe managed file write must be allowed even when conflict exists.
	managedLabel := "write managed PowerShell file"
	if sl := plan.Actions; len(sl) != 1 || sl[0] != managedLabel {
		t.Fatalf("expected only managed file write action when conflict exists, got: %#v", sl)
	}
	// No action should modify the user PowerShell profile when a conflict exists.
	for _, a := range plan.ChangePlan.Actions {
		if a.File != nil && a.File.Path == plan.ProfilePath {
			t.Fatalf("expected no action modifying PowerShell profile when conflict exists, got action on %s", a.File.Path)
		}
	}
}

func TestBuildInstallPlanDetectsPowerShellFgrokAliasConflict(t *testing.T) {
	home := t.TempDir()
	profileDir := home + "/Documents/PowerShell"
	mkdirAll(t, profileDir)
	profilePath := profileDir + "/Microsoft.PowerShell_profile.ps1"
	writeFile(t, profilePath, "Set-Alias fgrok 'some-command'\n")
	t.Setenv("HOME", home)

	deps := InstallDeps{
		FunctionNames:           func() []string { return nil },
		LoadManifest:            func() (manifest.Manifest, error) { return manifest.Manifest{}, nil },
		ProfileInstallsShortcut: func(manifest.Profile) bool { return true },
		ResolveSecret:           func(*string) (*string, error) { return nil, nil },
		CurrentForgePath:        func() (string, error) { return "wrenyard", nil },
		ResolveCredential:       func(string) (string, bool) { return "", false },
		IsManagedProvider:       func(string) bool { return false },
	}
	plan, err := BuildInstallPlan(home, "powershell", deps)
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.Conflicts) == 0 {
		t.Fatal("expected a PowerShell conflict for pre-existing fgrok alias")
	}
	found := false
	for _, c := range plan.Conflicts {
		if c.Name == "fgrok" && c.Kind == "alias" {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected PowerShell conflict for fgrok alias, got: %#v", plan.Conflicts)
	}
	// Safe managed file write must be allowed even when conflict exists.
	managedLabel := "write managed PowerShell file"
	if sl := plan.Actions; len(sl) != 1 || sl[0] != managedLabel {
		t.Fatalf("expected only managed file write action when conflict exists, got: %#v", sl)
	}
	// No action should modify the user PowerShell profile when a conflict exists.
	for _, a := range plan.ChangePlan.Actions {
		if a.File != nil && a.File.Path == plan.ProfilePath {
			t.Fatalf("expected no action modifying PowerShell profile when conflict exists, got action on %s", a.File.Path)
		}
	}
}

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}

func mkdirAll(t *testing.T, dir string) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
}
