package forge

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/health/doctor"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/catalog"
)

type codebuddyTestEnvironment struct {
	root         string
	home         string
	appData      string
	localAppData string
}

func isolateCodebuddyTestEnvironment(t *testing.T, home string) codebuddyTestEnvironment {
	t.Helper()
	root := t.TempDir()
	if home == "" {
		home = filepath.Join(root, "home")
	}
	env := codebuddyTestEnvironment{
		root:         root,
		home:         home,
		appData:      filepath.Join(root, "appdata"),
		localAppData: filepath.Join(root, "localappdata"),
	}
	t.Setenv("HOME", env.home)
	t.Setenv("USERPROFILE", env.home)
	t.Setenv("APPDATA", env.appData)
	t.Setenv("LOCALAPPDATA", env.localAppData)
	t.Setenv("FORGE_DSH_BIN", "")
	return env
}

func (env codebuddyTestEnvironment) requireTemporaryPath(t *testing.T, path string) {
	t.Helper()
	rel, err := filepath.Rel(env.root, path)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(rel) {
		t.Fatalf("refusing to use non-temporary CodeBuddy test path %q (root %q)", path, env.root)
	}
}

func TestCodebuddyCLIDoctorCheckBinaryMissing(t *testing.T) {
	env := isolateCodebuddyTestEnvironment(t, "")
	// Empty PATH — no codebuddy to find.
	t.Setenv("PATH", t.TempDir())

	// The isolated shim path starts absent. Guard the path so this test can
	// never remove or overwrite the user's real npm installation.
	shim := codebuddyShimPath()
	env.requireTemporaryPath(t, shim)

	check := codebuddyCLIDoctorCheck()
	if check["status"] != "warning" {
		t.Fatalf("expected warning for missing binary, got %#v", check)
	}
	msg, _ := check["message"].(string)
	if !strings.Contains(msg, "npm install -g @tencent-ai/codebuddy-code") {
		t.Fatalf("expected npm install hint in message, got %s", msg)
	}
	details, _ := check["details"].(map[string]interface{})
	if details["binary"] != "" {
		t.Fatalf("expected empty binary, got %v", details["binary"])
	}
}

func TestCodebuddyCLIDoctorCheckCredentialsMissing(t *testing.T) {
	isolateCodebuddyTestEnvironment(t, "")
	setFakeClientsOnPath(t, "codebuddy")

	check := codebuddyCLIDoctorCheck()
	if check["status"] != "warning" {
		t.Fatalf("expected warning for missing credentials, got %#v", check)
	}
	msg, _ := check["message"].(string)
	if !strings.Contains(msg, "Run codebuddy once interactively") {
		t.Fatalf("expected login hint in credentials message, got %s", msg)
	}
}

