package forge

import (
	"bytes"
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

const installedCodexMCPEnv = "FORGE_TEST_INSTALLED_CODEX_MCP"

func TestInstalledCodex01441RestrictedMCPAndYoloSmoke(t *testing.T) {
	if os.Getenv(installedCodexMCPEnv) != "1" {
		t.Skipf("set %s=1 to run the installed Codex MCP contract smoke", installedCodexMCPEnv)
	}
	codexPath, err := exec.LookPath("codex")
	if err != nil {
		t.Fatal("installed Codex 0.144.1 is unavailable")
	}
	versionCtx, versionCancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer versionCancel()
	versionOutput, err := exec.CommandContext(versionCtx, codexPath, "--version").Output()
	if err != nil || !strings.Contains(string(versionOutput), "0.144.1") {
		t.Fatalf("installed Codex version contract mismatch: err=%v", err)
	}

	root, err := filepath.Abs(filepath.Join("..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	forgeBinary := filepath.Join(t.TempDir(), executableName("forge-real-smoke"))
	build := exec.Command("go", "build", "-o", forgeBinary, "./cmd/forge")
	build.Dir = root
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build installed Codex smoke Forge: %v\n%s", err, output)
	}
	dataHome := t.TempDir()

	t.Run("readonly MCP and Agent unavailable", func(t *testing.T) {
		workDir := t.TempDir()
		marker := "FORGE_REAL_READONLY_MARKER_7E8A3C"
		if err := os.WriteFile(filepath.Join(workDir, "marker.txt"), []byte(marker+"\n"), 0o600); err != nil {
			t.Fatal(err)
		}
		command := "pwd; cat marker.txt"
		if runtime.GOOS == "windows" {
			command = "Get-Location; Get-Content marker.txt"
		}
		prompt := "Perform a deterministic tool-contract smoke. Use only the MCP server forge_bash tool bash, exactly once, with command exactly " + quoted(command) + " and cwd exactly " + quoted(workDir) + ". Do not use any native shell or file-reading tool. The Agent/spawn_agent tool must be unavailable; do not substitute another tool. After the MCP result respond exactly: FORGE_REAL_READONLY_OK AGENT_UNAVAILABLE " + marker
		output, err := runInstalledCodexForge(forgeBinary, dataHome, workDir, "readonly", prompt, 3*time.Minute)
		if err != nil || !strings.Contains(output, "FORGE_REAL_READONLY_OK AGENT_UNAVAILABLE "+marker) {
			t.Fatalf("installed readonly MCP contract failed: err=%v output=%s", err, boundedSmokeOutput(output))
		}
	})

	t.Run("denied command preserves sentinel", func(t *testing.T) {
		workDir := t.TempDir()
		sentinel := filepath.Join(workDir, "sentinel.txt")
		if err := os.WriteFile(sentinel, []byte("FORGE_REAL_SENTINEL_PRESERVE\n"), 0o600); err != nil {
			t.Fatal(err)
		}
		command := "pwd; echo changed > sentinel.txt"
		if runtime.GOOS == "windows" {
			command = "Get-Location; Set-Content sentinel.txt changed"
		}
		prompt := "Use only the MCP server forge_bash tool bash, exactly once, with command exactly " + quoted(command) + " and cwd exactly " + quoted(workDir) + ". The call must be denied by Forge. Do not use another tool. Then respond exactly: FORGE_REAL_DENIED_OK"
		output, err := runInstalledCodexForge(forgeBinary, dataHome, workDir, "readonly", prompt, 3*time.Minute)
		if err != nil || !strings.Contains(output, "FORGE_REAL_DENIED_OK") {
			t.Fatalf("installed denied-command contract failed: err=%v output=%s", err, boundedSmokeOutput(output))
		}
		if data, readErr := os.ReadFile(sentinel); readErr != nil || string(data) != "FORGE_REAL_SENTINEL_PRESERVE\n" {
			t.Fatalf("installed denied command changed sentinel: data=%q err=%v", data, readErr)
		}
	})

	t.Run("yolo native shell and Agent", func(t *testing.T) {
		workDir := t.TempDir()
		command := "printf FORGE_REAL_YOLO_SHELL > yolo.txt"
		if runtime.GOOS == "windows" {
			command = "Set-Content yolo.txt FORGE_REAL_YOLO_SHELL"
		}
		prompt := "Perform a deterministic yolo compatibility smoke. First use the native shell tool, not MCP, exactly once with command " + quoted(command) + ". Then call spawn_agent exactly once and ask it to return FORGE_REAL_YOLO_AGENT; wait for it. Finally respond exactly: FORGE_REAL_YOLO_OK FORGE_REAL_YOLO_AGENT"
		output, err := runInstalledCodexForge(forgeBinary, dataHome, workDir, "yolo", prompt, 4*time.Minute)
		if err != nil || !strings.Contains(output, "FORGE_REAL_YOLO_OK FORGE_REAL_YOLO_AGENT") {
			t.Fatalf("installed yolo contract failed: err=%v output=%s", err, boundedSmokeOutput(output))
		}
		if data, readErr := os.ReadFile(filepath.Join(workDir, "yolo.txt")); readErr != nil || !strings.Contains(string(data), "FORGE_REAL_YOLO_SHELL") {
			t.Fatalf("installed yolo native shell result=%q err=%v", data, readErr)
		}
	})

	t.Run("strict unknown config fails", func(t *testing.T) {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		cmd := exec.CommandContext(ctx, codexPath, "exec", "--strict-config", "--ignore-user-config", "-c", "forge_unknown_config_key=true", "-")
		cmd.Stdin = strings.NewReader("unknown config must fail before a turn")
		if output, err := cmd.CombinedOutput(); err == nil || ctx.Err() != nil || len(output) == 0 {
			t.Fatalf("installed strict unknown config did not fail cleanly: err=%v timeout=%v", err, ctx.Err())
		}
	})
}

func runInstalledCodexForge(forgeBinary, dataHome, workDir, permission, prompt string, timeout time.Duration) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, forgeBinary,
		"-p", "codex-sol", "--permission", permission, "-C", workDir, "-f", "json", prompt,
	)
	cmd.Env = append(os.Environ(),
		"XDG_DATA_HOME="+dataHome,
		"XDG_CONFIG_HOME="+filepath.Join(dataHome, "config"),
	)
	var output bytes.Buffer
	cmd.Stdout = &output
	cmd.Stderr = &output
	err := cmd.Run()
	if ctx.Err() != nil {
		return output.String(), ctx.Err()
	}
	return output.String(), err
}

func quoted(value string) string {
	return `"` + strings.ReplaceAll(value, `"`, `'`) + `"`
}

func boundedSmokeOutput(value string) string {
	value = strings.ToValidUTF8(value, "�")
	if len(value) > 2000 {
		value = value[len(value)-2000:]
	}
	return value
}
