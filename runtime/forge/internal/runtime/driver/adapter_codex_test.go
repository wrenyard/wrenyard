package driver

import (
	"io"
	"reflect"
	"runtime"
	"testing"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/catalog"
)

func TestCodexAdapterBuildRunCommand(t *testing.T) {
	adapter := &CodexAdapter{Model: "default-model", Sandbox: "read-only"}
	cmd := adapter.BuildRunCommand("unused-profile", "help me", "/tmp/codex", CommandOptions{})

	want := []string{
		"codex", "--search", "exec", "--strict-config",
		"-c", `approval_policy="never"`,
		"-c", `model_reasoning_effort="xhigh"`,
		"--model", "default-model",
		"--json", "--sandbox", "read-only", "--skip-git-repo-check",
		"--ignore-user-config",
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
	if got := readCommandStdin(t, cmd.Stdin); got != "help me" {
		t.Fatalf("stdin = %q, want help me", got)
	}
}

func TestCodexAdapterBuildResumeCommand(t *testing.T) {
	adapter := &CodexAdapter{Model: "default-model", Sandbox: "read-only"}
	cmd := adapter.BuildResumeCommand("unused-profile", "thread-abc", "continue", "/tmp/codex", CommandOptions{})

	want := []string{
		"codex", "--search", "exec", "resume", "thread-abc",
		"--strict-config",
		"-c", `approval_policy="never"`,
		"-c", `model_reasoning_effort="xhigh"`,
		"-c", `sandbox_mode="read-only"`,
		"--model", "default-model", "--json", "--skip-git-repo-check",
		"--ignore-user-config",
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

func TestCodexAdapterPermissionModesUseNativePolicy(t *testing.T) {
	adapter := &CodexAdapter{Model: "default-model", Sandbox: "adapter-fallback"}
	tests := []struct {
		name    string
		mode    catalog.PermissionMode
		sandbox string
		bypass  bool
	}{
		{name: "readonly", mode: catalog.PermissionReadonly, sandbox: "read-only"},
		{name: "edit", mode: catalog.PermissionEdit, sandbox: "workspace-write"},
		{name: "yolo", mode: catalog.PermissionYolo, sandbox: "danger-full-access", bypass: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			opts := CommandOptions{Permission: tt.mode}
			commands := map[string][]string{
				"run":    adapter.BuildRunCommand("unused", "prompt", "/tmp/codex", opts).Args,
				"resume": adapter.BuildResumeCommand("unused", "thread-abc", "prompt", "/tmp/codex", opts).Args,
			}
			for name, args := range commands {
				if name == "run" && !containsFlagPair(args, "--sandbox", tt.sandbox) {
					t.Fatalf("%s sandbox = %#v, want %q: %v", name, args, tt.sandbox, args)
				}
				if name == "resume" && !containsFlagPair(args, "-c", `sandbox_mode="`+tt.sandbox+`"`) {
					t.Fatalf("resume sandbox config missing: %v", args)
				}
				if !containsFlagPair(args, "-c", `approval_policy="never"`) ||
					!containsFlagPair(args, "-c", "approval_policy=never") {
					t.Fatalf("%s must preserve both native approval policy entries: %v", name, args)
				}
				if got := containsFlag(args, "--dangerously-bypass-approvals-and-sandbox"); got != tt.bypass {
					t.Fatalf("%s bypass = %v, want %v: %v", name, got, tt.bypass, args)
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
