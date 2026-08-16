package forge

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// fakeGrokSource records the allowlisted env values passed to the grok child
// process. It never dumps the full environment to avoid leaking secrets.
const fakeGrokSource = `package main

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
		"GROK_HOME",
		"FORGE_GROK_KIMI_CODING_API_KEY",
		"FORGE_GROK_ZHIPU_CODING_API_KEY",
		"OPENAI_API_KEY",
	} {
		b.WriteString(key)
		b.WriteString("=")
		b.WriteString(os.Getenv(key))
		b.WriteString("\n")
	}
	// Emit a constant marker only when the stale key is truly present in the
	// child environment (distinguishes absent from empty). The test asserts
	// this marker is absent, so the stale variable name or value is never
	// written to test output.
	if _, ok := os.LookupEnv("FORGE_GROK_STALE_PROJECTION_API_KEY"); ok {
		b.WriteString("STALE_KEY_PRESENT=1\n")
	}
	// Constant markers for inherited lower/mixed-case variants of a currently
	// eligible provider key — the test asserts these markers are absent so the
	// case-variant variable names or values are never written to output.
	if _, ok := os.LookupEnv("forge_grok_kimi_coding_api_key"); ok {
		b.WriteString("LOWERCASE_CASEVARIANT_PRESENT=1\n")
	}
	if _, ok := os.LookupEnv("Forge_Grok_Kimi_Coding_API_KEY"); ok {
		b.WriteString("MIXEDCASE_CASEVARIANT_PRESENT=1\n")
	}
	// Record the raw argv (after the program name) so argv pass-through and
	// default injection can be verified without leaking secrets.
	b.WriteString("ARGV=")
	b.WriteString(strings.Join(os.Args[1:], " "))
	b.WriteString("\n")
	_ = os.WriteFile(out, []byte(b.String()), 0o644)
	os.Exit(0)
}
`

func installFakeGrokRecordingEnv(t *testing.T, envOut string) {
	t.Helper()
	binDir := t.TempDir()
	srcPath := filepath.Join(binDir, "fake-grok.go")
	exePath := filepath.Join(binDir, "grok")
	if runtime.GOOS == "windows" {
		exePath += ".exe"
	}
	if err := os.WriteFile(srcPath, []byte(fakeGrokSource), 0o644); err != nil {
		t.Fatalf("write fake grok source: %v", err)
	}
	build := exec.Command("go", "build", "-o", exePath, srcPath)
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build fake grok: %v\n%s", err, string(output))
	}
	t.Setenv("PATH", binDir+string(os.PathListSeparator)+os.Getenv("PATH"))
}

func TestShellGrokPlanRedactsSecrets(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("XDG_CONFIG_HOME", "")
	t.Setenv("XDG_DATA_HOME", t.TempDir())

	// A known credential value that must never appear in plan output.
	setTestAuth(t, "kimi-coding", "super-secret-kimi-token")

	stdout := captureStdout(t, func() {
		if code := Run([]string{"shell", "grok", "plan"}, "forge"); code != 0 {
			t.Fatalf("plan exited %d", code)
		}
	})

	if !strings.Contains(stdout, "forge-kimi-coding--k3") {
		t.Fatalf("plan should list projected model:\n%s", stdout)
	}
	if strings.Contains(stdout, "super-secret-kimi-token") {
		t.Fatalf("plan must not leak credential:\n%s", stdout)
	}
	if strings.Contains(stdout, "api_key") {
		t.Fatalf("plan must not mention api_key:\n%s", stdout)
	}
	if !strings.Contains(stdout, "GROK_HOME:") {
		t.Fatalf("plan should print GROK_HOME:\n%s", stdout)
	}
}

func TestShellGrokExecInjectsEnvAndPassesArgv(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("XDG_CONFIG_HOME", "")
	dataHome := t.TempDir()
	t.Setenv("XDG_DATA_HOME", dataHome)

	envOut := filepath.Join(t.TempDir(), "child-env.txt")
	t.Setenv("FORGE_TEST_ENV_OUT", envOut)
	// Neutralize any inherited OPENAI_API_KEY so the child-env recording is
	// deterministic: Forge must never inject it with a value.
	t.Setenv("OPENAI_API_KEY", "")

	installFakeGrokRecordingEnv(t, envOut)
	setTestAuth(t, "kimi-coding", "token-kimi")
	setTestAuth(t, "zhipu-coding", "token-zhipu")

	// Exec with a user model flag; no permission flag -> default injected.
	code := Run([]string{"shell", "grok", "exec", "--", "-m", "forge-kimi-coding--k3"}, "forge")
	if code != 0 {
		t.Fatalf("grok exec exited %d", code)
	}

	data, err := os.ReadFile(envOut)
	if err != nil {
		t.Fatalf("fake grok did not record child env: %v", err)
	}
	env := string(data)
	if !strings.Contains(env, "GROK_HOME=") {
		t.Fatalf("GROK_HOME must be set:\n%s", env)
	}
	if !strings.Contains(env, "FORGE_GROK_KIMI_CODING_API_KEY=token-kimi") {
		t.Fatalf("kimi env key must be injected:\n%s", env)
	}
	if !strings.Contains(env, "FORGE_GROK_ZHIPU_CODING_API_KEY=token-zhipu") {
		t.Fatalf("zhipu env key must be injected:\n%s", env)
	}
	if strings.Contains(env, "OPENAI_API_KEY=token") || !strings.Contains(env, "OPENAI_API_KEY=\n") {
		t.Fatalf("OPENAI_API_KEY must never be injected with a value:\n%s", env)
	}
	// Default permission flag injected, user argv passed through.
	if !strings.Contains(env, "ARGV=--permission-mode bypassPermissions -m forge-kimi-coding--k3") {
		t.Fatalf("expected default permission flag + passthrough argv:\n%s", env)
	}

	// Config must have been materialized (not containing keys).
	cfg := filepath.Join(dataHome, "wrenyard", "runtime", "grok", "shell-grok", "config.toml")
	if _, err := os.Stat(cfg); err != nil {
		t.Fatalf("config.toml not materialized: %v", err)
	}
	cfgData, _ := os.ReadFile(cfg)
	if strings.Contains(string(cfgData), "token-kimi") || strings.Contains(string(cfgData), "api_key") {
		t.Fatalf("config must not contain credentials:\n%s", string(cfgData))
	}
}

