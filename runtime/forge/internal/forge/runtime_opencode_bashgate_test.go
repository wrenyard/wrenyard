package forge

import (
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/catalog"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/execution"
	runtimeprofile "github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/profile"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/protocol"
)

type fakeOpenCodeObservation struct {
	Argv               []string `json:"argv"`
	Case               string   `json:"case"`
	Code               int      `json:"code"`
	Decision           string   `json:"decision"`
	Executed           bool     `json:"executed"`
	HookPresent        bool     `json:"hook_present"`
	PluginExact        bool     `json:"plugin_exact"`
	BootstrapBashDeny  bool     `json:"bootstrap_bash_deny"`
	ActiveBashAllow    bool     `json:"active_bash_allow"`
	ReadonlyToolsExact bool     `json:"readonly_tools_exact"`
	EditToolsExact     bool     `json:"edit_tools_exact"`
	Pure               bool     `json:"pure"`
	Client             string   `json:"client"`
	ConfigDir          string   `json:"config_dir"`
}

func TestBuiltFakeOpenCodeBashGateExecutionMatrix(t *testing.T) {
	requireClientExecution(t)
	bin := t.TempDir()
	buildFakeOpenCodeBinary(t, filepath.Join(bin, executableName("opencode")))
	home := setupClaudeFamilyCapabilityPlans(t)
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))

	cases := []struct {
		name      string
		wantAllow bool
	}{
		{name: "safe-and", wantAllow: true},
		{name: "safe-semicolon", wantAllow: true},
		{name: "safe-pipe", wantAllow: true},
		{name: "safe-cr", wantAllow: true},
		{name: "safe-lf", wantAllow: true},
		{name: "safe-crlf", wantAllow: true},
		{name: "notesmd", wantAllow: true},
		{name: "unsafe-and"},
		{name: "unsafe-second"},
		{name: "unsafe-pipe"},
		{name: "single-ampersand"},
		{name: "clustered-unsafe-option"},
		{name: "malformed"},
		{name: "truncated"},
		{name: "unknown-alias"},
		{name: "missing-policy"},
		{name: "guard-process-error"},
		{name: "hook-load-error"},
	}
	for _, mode := range []catalog.PermissionMode{catalog.PermissionReadonly, catalog.PermissionEdit} {
		for _, tc := range cases {
			t.Run(string(mode)+"/"+tc.name, func(t *testing.T) {
				observationPath := filepath.Join(t.TempDir(), "observation.json")
				t.Setenv("FAKE_OPENCODE_OBSERVATION", observationPath)
				t.Setenv("FAKE_OPENCODE_GATE_CASE", tc.name)
				deps := fakeOpenCodeExecutionDependencies(t, home)
				result, err := execution.Execute(execution.Request{
					ProfileName: "opencode-test", Prompt: "exercise OpenCode BashGate", WorkDir: t.TempDir(),
					Permission: mode, Format: protocol.OutputFormatJSON, Capabilities: []string{"notesmd"},
				}, deps, &bytes.Buffer{}, &bytes.Buffer{})
				if err != nil || result.Status != "done" {
					t.Fatalf("fake OpenCode execution result=%+v err=%v", result, err)
				}
				observed := readFakeOpenCodeObservation(t, observationPath)
				wantHookPresent := tc.name != "hook-load-error"
				if observed.HookPresent != wantHookPresent || !observed.PluginExact || !observed.BootstrapBashDeny || !observed.ActiveBashAllow || observed.Pure || observed.Client != "opencode" {
					t.Fatalf("restricted OpenCode production contract = %+v", observed)
				}
				if (mode == catalog.PermissionReadonly && !observed.ReadonlyToolsExact) || (mode == catalog.PermissionEdit && !observed.EditToolsExact) {
					t.Fatalf("%s non-Bash permission contract = %+v", mode, observed)
				}
				if tc.wantAllow {
					if observed.Code != 0 || observed.Decision != "allow" || !observed.Executed {
						t.Fatalf("allowed OpenCode case %s = %+v", tc.name, observed)
					}
				} else if observed.Code != 2 || observed.Decision != "deny" || observed.Executed {
					t.Fatalf("denied OpenCode case %s = %+v", tc.name, observed)
				}
				if _, statErr := os.Stat(observed.ConfigDir); !os.IsNotExist(statErr) {
					t.Fatalf("successful OpenCode execution retained run resources: %v", statErr)
				}
			})
		}
	}
}

