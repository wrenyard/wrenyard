package forge

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type fakeCodexObservation struct {
	Argv             []string `json:"argv"`
	Case             string   `json:"case"`
	StrictConfig     bool     `json:"strict_config"`
	IgnoreUserConfig bool     `json:"ignore_user_config"`
	ShellTool        bool     `json:"shell_tool"`
	Agent            bool     `json:"agent"`
	Sandbox          string   `json:"sandbox"`
	MCPRegistered    bool     `json:"mcp_registered"`
	MCPRequired      bool     `json:"mcp_required"`
	MCPToolExact     bool     `json:"mcp_tool_exact"`
	MCPCallError     bool     `json:"mcp_call_error"`
	MCPCallText      string   `json:"mcp_call_text"`
	MCPConfigDir     string   `json:"mcp_config_dir"`
	NativeExecuted   bool     `json:"native_executed"`
}

// TestBuiltFakeCodexRestrictedMCPAndYoloContract exercises the built forge
// binary end to end. Every legacy permission spelling now normalizes to YOLO at
// the production boundary, so the restricted Codex MCP guard is unreachable
// from production: the fake Codex is never handed a `forge_bash` MCP server and
// runs with native unrestricted execution instead.
//
// This is an expected removal of the restricted guard, not a capability loss:
// the YOLO contract still isolates config (--strict-config/--ignore-user-config)
// and enables the native shell/Agent features. The dormant restricted encoders
// keep their focused low-level coverage in the driver package
// (TestCodexRestrictedPlansDisableNativeExecutionAndRegisterExactRequiredMCP).
func TestBuiltFakeCodexRestrictedMCPAndYoloContract(t *testing.T) {
	forgeBinary, fakeCodex, home := buildFakeCodexE2EBinaries(t)
	userConfig := filepath.Join(home, ".codex", "config.toml")
	if err := os.WriteFile(userConfig, []byte("[features]\nshell_tool = true\nmulti_agent = true\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	for _, tc := range []struct {
		name       string
		permission string
		caseName   string
		callsMCP   bool
	}{
		{"readonly normalizes to yolo", "readonly", "readonly-safe", true},
		{"edit normalizes to yolo", "edit", "edit", true},
		{"yolo stays yolo", "yolo", "yolo", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			workDir := t.TempDir()
			if err := os.WriteFile(filepath.Join(workDir, "marker.txt"), []byte("FORGE_CODEX_MCP_SAFE\n"), 0o600); err != nil {
				t.Fatal(err)
			}
			observed, output, err := runFakeCodexForge(t, forgeBinary, fakeCodex, home, workDir, tc.permission, tc.caseName, false)
			if err != nil || !strings.Contains(output, "FAKE_CODEX_FINAL") {
				t.Fatalf("%s err=%v output=%s", tc.name, err, output)
			}
			assertYoloFakeCodex(t, observed)
			// The restricted guard is gone: no forge_bash MCP server is
			// registered and no MCP policy resource is materialized.
			if observed.MCPRegistered || observed.MCPRequired || observed.MCPToolExact || observed.MCPConfigDir != "" {
				t.Fatalf("%s unexpectedly retained the restricted MCP guard: %+v", tc.name, observed)
			}
			if tc.callsMCP {
				// The MCP call path is therefore absent, matching "MCP
				// registration missing" — expected YOLO behavior, not a failure.
				if !observed.MCPCallError || !strings.Contains(observed.MCPCallText, "MCP registration missing") {
					t.Fatalf("%s MCP call without registration = %+v", tc.name, observed)
				}
			}
		})
	}

	t.Run("yolo native shell and Agent", func(t *testing.T) {
		workDir := t.TempDir()
		observed, _, err := runFakeCodexForge(t, forgeBinary, fakeCodex, home, workDir, "yolo", "yolo", false)
		if err != nil {
			t.Fatal(err)
		}
		assertYoloFakeCodex(t, observed)
		if !observed.NativeExecuted {
			t.Fatalf("yolo native shell did not execute: %+v", observed)
		}
		if data, readErr := os.ReadFile(filepath.Join(workDir, "yolo.txt")); readErr != nil || !strings.Contains(string(data), "unrestricted") {
			t.Fatalf("yolo native shell result=%q err=%v", data, readErr)
		}
	})

	current, err := os.ReadFile(userConfig)
	if err != nil || string(current) != "[features]\nshell_tool = true\nmulti_agent = true\n" {
		t.Fatalf("fake E2E mutated user config: bytes=%q err=%v", current, err)
	}
}

