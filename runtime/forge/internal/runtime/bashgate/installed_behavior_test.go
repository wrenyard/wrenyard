package bashgate

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/catalog"
)

const installedClaudeBashGateEnv = "FORGE_TEST_INSTALLED_CLAUDE_BASHGATE"

func TestInstalledClaudeCompoundCommandsUseFailClosedBashGate(t *testing.T) {
	if os.Getenv(installedClaudeBashGateEnv) != "1" {
		t.Skipf("set %s=1 to run the installed Claude local-mock contract", installedClaudeBashGateEnv)
	}
	claudePath := buildInstalledFakeClaude(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	versionOutput, err := exec.CommandContext(ctx, claudePath, "--version").CombinedOutput()
	if err != nil {
		t.Fatalf("installed Claude is unavailable: %v", err)
	}
	if len(bytes.TrimSpace(versionOutput)) == 0 {
		t.Fatalf("installed Claude returned empty --version output")
	}

	forgeBinary := buildInstalledProbeForge(t)
	allow, err := catalog.EffectiveBashAllow(catalog.PolicyFor(catalog.PermissionReadonly), nil)
	if err != nil {
		t.Fatal(err)
	}
	policy, err := EncodePolicy(ClientClaude, allow, nil, nil)
	if err != nil {
		t.Fatal(err)
	}

	cases := []struct {
		name         string
		commandCase  string
		wantExitCode int
	}{
		{name: "safe cat chain", commandCase: "safe-cat-chain", wantExitCode: 0},
		{name: "rm second segment", commandCase: "rm-second", wantExitCode: 2},
		{name: "tee second segment", commandCase: "tee-second", wantExitCode: 2},
		{name: "single ampersand", commandCase: "single-ampersand", wantExitCode: 2},
		{name: "clustered tree output", commandCase: "clustered-tree-output", wantExitCode: 2},
		{name: "clustered file magic", commandCase: "clustered-file-magic", wantExitCode: 2},
		{name: "clustered git pager", commandCase: "clustered-git-pager", wantExitCode: 2},
		{name: "ripgrep helper", commandCase: "ripgrep-helper", wantExitCode: 2},
		{name: "cleaned proc environment alias", commandCase: "proc-clean-alias", wantExitCode: 2},
		{name: "proc environment glob", commandCase: "proc-env-glob", wantExitCode: 2},
		{name: "Windows environment provider glob", commandCase: "windows-env-provider-glob", wantExitCode: 2},
		{name: "malformed input", commandCase: "malformed", wantExitCode: 2},
	}
	if runtime.GOOS == "windows" {
		cases = append(cases,
			struct {
				name         string
				commandCase  string
				wantExitCode int
			}{name: "cmd backslash pipe", commandCase: "cmd-backslash-pipe", wantExitCode: 2},
			struct {
				name         string
				commandCase  string
				wantExitCode int
			}{name: "PowerShell backslash semicolon", commandCase: "powershell-backslash-semicolon", wantExitCode: 2},
		)
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			hookExecutable := forgeBinary
			settings, settingsErr := ClaudeFamilySettingsBytes(hookExecutable)
			if settingsErr != nil {
				t.Fatal(settingsErr)
			}

			workDir := t.TempDir()
			if err := os.WriteFile(filepath.Join(workDir, "harmless.txt"), []byte("SAFE_ONE\n"), 0o600); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(workDir, "harmless-two.txt"), []byte("SAFE_TWO\n"), 0o600); err != nil {
				t.Fatal(err)
			}
			victim := filepath.Join(workDir, "victim.txt")
			if err := os.WriteFile(victim, []byte("PRESERVE\n"), 0o600); err != nil {
				t.Fatal(err)
			}
			observationPath := filepath.Join(t.TempDir(), "observation.json")

			ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
			defer cancel()
			cmd := exec.CommandContext(ctx, claudePath,
				"-p", "run the supplied local probe", "--model", "claude-sonnet-4-5",
				"--output-format", "json", "--permission-mode", "dontAsk", "--tools", "Bash",
				"--allowedTools", "Bash(*)", "--settings", string(settings), "--no-session-persistence",
			)
			cmd.Dir = workDir
			cmd.Env = installedProbeEnv(t, policy, hookExecutable)
			cmd.Env = append(cmd.Env,
				"FAKE_CLAUDE_GATE_CASE="+tc.commandCase,
				"FAKE_CLAUDE_OBSERVATION="+observationPath,
				"FAKE_CLAUDE_EXIT_ON_DENY=1",
			)
			output, runErr := cmd.CombinedOutput()
			if ctx.Err() != nil {
				t.Fatalf("installed Claude probe timed out: %v", ctx.Err())
			}

			exitCode := 0
			if runErr != nil {
				var exitErr *exec.ExitError
				if !errors.As(runErr, &exitErr) {
					t.Fatalf("installed Claude probe failed: %v; output=%s", runErr, output)
				}
				exitCode = exitErr.ExitCode()
			}
			if exitCode != tc.wantExitCode {
				t.Fatalf("installed Claude probe exit %d want %d; output=%s", exitCode, tc.wantExitCode, output)
			}

			observation := readInstalledFakeClaudeObservation(t, observationPath)
			if observation.Client != "claude" {
				t.Fatalf("installed fake Claude not wired: %+v", observation)
			}
			if !observation.HookOutputSafe {
				t.Fatalf("hook output exposed sensitive data; observation=%+v output=%s", observation, output)
			}
			if tc.wantExitCode == 0 {
				if !observation.Executed || observation.Code != 0 || observation.Decision != "allow" {
					t.Fatalf("unexpected allow observation: %+v output=%s", observation, output)
				}
			} else {
				if observation.Executed || observation.Code != 2 || observation.Decision != "deny" {
					t.Fatalf("unexpected deny observation: %+v output=%s", observation, output)
				}
			}
			victimBytes, readErr := os.ReadFile(victim)
			if readErr != nil || string(victimBytes) != "PRESERVE\n" {
				t.Fatalf("restricted compound command changed victim: bytes=%q err=%v", victimBytes, readErr)
			}
		})
	}
}

