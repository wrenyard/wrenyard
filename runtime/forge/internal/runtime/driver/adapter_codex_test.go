package driver

import (
	"io"
	"path/filepath"
	"reflect"
	"runtime"
	"testing"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/catalog"
)

func TestCodexAdapterBuildRunCommand(t *testing.T) {
	adapter := &CodexAdapter{Model: "default-model", Sandbox: "read-only"}
	cmd := adapter.BuildRunCommand("unused-profile", "help me", "/tmp/codex", CommandOptions{})

	want := []string{
		cmd.Path, "__codex-app-server", "--sandbox", "read-only",
		"--model", "default-model",
		"--strict-config", "--search",
		"-c", "features.shell_tool=false",
		"-c", "features.multi_agent=false",
		"-",
	}
	if cmd.Dir != "/tmp/codex" {
		t.Fatalf("Dir = %q, want /tmp/codex", cmd.Dir)
	}
	if !filepath.IsAbs(cmd.Path) {
		t.Fatalf("Path = %q, want the current Forge executable", cmd.Path)
	}
	if !reflect.DeepEqual(cmd.Args, want) {
		t.Fatalf("args mismatch\nwant: %#v\n got: %#v", want, cmd.Args)
	}
	if got := readCommandStdin(t, cmd.Stdin); got != "help me" {
		t.Fatalf("stdin = %q, want help me", got)
	}
}

func TestCodexAdapterBuildResumeCommand(t *testing.T) {
	adapter := &CodexAdapter{Model: "default-model", Sandbox: "read-only"}
	cmd := adapter.BuildResumeCommand("unused-profile", "thread-abc", "continue", "/tmp/codex", CommandOptions{})

	want := []string{
		cmd.Path, "__codex-app-server", "--sandbox", "read-only",
		"--model", "default-model",
		"--resume", "thread-abc",
		"--strict-config", "--search",
		"-c", "features.shell_tool=false",
		"-c", "features.multi_agent=false",
		"-",
	}
	if cmd.Dir != "/tmp/codex" {
		t.Fatalf("Dir = %q, want /tmp/codex", cmd.Dir)
	}
	if !reflect.DeepEqual(cmd.Args, want) {
		t.Fatalf("args mismatch\nwant: %#v\n got: %#v", want, cmd.Args)
	}
	if got := readCommandStdin(t, cmd.Stdin); got != "continue" {
		t.Fatalf("stdin = %q, want continue", got)
	}
}

// TestCodexAdapterBridgeArgvStaysWithinBridgeSurface pins the exact argv
// surface the hidden bridge accepts. The legacy `codex exec` flags are gone
// and no permission CLI switch survives, because the bridge has no request
// surface for them: unsupported modes are expressed as sandbox/config only.
func TestCodexAdapterBridgeArgvStaysWithinBridgeSurface(t *testing.T) {
	adapter := &CodexAdapter{Model: "gpt-5.6-sol", ReasoningEffort: "high", Sandbox: "read-only"}
	args := adapter.BuildRunCommand("unused", "prompt", "/tmp/codex", CommandOptions{Permission: catalog.PermissionYolo}).Args

	for _, removed := range []string{"--json", "--skip-git-repo-check", "--ignore-user-config", "exec"} {
		if containsFlag(args, removed) {
			t.Fatalf("removed legacy flag %q must not survive: %v", removed, args)
		}
	}
	// The bridge has no approval-request surface, so no approval switch may
	// be passed through even for yolo.
	if containsFlag(args, "--dangerously-bypass-approvals-and-sandbox") {
		t.Fatalf("yolo must not pass an unsupported approval switch through: %v", args)
	}
	if !containsFlagPair(args, "--sandbox", "danger-full-access") {
		t.Fatalf("yolo must express its sandbox on the bridge: %v", args)
	}
	if !containsFlagPair(args, "-c", "model_reasoning_effort="+tomlString("high")) {
		t.Fatalf("effort override missing: %v", args)
	}
}

func TestCodexAdapterPermissionModesUseNativePolicy(t *testing.T) {
	adapter := &CodexAdapter{Model: "default-model", Sandbox: "adapter-fallback"}
	tests := []struct {
		name    string
		mode    catalog.PermissionMode
		sandbox string
	}{
		{name: "readonly", mode: catalog.PermissionReadonly, sandbox: "read-only"},
		{name: "edit", mode: catalog.PermissionEdit, sandbox: "workspace-write"},
		{name: "yolo", mode: catalog.PermissionYolo, sandbox: "danger-full-access"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			opts := CommandOptions{Permission: tt.mode}
			commands := map[string][]string{
				"run":    adapter.BuildRunCommand("unused", "prompt", "/tmp/codex", opts).Args,
				"resume": adapter.BuildResumeCommand("unused", "thread-abc", "prompt", "/tmp/codex", opts).Args,
			}
			for name, args := range commands {
				// The bridge reads the sandbox from the flag on both run and
				// resume, so both must carry the mode's native sandbox.
				if !containsFlagPair(args, "--sandbox", tt.sandbox) {
					t.Fatalf("%s sandbox = %#v, want %q: %v", name, args, tt.sandbox, args)
				}
				if containsFlag(args, "--dangerously-bypass-approvals-and-sandbox") {
					t.Fatalf("%s must not pass an unsupported approval switch through: %v", name, args)
				}
				if containsFlag(args, "--allowedTools") || containsFlagPrefix(args, "--allowedTools=") {
					t.Fatalf("%s must never emit allowedTools: %v", name, args)
				}
			}
		})
	}
}

