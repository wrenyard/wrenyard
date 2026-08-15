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

func TestBuiltFakeCodexRestrictedMCPAndYoloContract(t *testing.T) {
	forgeBinary, fakeCodex, home := buildFakeCodexE2EBinaries(t)
	userConfig := filepath.Join(home, ".codex", "config.toml")
	if err := os.WriteFile(userConfig, []byte("[features]\nshell_tool = true\nmulti_agent = true\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	t.Run("readonly safe compound", func(t *testing.T) {
		workDir := t.TempDir()
		if err := os.WriteFile(filepath.Join(workDir, "marker.txt"), []byte("FORGE_CODEX_MCP_SAFE\n"), 0o600); err != nil {
			t.Fatal(err)
		}
		observed, output, err := runFakeCodexForge(t, forgeBinary, fakeCodex, home, workDir, "readonly", "readonly-safe", false)
		if err != nil || !strings.Contains(output, "FAKE_CODEX_FINAL") {
			t.Fatalf("readonly safe err=%v output=%s", err, output)
		}
		assertRestrictedFakeCodex(t, observed, "read-only")
		if observed.MCPCallError || !strings.Contains(observed.MCPCallText, "FORGE_CODEX_MCP_SAFE") {
			t.Fatalf("safe MCP call = %+v", observed)
		}
		assertRemovedFakeCodexResource(t, observed.MCPConfigDir)
	})

	t.Run("readonly unsafe and Agent unavailable", func(t *testing.T) {
		workDir := t.TempDir()
		sentinel := filepath.Join(workDir, "sentinel.txt")
		if err := os.WriteFile(sentinel, []byte("preserve\n"), 0o600); err != nil {
			t.Fatal(err)
		}
		observed, _, err := runFakeCodexForge(t, forgeBinary, fakeCodex, home, workDir, "readonly", "readonly-unsafe", false)
		if err != nil {
			t.Fatal(err)
		}
		assertRestrictedFakeCodex(t, observed, "read-only")
		if !observed.MCPCallError || !strings.Contains(observed.MCPCallText, "EffectiveBashAllow") || observed.Agent {
			t.Fatalf("unsafe/Agent restricted contract = %+v", observed)
		}
		if data, readErr := os.ReadFile(sentinel); readErr != nil || string(data) != "preserve\n" {
			t.Fatalf("unsafe fake Codex changed sentinel: data=%q err=%v", data, readErr)
		}
		assertRemovedFakeCodexResource(t, observed.MCPConfigDir)
	})

	t.Run("edit within policy", func(t *testing.T) {
		workDir := t.TempDir()
		observed, _, err := runFakeCodexForge(t, forgeBinary, fakeCodex, home, workDir, "edit", "edit", false)
		if err != nil {
			t.Fatal(err)
		}
		assertRestrictedFakeCodex(t, observed, "workspace-write")
		if observed.MCPCallError {
			t.Fatalf("edit MCP call = %+v", observed)
		}
		if info, statErr := os.Stat(filepath.Join(workDir, "edited.txt")); statErr != nil || !info.Mode().IsRegular() {
			t.Fatalf("edit command did not create file: %v", statErr)
		}
		assertRemovedFakeCodexResource(t, observed.MCPConfigDir)
	})

	t.Run("yolo native shell and Agent", func(t *testing.T) {
		workDir := t.TempDir()
		observed, _, err := runFakeCodexForge(t, forgeBinary, fakeCodex, home, workDir, "yolo", "yolo", false)
		if err != nil {
			t.Fatal(err)
		}
		if !observed.StrictConfig || !observed.IgnoreUserConfig || !observed.ShellTool || !observed.Agent || observed.Sandbox != "danger-full-access" || observed.MCPRegistered || observed.MCPConfigDir != "" || !observed.NativeExecuted {
			t.Fatalf("yolo contract = %+v", observed)
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
	if info, statErr := os.Stat(observed.MCPConfigDir); statErr != nil || !info.IsDir() {
		t.Fatalf("abnormal Codex run did not retain MCP policy resource: %v", statErr)
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

func assertRestrictedFakeCodex(t *testing.T, observed fakeCodexObservation, sandbox string) {
	t.Helper()
	if !observed.StrictConfig || !observed.IgnoreUserConfig || observed.ShellTool || observed.Agent || observed.Sandbox != sandbox || !observed.MCPRegistered || !observed.MCPRequired || !observed.MCPToolExact || observed.MCPConfigDir == "" {
		t.Fatalf("restricted fake Codex contract = %+v", observed)
	}
}

func assertRemovedFakeCodexResource(t *testing.T, path string) {
	t.Helper()
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("successful fake Codex run retained resource %q: %v", path, err)
	}
}
