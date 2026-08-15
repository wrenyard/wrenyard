package forge

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// fakeClaudeSource is a minimal Go program standing in for the `claude`
// binary. It records only the allowlisted variables relevant to this test;
// never dump the full host environment because it may contain real secrets.
const fakeClaudeSource = `package main

import (
	"os"
	"strings"
)

func main() {
	out := os.Getenv("FORGE_TEST_ENV_OUT")
	if out == "" {
		os.Exit(0)
	}
	var b strings.Builder
	for _, key := range []string{
		"ANTHROPIC_API_KEY",
		"ANTHROPIC_BASE_URL",
		"CLAUDE_CONFIG_DIR",
		"CLAUDE_JOB_DIR",
		"FORGE_PROFILE",
	} {
		b.WriteString(key)
		b.WriteString("=")
		b.WriteString(os.Getenv(key))
		b.WriteString("\n")
	}
	_ = os.WriteFile(out, []byte(b.String()), 0o644)
	os.Exit(0)
}
`

func installFakeClaudeRecordingEnv(t *testing.T, envOut string) {
	t.Helper()
	binDir := t.TempDir()
	srcPath := filepath.Join(binDir, "fake-claude.go")
	exePath := filepath.Join(binDir, "claude")
	if runtime.GOOS == "windows" {
		exePath += ".exe"
	}
	if err := os.WriteFile(srcPath, []byte(fakeClaudeSource), 0o644); err != nil {
		t.Fatalf("write fake claude source: %v", err)
	}
	build := exec.Command("go", "build", "-o", exePath, srcPath)
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build fake claude: %v\n%s", err, string(output))
	}
	t.Setenv("PATH", binDir+string(os.PathListSeparator)+os.Getenv("PATH"))
}

// TestShellExecPreservesGeneratedClaudeConfigBoundary is a regression test for
// the generated shortcut -> forge shell exec boundary. The shortcut selects an
// isolated Claude config/job directory whose settings.json owns provider env,
// model routing, and statusLine. shell exec must preserve that directory and
// profile identity while injecting only the credential at process launch.
func TestShellExecPreservesGeneratedClaudeConfigBoundary(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("XDG_CONFIG_HOME", "")
	t.Setenv("XDG_DATA_HOME", t.TempDir())
	configDir := filepath.Join(home, "forge-claude", "config")
	jobDir := filepath.Join(home, "forge-claude", "jobs")
	t.Setenv("CLAUDE_CONFIG_DIR", configDir)
	t.Setenv("CLAUDE_JOB_DIR", jobDir)
	t.Setenv("FORGE_PROFILE", "stale-parent-profile")
	t.Setenv("ANTHROPIC_BASE_URL", "https://stale-parent.invalid/")

	envOut := filepath.Join(t.TempDir(), "child-env.txt")
	t.Setenv("FORGE_TEST_ENV_OUT", envOut)

	installFakeClaudeRecordingEnv(t, envOut)
	setTestAuth(t, "kimi-coding", "token-kimi")

	code := shellCommand([]string{"exec", "cc-kimi", "--", "claude"})
	if code != 0 {
		t.Fatalf("shellCommand returned %d, want 0", code)
	}

	data, err := os.ReadFile(envOut)
	if err != nil {
		t.Fatalf("fake claude did not record child env: %v", err)
	}
	env := string(data)
	if !strings.Contains(env, "ANTHROPIC_API_KEY=token-kimi") {
		t.Fatalf("claude child missing ANTHROPIC_API_KEY; env:\n%s", env)
	}
	for key, want := range map[string]string{
		"CLAUDE_CONFIG_DIR": configDir,
		"CLAUDE_JOB_DIR":    jobDir,
		"FORGE_PROFILE":     "cc-kimi",
	} {
		if !strings.Contains(env, key+"="+want) {
			t.Fatalf("claude child %s missing or incorrect; want %q in env:\n%s", key, want, env)
		}
	}
	if !strings.Contains(env, "ANTHROPIC_BASE_URL=\n") {
		t.Fatalf("provider endpoint must not be injected into the launch environment:\n%s", env)
	}
}