func TestShellGrokExecStripsStaleCredentials(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("XDG_CONFIG_HOME", "")
	dataHome := t.TempDir()
	t.Setenv("XDG_DATA_HOME", dataHome)

	envOut := filepath.Join(t.TempDir(), "child-env.txt")
	t.Setenv("FORGE_TEST_ENV_OUT", envOut)

	// Set a stale/expired projection credential in the parent environment that
	// must never reach the child grok process.
	t.Setenv("FORGE_GROK_STALE_PROJECTION_API_KEY", "stale-token")
	t.Setenv("OPENAI_API_KEY", "")
	// Inherited case-variant credentials in parent env that must be stripped.
	t.Setenv("forge_grok_kimi_coding_api_key", "lowercase-key")
	t.Setenv("Forge_Grok_Kimi_Coding_API_KEY", "MixedCase-Key")

	installFakeGrokRecordingEnv(t, envOut)
	// Only kimi-coding is currently projected; zhipu is not.
	setTestAuth(t, "kimi-coding", "token-kimi")

	code := Run([]string{"shell", "grok", "exec", "--", "-m", "forge-kimi-coding--k3"}, "forge")
	if code != 0 {
		t.Fatalf("grok exec exited %d", code)
	}

	data, err := os.ReadFile(envOut)
	if err != nil {
		t.Fatalf("fake grok did not record child env: %v", err)
	}
	env := string(data)

	// Current projection key must be present.
	if !strings.Contains(env, "FORGE_GROK_KIMI_CODING_API_KEY=token-kimi") {
		t.Fatalf("current projection key must be injected:\n%s", env)
	}

	// Canonical key appears exactly once — no duplicate from case variants.
	if c := strings.Count(env, "FORGE_GROK_KIMI_CODING_API_KEY="); c != 1 {
		t.Fatalf("canonical key must appear exactly once, got %d times:\n%s", c, env)
	}

	// Stale credential from parent must be absent entirely. The fake grok
	// emits a STALE_KEY_PRESENT marker only when the key exists (via
	// LookupEnv), so this assertion cannot be a false positive.
	if strings.Contains(env, "STALE_KEY_PRESENT=1") {
		t.Fatalf("stale credential must not reach child")
	}

	// Case variants of the current eligible key must be absent entirely
	// (constant markers from fake grok — absent means the variables were
	// stripped from the child environment).
	if runtime.GOOS != "windows" && strings.Contains(env, "LOWERCASE_CASEVARIANT_PRESENT=1") {
		t.Fatalf("lowercase case-variant credential must not reach child environment")
	}
	if runtime.GOOS != "windows" && strings.Contains(env, "MIXEDCASE_CASEVARIANT_PRESENT=1") {
		t.Fatalf("mixed-case case-variant credential must not reach child environment")
	}

	// OPENAI_API_KEY must still be present (not stripped by Grok-specific filter)
	// but with an empty value (our env set it to "").
	if !strings.Contains(env, "OPENAI_API_KEY=\n") {
		t.Fatalf("unrelated OPENAI_API_KEY must remain in child env:\n%s", env)
	}

	// GROK_HOME must be set.
	if !strings.Contains(env, "GROK_HOME=") {
		t.Fatalf("GROK_HOME must be set:\n%s", env)
	}
}

func TestShellGrokExecUserPermissionOverridesDefault(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("XDG_CONFIG_HOME", "")
	t.Setenv("XDG_DATA_HOME", t.TempDir())

	envOut := filepath.Join(t.TempDir(), "child-env.txt")
	t.Setenv("FORGE_TEST_ENV_OUT", envOut)

	installFakeGrokRecordingEnv(t, envOut)
	setTestAuth(t, "kimi-coding", "token-kimi")

	code := Run([]string{"shell", "grok", "exec", "--", "--permission-mode", "ask"}, "forge")
	if code != 0 {
		t.Fatalf("grok exec exited %d", code)
	}
	data, _ := os.ReadFile(envOut)
	env := string(data)
	if strings.Contains(env, "bypassPermissions") {
		t.Fatalf("user --permission-mode must not be overridden:\n%s", env)
	}
	if !strings.Contains(env, "ARGV=--permission-mode ask") {
		t.Fatalf("expected user permission-mode passthrough:\n%s", env)
	}
}

func TestVersionIsCurrent(t *testing.T) {
	if version != "1.0.0-dev.7" {
		t.Fatalf("version = %q, want 1.0.0-dev.7", version)
	}
}