func TestBuiltFakeCodexAbnormalRetentionAndStrictUnknownConfigFailure(t *testing.T) {
	forgeBinary, fakeCodex, home := buildFakeCodexE2EBinaries(t)
	workDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(workDir, "marker.txt"), []byte("retain\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	observed, _, err := runFakeCodexForge(t, forgeBinary, fakeCodex, home, workDir, "readonly", "readonly-safe", true)
	if err == nil {
		t.Fatal("abnormal fake Codex run unexpectedly succeeded")
	}
	// Under the production YOLO boundary there is no restricted MCP policy
	// resource to retain or clean up, so an abnormal run must leave no MCP
	// config directory behind at all.
	if observed.MCPConfigDir != "" {
		t.Fatalf("abnormal YOLO Codex run unexpectedly materialized an MCP resource: %q", observed.MCPConfigDir)
	}
	if observed.MCPRegistered {
		t.Fatalf("abnormal YOLO Codex run registered the restricted MCP guard: %+v", observed)
	}

	cmd := exec.Command(fakeCodex, "exec", "--strict-config", "-c", "unknown.forge_setting=true", "-")
	cmd.Stdin = strings.NewReader("strict unknown config")
	if output, runErr := cmd.CombinedOutput(); runErr == nil || !strings.Contains(string(output), "unknown configuration key") {
		t.Fatalf("strict unknown config did not fail: err=%v output=%s", runErr, output)
	}
}

func buildFakeCodexE2EBinaries(t *testing.T) (forgeBinary, fakeCodex, home string) {
	t.Helper()
	root, err := filepath.Abs(filepath.Join("..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	bin := t.TempDir()
	forgeBinary = filepath.Join(bin, executableName("forge"))
	fakeCodex = filepath.Join(bin, executableName("codex"))
	for target, source := range map[string]string{
		forgeBinary: "./cmd/forge",
		fakeCodex:   "./internal/forge/testdata/fake_codex",
	} {
		cmd := exec.Command("go", "build", "-o", target, source)
		cmd.Dir = root
		if output, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("build %s: %v\n%s", source, err, output)
		}
	}
	home = t.TempDir()
	if err := os.MkdirAll(filepath.Join(home, ".codex"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, ".codex", "auth.json"), []byte(`{"tokens":{"access_token":"fake-token"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	return forgeBinary, fakeCodex, home
}

func runFakeCodexForge(t *testing.T, forgeBinary, fakeCodex, home, workDir, permission, caseName string, abnormal bool) (fakeCodexObservation, string, error) {
	t.Helper()
	observationPath := filepath.Join(t.TempDir(), "observation.json")
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, forgeBinary,
		"-p", "codex-sol", "--permission", permission, "-C", workDir, "-f", "json", "exercise fake Codex contract",
	)
	path := filepath.Dir(fakeCodex) + string(os.PathListSeparator) + os.Getenv("PATH")
	cmd.Env = append(os.Environ(),
		"HOME="+home,
		"USERPROFILE="+home,
		"CODEX_HOME=",
		"XDG_DATA_HOME="+filepath.Join(home, "data"),
		"XDG_CONFIG_HOME="+filepath.Join(home, "config"),
		"PATH="+path,
		"FAKE_CODEX_CASE="+caseName,
		"FAKE_CODEX_OBSERVATION="+observationPath,
	)
	if abnormal {
		cmd.Env = append(cmd.Env, "FAKE_CODEX_ABNORMAL=1")
	}
	var output bytes.Buffer
	cmd.Stdout = &output
	cmd.Stderr = &output
	runErr := cmd.Run()
	if ctx.Err() != nil {
		t.Fatalf("fake Codex E2E timed out: %v output=%s", ctx.Err(), output.String())
	}
	data, err := os.ReadFile(observationPath)
	if err != nil {
		t.Fatalf("read fake Codex observation: %v output=%s", err, output.String())
	}
	var observed fakeCodexObservation
	if err := json.Unmarshal(data, &observed); err != nil {
		t.Fatal(err)
	}
	return observed, output.String(), runErr
}

// assertYoloFakeCodex pins the production Codex contract: config isolation and
// the native shell/Agent features are retained, the run is fully unrestricted,
// and no restricted forge_bash MCP server is registered.
func assertYoloFakeCodex(t *testing.T, observed fakeCodexObservation) {
	t.Helper()
	if !observed.StrictConfig || !observed.IgnoreUserConfig || !observed.ShellTool || !observed.Agent ||
		observed.Sandbox != "danger-full-access" || observed.MCPRegistered || observed.MCPRequired ||
		observed.MCPToolExact || observed.MCPConfigDir != "" {
		t.Fatalf("yolo fake Codex contract = %+v", observed)
	}
	if len(observed.Argv) == 0 || observed.Argv[len(observed.Argv)-1] != "-" {
		t.Fatalf("yolo fake Codex argv did not end with the prompt stdin marker: %v", observed.Argv)
	}
}