func TestCodebuddyCLIDoctorCheckAllOK(t *testing.T) {
	env := isolateCodebuddyTestEnvironment(t, "")
	setFakeClientsOnPath(t, "codebuddy")

	initial := codebuddyCLIDoctorCheck()
	details, _ := initial["details"].(map[string]interface{})
	credsPath, _ := details["credentials_path"].(string)
	env.requireTemporaryPath(t, credsPath)
	credsDir := filepath.Dir(credsPath)
	if err := os.MkdirAll(credsDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(credsPath, []byte(`{"auth":{"accessToken":"fake-test-token"}}`), 0o600); err != nil {
		t.Fatal(err)
	}

	check := codebuddyCLIDoctorCheck()
	if check["status"] != "ok" {
		t.Fatalf("expected ok for healthy CLI, got %#v", check)
	}
}

func TestCodebuddyCLIDoctorCheckRejectsInvalidCredentials(t *testing.T) {
	tests := []struct {
		name    string
		content string
	}{
		{name: "invalid JSON", content: "{"},
		{name: "empty object", content: "{}"},
		{name: "wrong root type", content: "[]"},
		{name: "empty file", content: ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			env := isolateCodebuddyTestEnvironment(t, "")
			setFakeClientsOnPath(t, "codebuddy")

			initial := codebuddyCLIDoctorCheck()
			initialDetails, _ := initial["details"].(map[string]interface{})
			credsPath, _ := initialDetails["credentials_path"].(string)
			env.requireTemporaryPath(t, credsPath)
			if err := os.MkdirAll(filepath.Dir(credsPath), 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(credsPath, []byte(tt.content), 0o600); err != nil {
				t.Fatal(err)
			}

			check := codebuddyCLIDoctorCheck()
			if check["status"] != "warning" {
				t.Fatalf("expected warning for %s, got %#v", tt.name, check)
			}
			details, _ := check["details"].(map[string]interface{})
			if _, ok := details["login_hint"]; !ok {
				t.Fatalf("expected login_hint for %s, got %#v", tt.name, details)
			}
			if _, ok := details["credentials"]; ok {
				t.Fatalf("must not include credentials field for %s: %#v", tt.name, details)
			}
			if _, ok := details["credentials_error"]; ok {
				t.Fatalf("must not include credentials_error field for %s: %#v", tt.name, details)
			}
		})
	}
}

func TestCodebuddyCLIDoctorCheckUsesShimPath(t *testing.T) {
	env := isolateCodebuddyTestEnvironment(t, "")

	// Empty PATH, no binary found there.
	t.Setenv("PATH", t.TempDir())

	// Create the npm shim.
	shim := codebuddyShimPath()
	env.requireTemporaryPath(t, shim)
	if err := os.MkdirAll(filepath.Dir(shim), 0o755); err != nil {
		t.Fatal(err)
	}
	writeFakeExecutable(t, shim, "#!/bin/sh\nexit 0\n")

	check := codebuddyCLIDoctorCheck()
	// Should find the binary (credentials check will warn).
	details, _ := check["details"].(map[string]interface{})
	if details["binary"] != shim {
		t.Fatalf("expected binary %q, got %v", shim, details["binary"])
	}
}

func TestDshCLIDoctorCheckHealthy(t *testing.T) {
	isolateCodebuddyTestEnvironment(t, "")
	binDir := t.TempDir()
	t.Setenv("PATH", binDir)
	t.Setenv("FORGE_DSH_BIN", "")
	writeFakeDSHVersion(t, binDir, "0.1.0-rc.6")
	writeFakeFDSHLauncher(t, binDir)

	check := dshCLIDoctorCheck()
	if check["status"] != "ok" {
		t.Fatalf("expected ok for healthy dsh chain, got %#v", check)
	}
}

func TestDshCLIDoctorCheckMissingIsSkipped(t *testing.T) {
	isolateCodebuddyTestEnvironment(t, "")
	t.Setenv("PATH", t.TempDir())
	t.Setenv("FORGE_DSH_BIN", "")

	if check := dshCLIDoctorCheck(); check != nil {
		t.Fatalf("missing native dsh belongs to installation, got %#v", check)
	}
}

func TestDshCLIDoctorCheckIncompatibleVersion(t *testing.T) {
	isolateCodebuddyTestEnvironment(t, "")
	binDir := t.TempDir()
	t.Setenv("PATH", binDir)
	t.Setenv("FORGE_DSH_BIN", "")
	writeFakeDSHVersion(t, binDir, "0.9.9")

	check := dshCLIDoctorCheck()
	if check["status"] != "error" {
		t.Fatalf("expected error for incompatible dsh version, got %#v", check)
	}
	msg, _ := check["message"].(string)
	if !strings.Contains(msg, "incompatible") {
		t.Fatalf("expected incompatible version error, got %s", msg)
	}
	if strings.Contains(msg, "npm install") {
		t.Fatalf("incompatible version must not prescribe an npm install pin, got %s", msg)
	}
	details, _ := check["details"].(map[string]interface{})
	if details["dsh_version"] != "0.9.9" {
		t.Fatalf("expected recorded dsh version, got %#v", details)
	}
}

func TestDshCLIDoctorCheckBrokenFdsh(t *testing.T) {
	isolateCodebuddyTestEnvironment(t, "")
	binDir := t.TempDir()
	t.Setenv("PATH", binDir)
	t.Setenv("FORGE_DSH_BIN", "")
	writeFakeDSHVersion(t, binDir, "0.1.0-rc.6")
	// fdsh is absent from PATH, so the launcher chain is broken.

	check := dshCLIDoctorCheck()
	if check["status"] != "error" {
		t.Fatalf("expected error for broken fdsh launcher, got %#v", check)
	}
	msg, _ := check["message"].(string)
	if !strings.Contains(msg, "fdsh") {
		t.Fatalf("expected fdsh mention in error, got %s", msg)
	}
	if !strings.Contains(msg, "forge setup") {
		t.Fatalf("expected setup hint in fdsh error, got %s", msg)
	}
}

func TestDshCLIDoctorCheckWindowsFdshWithoutUnixExecBit(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("Windows PATHEXT launcher mode is the regression")
	}
	isolateCodebuddyTestEnvironment(t, "")
	binDir := t.TempDir()
	t.Setenv("PATH", binDir)
	t.Setenv("FORGE_DSH_BIN", "")
	writeFakeDSHVersion(t, binDir, "0.1.0-rc.6")
	fdsh := filepath.Join(binDir, "fdsh.exe")
	if err := os.WriteFile(fdsh, []byte("@echo off\r\nexit /b 0\r\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	check := dshCLIDoctorCheck()
	if check["status"] != "ok" {
		t.Fatalf("expected ok for Windows fdsh.exe without Unix +x, got %#v", check)
	}
}

func writeFakeDSHVersion(t *testing.T, binDir, version string) {
	t.Helper()
	if runtime.GOOS == "windows" {
		writeFakeExecutable(t, filepath.Join(binDir, "dsh.cmd"), "@echo off\r\necho "+version+"\r\n")
		return
	}
	writeFakeExecutable(t, filepath.Join(binDir, "dsh"), "#!/bin/sh\necho '"+version+"'\n")
}

func writeFakeFDSHLauncher(t *testing.T, binDir string) {
	t.Helper()
	if runtime.GOOS == "windows" {
		writeFakeExecutable(t, filepath.Join(binDir, "fdsh.exe"), "@echo off\r\nexit /b 0\r\n")
		return
	}
	writeFakeExecutable(t, filepath.Join(binDir, "fdsh"), "#!/bin/sh\nexit 0\n")
}

func TestCbModelWhitelistCheckAllValid(t *testing.T) {
	// cb-ds and cb-dsf are built-in codebuddy profiles with valid models.
	// With embedded profiles available, the whitelist check should report ok.
	t.Setenv("HOME", t.TempDir())

	check := cbModelWhitelistCheck()
	if check["status"] != "ok" {
		t.Fatalf("expected ok for valid models, got %#v", check)
	}
}

func TestCbModelWhitelistCheckSkipsNonCodebuddy(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	// codex profiles should not be checked against codebuddy whitelist.
	// Both codex-terra and cb-ds are built-in profiles.

	check := cbModelWhitelistCheck()
	if check["status"] != "ok" {
		t.Fatalf("expected ok when non-cb profiles are present, got %#v", check)
	}
}

func TestCbModelWhitelistCheckManifestError(t *testing.T) {
	t.Setenv("FORGE_REPO_DIR", t.TempDir())
	t.Setenv("HOME", t.TempDir())

	// With embedded profiles always available as fallback, loadManifest
	// should succeed and return all embedded codebuddy profiles.
	check := cbModelWhitelistCheck()
	if check["status"] != "ok" {
		t.Fatalf("expected ok when embedded profiles are available, got %#v", check)
	}
}

func TestCbModelWhitelistCheckModelEqualsFlag(t *testing.T) {
	// cb-hy is a built-in codebuddy profile configured via launcher args.
	t.Setenv("HOME", t.TempDir())

	check := cbModelWhitelistCheck()
	if check["status"] != "ok" {
		t.Fatalf("expected ok for --model=value syntax, got %#v", check)
	}
}

func TestCbModelWhitelistCheckLocalCustomProviderUsesOwnBinding(t *testing.T) {
	// A local codebuddy recipe bound to a custom provider is validated against
	// that provider's own registered model set, not the public codebuddy list.
	reg := catalog.NewRegistry()
	reg.RegisterBinding(catalog.Provider{
		Name: "codebuddy", Kind: "builtin",
		AllowedModels: []string{"hunyuan-chat", "deepseek-v4-pro", "deepseek-v4-flash", "kimi-k2.6"},
	})
	reg.RegisterBinding(catalog.Provider{
		Name: "codebuddy-local", Kind: "custom",
		AllowedModels: []string{"vendor-fast", "vendor-pro"},
	})
	manifestFor := func(provider, model string) doctor.ProfileManifest {
		return doctor.ProfileManifest{SchemaVersion: 1, Profiles: map[string]doctor.Profile{
			"local-cb": {
				Client: "codebuddy", Provider: provider,
				Launcher: map[string]interface{}{
					"command":      "codebuddy",
					"default_args": []interface{}{"--model", model},
				},
			},
		}}
	}
	depsFor := func(pm doctor.ProfileManifest) doctor.Dependencies {
		return doctor.Dependencies{
			LoadManifest:    func() (doctor.ProfileManifest, error) { return pm, nil },
			CatalogRegistry: reg,
			GetStringSlice:  stringSliceField,
		}
	}

	// Local codebuddy-local recipe passes against its own registered model set.
	if check := doctor.CBModelWhitelistCheck(depsFor(manifestFor("codebuddy-local", "vendor-fast"))); check["status"] != "ok" {
		t.Fatalf("local codebuddy-local profile must validate against its own model set, got %#v", check)
	}
	// Public codebuddy profile validates against the public model set.
	if check := doctor.CBModelWhitelistCheck(depsFor(manifestFor("codebuddy", "hunyuan-chat"))); check["status"] != "ok" {
		t.Fatalf("public codebuddy profile must validate against public models, got %#v", check)
	}
	// A model outside the custom provider's registered set must warn.
	if check := doctor.CBModelWhitelistCheck(depsFor(manifestFor("codebuddy-local", "claude-sonnet-4.6"))); check["status"] != "warning" {
		t.Fatalf("out-of-set local model must warn, got %#v", check)
	}
}

func TestCbModelWhitelistCheckReadsModelFromProfileEnv(t *testing.T) {
	reg := catalog.NewRegistry()
	reg.RegisterBinding(catalog.Provider{
		Name: "codebuddy", Kind: "builtin",
		AllowedModels: []string{"deepseek-v4-flash"},
	})
	reg.RegisterBinding(catalog.Provider{
		Name: "codebuddy-local", Kind: "custom",
		AllowedModels: []string{"vendor-fast"},
	})
	manifest := doctor.ProfileManifest{SchemaVersion: 1, Profiles: map[string]doctor.Profile{
		"local-cb": {
			Client: "codebuddy", Provider: "codebuddy-local",
			Launcher: map[string]interface{}{"command": "codebuddy"},
			Env:      map[string]string{"ANTHROPIC_MODEL": "vendor-fast"},
		},
	}}
	check := doctor.CBModelWhitelistCheck(doctor.Dependencies{
		LoadManifest:    func() (doctor.ProfileManifest, error) { return manifest, nil },
		CatalogRegistry: reg,
		GetStringSlice:  stringSliceField,
	})
	if check["status"] != "ok" {
		t.Fatalf("profile env model must be validated against its provider binding, got %#v", check)
	}
}

func TestDoctorReportIncludesCodebuddyAdapters(t *testing.T) {
	home := t.TempDir()
	isolateCodebuddyTestEnvironment(t, home)

	report := buildDoctorReport("")
	adapters, _ := report["adapters"].([]string)
	foundCLI := false
	foundModels := false
	for _, a := range adapters {
		if a == "codebuddy-cli" {
			foundCLI = true
		}
		if a == "cb-models" {
			foundModels = true
		}
	}
	if !foundCLI {
		t.Fatalf("expected codebuddy-cli adapter in doctor report, got %v", adapters)
	}
	if !foundModels {
		t.Fatalf("expected cb-models adapter in doctor report, got %v", adapters)
	}
}

func TestDoctorReportInstallationOwnsMissingDSH(t *testing.T) {
	home := t.TempDir()
	isolateCodebuddyTestEnvironment(t, home)
	t.Setenv("PATH", t.TempDir()) // native clients missing on PATH
	t.Setenv("FORGE_DSH_BIN", "")

	report := buildDoctorReport("")
	adapters, _ := report["adapters"].([]string)
	foundInstallation := false
	foundDSHAdapter := false
	for _, a := range adapters {
		if a == "installation" {
			foundInstallation = true
		}
		if a == "dsh" {
			foundDSHAdapter = true
		}
	}
	if !foundInstallation {
		t.Fatalf("expected installation adapter in doctor report, got %v", adapters)
	}
	if !foundDSHAdapter {
		t.Fatalf("expected dsh adapter in doctor report catalog, got %v", adapters)
	}
	checks, _ := report["checks"].([]map[string]interface{})
	var installation map[string]interface{}
	for _, c := range checks {
		if c["adapter"] == "dsh" {
			t.Fatalf("missing native dsh must not emit a dsh protocol check, got %#v", c)
		}
		if c["adapter"] == "installation" {
			installation = c
		}
	}
	if installation == nil {
		t.Fatal("expected an installation entry in doctor checks")
	}
	if installation["status"] != "warning" {
		t.Fatalf("installation status = %v, want warning when native clients are missing", installation["status"])
	}
	var dsh map[string]interface{}
	for _, row := range doctor.InstallationRows(installation) {
		if row["id"] == "dsh" {
			dsh = row
			break
		}
	}
	if dsh["status"] != "missing" {
		t.Fatalf("installation dsh status = %#v, want missing", dsh)
	}
	hint, _ := dsh["hint"].(string)
	if !strings.Contains(hint, "npm install -g @deepseek-ai/dsh") {
		t.Fatalf("missing dsh hint should name the unversioned package, got %q", hint)
	}
	if strings.Contains(hint, "0.1.0-rc.6") {
		t.Fatalf("installation hint must not pin a dsh version, got %q", hint)
	}
	lines := doctor.FormatCheckLines(installation)
	if len(lines) == 0 || lines[0] != "installation:" {
		t.Fatalf("human installation group must start with installation:, got %#v", lines)
	}
	foundDSHLine := false
	for _, line := range lines[1:] {
		if line == "\tdsh missing" {
			foundDSHLine = true
		}
		if strings.Contains(line, "0.1.0-rc.6") {
			t.Fatalf("human installation lines must not pin a dsh version, got %#v", lines)
		}
	}
	if !foundDSHLine {
		t.Fatalf("human installation group must include tabbed dsh missing, got %#v", lines)
	}
}

func TestDoctorReportDSHBrokenAffectsOK(t *testing.T) {
	home := t.TempDir()
	isolateCodebuddyTestEnvironment(t, home)
	binDir := t.TempDir()
	t.Setenv("PATH", binDir)
	// Incompatible dsh binary: the only error in an otherwise isolated env.
	writeFakeDSHVersion(t, binDir, "0.9.9")

	report := buildDoctorReport("")
	if ok, _ := report["ok"].(bool); ok {
		t.Fatal("broken dsh chain must make the full doctor report not ok")
	}
	checks, _ := report["checks"].([]map[string]interface{})
	found := false
	for _, c := range checks {
		if c["adapter"] == "dsh" {
			found = true
			if c["status"] != "error" {
				t.Fatalf("dsh check status = %v, want error for incompatible version", c["status"])
			}
		}
	}
	if !found {
		t.Fatal("expected a dsh entry in doctor checks")
	}
}

func TestCodebuddyProfileModelExtraction(t *testing.T) {
	tests := []struct {
		name    string
		profile profile
		want    string
	}{
		{
			name: "standard --model flag",
			profile: profile{
				Launcher: map[string]interface{}{
					"command":      "codebuddy",
					"default_args": []interface{}{"--model", "deepseek-v4-pro"},
				},
			},
			want: "deepseek-v4-pro",
		},
		{
			name: "--model=value syntax",
			profile: profile{
				Launcher: map[string]interface{}{
					"command":      "codebuddy",
					"default_args": []interface{}{"--model=hunyuan-chat"},
				},
			},
			want: "hunyuan-chat",
		},
		{
			name: "ANTHROPIC_MODEL env fallback",
			profile: profile{
				Launcher: map[string]interface{}{
					"command": "codebuddy",
				},
				Env: map[string]string{"ANTHROPIC_MODEL": "kimi-k2.6"},
			},
			want: "kimi-k2.6",
		},
		{
			name: "launcher flag wins over env",
			profile: profile{
				Launcher: map[string]interface{}{
					"command":      "codebuddy",
					"default_args": []interface{}{"--model", "deepseek-v4-flash"},
				},
				Env: map[string]string{"ANTHROPIC_MODEL": "kimi-k2.6"},
			},
			want: "deepseek-v4-flash",
		},
		{
			name: "no model flag",
			profile: profile{
				Launcher: map[string]interface{}{
					"command":      "codebuddy",
					"default_args": []interface{}{"--verbose"},
				},
			},
			want: "",
		},
		{
			name: "empty default_args",
			profile: profile{
				Launcher: map[string]interface{}{},
			},
			want: "",
		},
		{
			name: "--model without value",
			profile: profile{
				Launcher: map[string]interface{}{
					"default_args": []interface{}{"--model"},
				},
			},
			want: "",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := codebuddyProfileModel(tt.profile)
			if got != tt.want {
				t.Fatalf("codebuddyProfileModel() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestCodebuddyShimPathRespectsAPPDATA(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("APPDATA shim path is Windows-specific")
	}
	t.Setenv("APPDATA", `C:\Users\test\AppData\Roaming`)
	got := codebuddyShimPath()
	want := `C:\Users\test\AppData\Roaming\npm\codebuddy.cmd`
	if got != want {
		t.Fatalf("shim path = %q, want %q", got, want)
	}
}