func TestBuildCodexWindowsSandboxArgsOnlyForWindowsEdit(t *testing.T) {
	tests := []struct {
		name       string
		goos       string
		permission catalog.PermissionMode
		want       []string
	}{
		{name: "windows edit", goos: "windows", permission: catalog.PermissionEdit, want: []string{"-c", codexWindowsSandboxElevatedConfig}},
		{name: "windows readonly", goos: "windows", permission: catalog.PermissionReadonly},
		{name: "windows yolo", goos: "windows", permission: catalog.PermissionYolo},
		{name: "linux edit", goos: "linux", permission: catalog.PermissionEdit},
		{name: "unset permission", goos: "windows"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := buildCodexWindowsSandboxArgs(CommandOptions{Permission: tt.permission}, tt.goos)
			if !reflect.DeepEqual(got, tt.want) {
				t.Fatalf("sandbox args = %#v, want %#v", got, tt.want)
			}
		})
	}
}

func TestCodexAdapterEditWindowsSandboxOverrideFollowsRuntimeGOOS(t *testing.T) {
	adapter := &CodexAdapter{Model: "default-model", Sandbox: "workspace-write"}
	opts := CommandOptions{Permission: catalog.PermissionEdit}
	want := runtime.GOOS == "windows"

	for name, args := range map[string][]string{
		"run":    adapter.BuildRunCommand("unused", "prompt", "/tmp/codex", opts).Args,
		"resume": adapter.BuildResumeCommand("unused", "thread-abc", "prompt", "/tmp/codex", opts).Args,
	} {
		if got := containsFlagPair(args, "-c", codexWindowsSandboxElevatedConfig); got != want {
			t.Fatalf("%s windows sandbox override = %v, want %v: %v", name, got, want, args)
		}
	}
}

func TestCodexAdapterParseSessionID(t *testing.T) {
	path := writeAdapterLog(t, `{"type":"turn.started"}
{"type":"thread.started","thread_id":"thread-123"}
{"type":"item.completed","item":{"type":"agent_message","text":"ignore"}}`)

	sessionID, err := (&CodexAdapter{}).ParseSessionID(path)
	if err != nil {
		t.Fatal(err)
	}
	if sessionID != "thread-123" {
		t.Fatalf("session id = %q, want thread-123", sessionID)
	}
}

func TestCodexAdapterParseResult(t *testing.T) {
	path := writeAdapterLog(t, `{"type":"item.completed","item":{"type":"agent_message","text":"first"}}
{"type":"item.completed","item":{"type":"assistant_message","text":"ignore"}}
{"type":"item.completed","item":{"type":"agent_message","content":"fallback content"}}
{"type":"item.completed","item":{"type":"agent_message","text":"  Fixed the issue in parser.go  "}}`)

	result, err := (&CodexAdapter{}).ParseResult(path)
	if err != nil {
		t.Fatal(err)
	}
	if result != "Fixed the issue in parser.go" {
		t.Fatalf("result = %q, want latest trimmed agent message", result)
	}
}

func readCommandStdin(t *testing.T, reader io.Reader) string {
	t.Helper()
	data, err := io.ReadAll(reader)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func containsFlagPair(args []string, flag, value string) bool {
	for i := 0; i+1 < len(args); i++ {
		if args[i] == flag && args[i+1] == value {
			return true
		}
	}
	return false
}

func containsFlag(args []string, flag string) bool {
	for _, arg := range args {
		if arg == flag {
			return true
		}
	}
	return false
}

func containsFlagPrefix(args []string, prefix string) bool {
	for _, arg := range args {
		if len(arg) >= len(prefix) && arg[:len(prefix)] == prefix {
			return true
		}
	}
	return false
}

func TestCodexMappedThinkingSurvivesRunAndResume(t *testing.T) {
	for _, effort := range []string{"low", "max", "xhigh"} {
		adapter := &CodexAdapter{Model: "gpt-5.6-sol", ReasoningEffort: effort}
		run := adapter.BuildRunCommand("", "hello", "/tmp", CommandOptions{})
		resume := adapter.BuildResumeCommand("", "thread-test", "hello", "/tmp", CommandOptions{})
		for _, args := range [][]string{run.Args, resume.Args} {
			found := false
			for _, arg := range args {
				if arg == "model_reasoning_effort="+tomlString(effort) {
					found = true
				}
			}
			if !found {
				t.Fatalf("mapped effort %q missing from %v", effort, args)
			}
		}
	}
}