func buildInstalledFakeClaude(t *testing.T) string {
	t.Helper()
	name := "fake-claude"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	versionsDir := installedVersionsDir()
	if err := os.MkdirAll(versionsDir, 0o755); err != nil {
		t.Fatal(err)
	}
	root, err := os.MkdirTemp(versionsDir, "forge hook path with spaces")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = os.RemoveAll(root)
	})
	path := filepath.Join(root, name)
	cmd := exec.Command("go", "build", "-o", path, "../../../internal/forge/testdata/fake_claude_family")
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("build local mock Claude binary: %v\n%s", err, output)
	}
	resolvedVersionsDir, _ := filepath.Abs(versionsDir)
	resolvedPath, _ := filepath.Abs(path)
	rel, err := filepath.Rel(resolvedVersionsDir, resolvedPath)
	if err != nil || rel == "" || rel == "." || strings.HasPrefix(rel, "..") {
		t.Fatalf("resolved probe binary escaped versions dir: %q", path)
	}
	return path
}

func buildInstalledProbeForge(t *testing.T) string {
	t.Helper()
	name := "forge-installed-hook-probe"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	versionsDir := installedVersionsDir()
	if err := os.MkdirAll(versionsDir, 0o755); err != nil {
		t.Fatal(err)
	}
	root, err := os.MkdirTemp(versionsDir, "forge hook path with spaces")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = os.RemoveAll(root)
	})
	path := filepath.Join(root, name)
	cmd := exec.Command("go", "build", "-o", path, "../../../cmd/forge")
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("build installed-hook Forge binary: %v\n%s", err, output)
	}
	resolvedVersionsDir, _ := filepath.Abs(versionsDir)
	resolvedPath, _ := filepath.Abs(path)
	rel, err := filepath.Rel(resolvedVersionsDir, resolvedPath)
	if err != nil || rel == "" || rel == "." || strings.HasPrefix(rel, "..") {
		t.Fatalf("resolved probe binary escaped versions dir: %q", path)
	}
	return path
}

func installedVersionsDir() string {
	dataHome := strings.TrimSpace(os.Getenv("XDG_DATA_HOME"))
	if dataHome == "" {
		home := strings.TrimSpace(os.Getenv("HOME"))
		if home == "" {
			home = strings.TrimSpace(os.Getenv("USERPROFILE"))
		}
		if home == "" {
			home = os.Getenv("HOMEDRIVE") + os.Getenv("HOMEPATH")
		}
		if home == "" {
			homeDir, err := os.UserHomeDir()
			if err != nil {
				return ""
			}
			home = homeDir
		}
		dataHome = filepath.Join(home, ".local", "share")
	}
	return filepath.Join(dataHome, "wrenyard", "runtime", "versions")
}

func installedProbeEnv(t *testing.T, policy, hookExecutable string) []string {
	t.Helper()
	blocked := []string{"ANTHROPIC_", "CLAUDE_", "FORGE_INTERNAL_BASH_GATE_"}
	configDir := filepath.Join(t.TempDir(), "installed-claude-config")
	if err := os.MkdirAll(configDir, 0o700); err != nil {
		t.Fatal(err)
	}
	env := make([]string, 0, len(os.Environ())+8)
	for _, entry := range os.Environ() {
		envName, _, ok := strings.Cut(entry, "=")
		if !ok {
			continue
		}
		upper := strings.ToUpper(envName)
		skip := false
		for _, prefix := range blocked {
			if strings.HasPrefix(upper, prefix) {
				skip = true
				break
			}
		}
		if !skip && !strings.EqualFold(envName, "MSYS2_ARG_CONV_EXCL") {
			env = append(env, entry)
		}
	}
	env = append(env,
		"CLAUDE_CONFIG_DIR="+configDir,
		"CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1",
		"DISABLE_TELEMETRY=1",
		ModeEnv+"="+string(ClientClaude),
		PolicyEnv+"="+policy,
	)
	hookEnv, err := ClaudeFamilyHookEnv(hookExecutable)
	if err != nil {
		t.Fatal(err)
	}
	for envName, value := range hookEnv {
		env = append(env, envName+"="+value)
	}
	return env
}

type installedFakeClaudeObservation struct {
	Argv           []string `json:"argv"`
	Case           string   `json:"case"`
	Decision       string   `json:"decision"`
	Code           int      `json:"code"`
	Executed       bool     `json:"executed"`
	HookPresent    bool     `json:"hook_present"`
	HookOutputSafe bool     `json:"hook_output_safe"`
	PromptPresent  bool     `json:"prompt_present"`
	Client         string   `json:"client"`
}

func readInstalledFakeClaudeObservation(t *testing.T, path string) installedFakeClaudeObservation {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(data, []byte("credential-sentinel")) {
		t.Fatal("fake Claude observation exposed credential material")
	}
	var observation installedFakeClaudeObservation
	if err := json.Unmarshal(data, &observation); err != nil {
		t.Fatal(err)
	}
	return observation
}