func TestBuiltFakeOpenCodeAbnormalRunRetainsResources(t *testing.T) {
	requireClientExecution(t)
	bin := t.TempDir()
	buildFakeOpenCodeBinary(t, filepath.Join(bin, executableName("opencode")))
	home := setupClaudeFamilyCapabilityPlans(t)
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	observationPath := filepath.Join(t.TempDir(), "abnormal.json")
	t.Setenv("FAKE_OPENCODE_OBSERVATION", observationPath)
	t.Setenv("FAKE_OPENCODE_GATE_CASE", "safe-and")
	t.Setenv("FAKE_OPENCODE_ABNORMAL", "1")
	result, err := execution.Execute(execution.Request{
		ProfileName: "opencode-test", Prompt: "retain abnormal resources", WorkDir: t.TempDir(),
		Permission: catalog.PermissionReadonly, Format: protocol.OutputFormatJSON,
	}, fakeOpenCodeExecutionDependencies(t, home), &bytes.Buffer{}, &bytes.Buffer{})
	if err == nil || result.Status != "failed" || result.ExitCode != 7 {
		t.Fatalf("fake OpenCode abnormal result=%+v err=%v", result, err)
	}
	observed := readFakeOpenCodeObservation(t, observationPath)
	if info, statErr := os.Stat(observed.ConfigDir); statErr != nil || !info.IsDir() {
		t.Fatalf("abnormal OpenCode execution did not retain run resources: %v", statErr)
	}
}

func TestBuiltFakeOpenCodeYoloBypassesRestrictedPlugin(t *testing.T) {
	requireClientExecution(t)
	bin := t.TempDir()
	buildFakeOpenCodeBinary(t, filepath.Join(bin, executableName("opencode")))
	home := setupClaudeFamilyCapabilityPlans(t)
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	observationPath := filepath.Join(t.TempDir(), "yolo.json")
	t.Setenv("FAKE_OPENCODE_OBSERVATION", observationPath)
	t.Setenv("FAKE_OPENCODE_GATE_CASE", "unsafe-second")
	result, err := execution.Execute(execution.Request{
		ProfileName: "opencode-test", Prompt: "exercise yolo", WorkDir: t.TempDir(),
		Permission: catalog.PermissionYolo, Format: protocol.OutputFormatJSON,
	}, fakeOpenCodeExecutionDependencies(t, home), &bytes.Buffer{}, &bytes.Buffer{})
	if err != nil || result.Status != "done" {
		t.Fatalf("fake OpenCode yolo result=%+v err=%v", result, err)
	}
	observed := readFakeOpenCodeObservation(t, observationPath)
	if observed.HookPresent || observed.BootstrapBashDeny || !observed.Executed || observed.Decision != "unrestricted" || !observed.Pure {
		t.Fatalf("OpenCode yolo boundary = %+v", observed)
	}
	if _, statErr := os.Stat(observed.ConfigDir); !os.IsNotExist(statErr) {
		t.Fatalf("successful yolo execution retained run resources: %v", statErr)
	}
}

func buildFakeOpenCodeBinary(t *testing.T, target string) {
	t.Helper()
	cmd := exec.Command("go", "build", "-o", target, "./testdata/fake_opencode")
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("build fake OpenCode client: %v\n%s", err, output)
	}
}

func fakeOpenCodeExecutionDependencies(t *testing.T, dataHome string) execution.Dependencies {
	t.Helper()
	deps := executionDependencies()
	deps.DataDir = filepath.Join(dataHome, "forge-data")
	deps.LoadProfile = func(name string) (execution.ProfileDefinition, bool, error) {
		if name != "opencode-test" {
			return execution.ProfileDefinition{}, false, nil
		}
		return execution.ProfileDefinition{
			Name: name, Client: "opencode", Provider: "opencode-native",
			Launcher: map[string]interface{}{"command": "opencode"}, Env: map[string]string{}, Settings: map[string]interface{}{},
		}, true, nil
	}
	deps.ResolveProfile = func(def execution.ProfileDefinition) (runtimeprofile.ResolvedProfile, error) {
		desc, err := catalog.DefaultRegistry().LookupDescriptor("opencode")
		if err != nil {
			return runtimeprofile.ResolvedProfile{}, err
		}
		provider, err := catalog.DefaultRegistry().LookupBinding("opencode-native")
		if err != nil {
			return runtimeprofile.ResolvedProfile{}, err
		}
		return runtimeprofile.ResolvedProfile{Client: desc, Provider: provider, Compatibility: runtimeprofile.CompatibilityNone}, nil
	}
	return deps
}

func readFakeOpenCodeObservation(t *testing.T, path string) fakeOpenCodeObservation {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var observed fakeOpenCodeObservation
	if err := json.Unmarshal(data, &observed); err != nil {
		t.Fatal(err)
	}
	return observed
}
