package forge

import (
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/catalog"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/execution"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/protocol"
)

type fakeClaudeObservation struct {
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

func TestBuiltFakeClaudeFamilyBashGateExecutionMatrix(t *testing.T) {
	requireClientExecution(t)
	bin := t.TempDir()
	for _, name := range []string{"claude", "codebuddy"} {
		buildFakeClaudeFamilyBinary(t, filepath.Join(bin, executableName(name)))
	}
	setupClaudeFamilyCapabilityPlans(t)
	path := bin
	if runtime.GOOS == "windows" {
		path += string(os.PathListSeparator) + filepath.Join(os.Getenv("SystemRoot"), "System32")
	} else {
		path += string(os.PathListSeparator) + "/bin"
	}
	t.Setenv("PATH", path)

	clients := []struct {
		profile string
		client  string
	}{
		{profile: "cc-glm", client: "claude"},
		{profile: "cb-hy", client: "codebuddy"},
	}
	cases := []struct {
		name      string
		wantAllow bool
	}{
		{name: "safe-chain", wantAllow: true},
		{name: "crlf", wantAllow: true},
		{name: "notesmd", wantAllow: true},
		{name: "rm-second"},
		{name: "tee-second"},
		{name: "single-ampersand"},
		{name: "clustered-tree-output"},
		{name: "clustered-file-magic"},
		{name: "clustered-git-pager"},
		{name: "ripgrep-helper"},
		{name: "proc-clean-alias"},
		{name: "proc-env-glob"},
		{name: "windows-env-provider-glob"},
		{name: "malformed"},
		{name: "truncated"},
		{name: "unknown-alias"},
		{name: "process-error"},
	}
	if runtime.GOOS == "windows" {
		cases = append(cases,
			struct {
				name      string
				wantAllow bool
			}{name: "cmd-backslash-pipe"},
			struct {
				name      string
				wantAllow bool
			}{name: "powershell-backslash-semicolon"},
		)
	}
	for _, client := range clients {
		for _, tc := range cases {
			t.Run(client.client+"/"+tc.name, func(t *testing.T) {
				observationPath := filepath.Join(t.TempDir(), "observation.json")
				t.Setenv("FAKE_CLAUDE_OBSERVATION", observationPath)
				t.Setenv("FAKE_CLAUDE_GATE_CASE", tc.name)
				workDir := t.TempDir()
				victim := filepath.Join(workDir, "victim.txt")
				if err := os.WriteFile(victim, []byte("preserve-sentinel\n"), 0o600); err != nil {
					t.Fatal(err)
				}
				var stdout, stderr bytes.Buffer
				result, err := execution.Execute(execution.Request{
					ProfileName: client.profile, Prompt: "exercise production BashGate", WorkDir: workDir,
					Permission: catalog.PermissionReadonly, Format: protocol.OutputFormatJSON,
					Capabilities: []string{"notesmd"},
				}, executionDependencies(), &stdout, &stderr)
				if err != nil || result.Status != "done" {
					t.Fatalf("fake %s execution result=%+v err=%v stderr=%s", client.client, result, err, stderr.String())
				}
				observation := readFakeClaudeObservation(t, observationPath)
				if !observation.HookPresent || observation.Client != client.client || !observation.PromptPresent || !observation.HookOutputSafe {
					t.Fatalf("fake %s production observation = %+v", client.client, observation)
				}
				if tc.wantAllow {
					if observation.Code != 0 || observation.Decision != "allow" || !observation.Executed {
						t.Fatalf("allowed case %s = %+v", tc.name, observation)
					}
				} else if observation.Code != 2 || observation.Decision != "deny" || observation.Executed {
					t.Fatalf("denied case %s = %+v", tc.name, observation)
				}
				if !contains(observation.Argv, "Bash(notesmd-cli *)") || argIndex(observation.Argv, "--settings") > argIndex(observation.Argv, "--permission-mode") {
					t.Fatalf("production settings/capability argv ordering = %v", observation.Argv)
				}
				if data, readErr := os.ReadFile(victim); readErr != nil || string(data) != "preserve-sentinel\n" {
					t.Fatalf("guarded client changed victim sentinel: bytes=%q err=%v", data, readErr)
				}
			})
		}
	}
}

func TestBuiltFakeClaudeFamilyYoloBypassesRestrictedGate(t *testing.T) {
	requireClientExecution(t)
	bin := t.TempDir()
	for _, name := range []string{"claude", "codebuddy"} {
		buildFakeClaudeFamilyBinary(t, filepath.Join(bin, executableName(name)))
	}
	setupClaudeFamilyCapabilityPlans(t)
	path := bin
	if runtime.GOOS == "windows" {
		path += string(os.PathListSeparator) + filepath.Join(os.Getenv("SystemRoot"), "System32")
	} else {
		path += string(os.PathListSeparator) + "/bin"
	}
	t.Setenv("PATH", path)
	for _, tc := range []struct{ profile, client, flag string }{
		{profile: "cc-glm", client: "claude", flag: "--dangerously-skip-permissions"},
		{profile: "cb-hy", client: "codebuddy", flag: "-y"},
	} {
		t.Run(tc.client, func(t *testing.T) {
			observationPath := filepath.Join(t.TempDir(), "yolo.json")
			t.Setenv("FAKE_CLAUDE_OBSERVATION", observationPath)
			t.Setenv("FAKE_CLAUDE_GATE_CASE", "rm-second")
			result, err := execution.Execute(execution.Request{
				ProfileName: tc.profile, Prompt: "document yolo bypass", WorkDir: t.TempDir(),
				Permission: catalog.PermissionYolo, Format: protocol.OutputFormatJSON,
			}, executionDependencies(), &bytes.Buffer{}, &bytes.Buffer{})
			if err != nil || result.Status != "done" {
				t.Fatalf("yolo %s result=%+v err=%v", tc.client, result, err)
			}
			observation := readFakeClaudeObservation(t, observationPath)
			if observation.HookPresent || !observation.Executed || observation.Decision != "unrestricted" || !contains(observation.Argv, tc.flag) {
				t.Fatalf("yolo %s trust boundary = %+v", tc.client, observation)
			}
		})
	}
}

func buildFakeClaudeFamilyBinary(t *testing.T, target string) {
	t.Helper()
	cmd := exec.Command("go", "build", "-o", target, "./testdata/fake_claude_family")
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("build fake Claude-family client: %v\n%s", err, output)
	}
}

func executableName(name string) string {
	if runtime.GOOS == "windows" {
		if name == "codebuddy" {
			return name + ".cmd"
		}
		return name + ".exe"
	}
	return name
}

func readFakeClaudeObservation(t *testing.T, path string) fakeClaudeObservation {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(data, []byte("credential-sentinel")) {
		t.Fatal("fake Claude-family observation exposed credential material")
	}
	var observation fakeClaudeObservation
	if err := json.Unmarshal(data, &observation); err != nil {
		t.Fatal(err)
	}
	return observation
}
