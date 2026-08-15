package forge

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/profiles/manifest"
)

// setTestAuth writes a test credential into auth.json for the given provider.
func setTestAuth(t *testing.T, providerID, key string) {
	t.Helper()
	auth, err := readAuth()
	if err != nil {
		t.Fatal(err)
	}
	auth[providerID] = AuthEntry{Type: "api", Key: key}
	if err := writeAuth(auth); err != nil {
		t.Fatal(err)
	}
}

// clientExecutionEnv gates fake-client execution.Execute integration tests.
// Default go test must not CreateProcess real agent CLI names (codebuddy.cmd,
// claude, grok, …) or dial provider APIs; set to "1" only for opt-in runs.
const clientExecutionEnv = "FORGE_TEST_CLIENT_EXECUTION"

func requireClientExecution(t *testing.T) {
	t.Helper()
	if os.Getenv(clientExecutionEnv) != "1" {
		t.Skipf("set %s=1 to run fake-client execution integration tests", clientExecutionEnv)
	}
}

func setFakeClientsOnPath(t *testing.T, names ...string) string {
	t.Helper()
	bin := t.TempDir()
	for _, name := range names {
		if runtime.GOOS == "windows" {
			// Never create real-agent *.cmd shims. CreateProcess on names like
			// codebuddy.cmd under go-test temp dirs triggers corporate IT alerts.
			// Prefer <name>.exe for LookPath("name"); codebuddy also needs a
			// NodeEntry so ResolveBinary (WindowsCmd=codebuddy.cmd) succeeds
			// without a .cmd file.
			writeFakeExecutable(t, filepath.Join(bin, name+".exe"), "@echo off\r\nexit /b 0\r\n")
			if name == "codebuddy" {
				appData := filepath.Join(bin, "appdata")
				t.Setenv("APPDATA", appData)
				entry := filepath.Join(appData, "npm", "node_modules", "@tencent-ai", "codebuddy-code", "bin", "codebuddy")
				if err := os.MkdirAll(filepath.Dir(entry), 0o755); err != nil {
					t.Fatal(err)
				}
				writeFakeExecutable(t, entry, "#!/usr/bin/env node\nprocess.exit(0)\n")
			}
			continue
		}
		writeFakeExecutable(t, filepath.Join(bin, name), "#!/bin/sh\nexit 0\n")
	}
	t.Setenv("PATH", bin)
	return bin
}

func zshFunctionBlock(t *testing.T, content, name string) string {
	t.Helper()
	startMarker := name + "() {\n"
	start := strings.Index(content, startMarker)
	if start < 0 {
		t.Fatalf("missing zsh function %s in:\n%s", name, content)
	}
	rest := content[start:]
	end := strings.Index(rest, "\n}\n\n")
	if end < 0 {
		t.Fatalf("missing end of zsh function %s in:\n%s", name, rest)
	}
	return rest[:end+3]
}

func powerShellFunctionBlock(t *testing.T, content, name string) string {
	t.Helper()
	startMarker := "function " + name + " {\n"
	start := strings.Index(content, startMarker)
	if start < 0 {
		t.Fatalf("missing PowerShell function %s in:\n%s", name, content)
	}
	rest := content[start:]
	next := strings.Index(rest[len(startMarker):], "\nfunction ")
	if next < 0 {
		return rest
	}
	return rest[:len(startMarker)+next+1]
}

func captureStderr(t *testing.T, fn func()) string {
	t.Helper()
	original := os.Stderr
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatalf("create stderr pipe: %v", err)
	}
	os.Stderr = writer
	defer func() {
		os.Stderr = original
	}()

	fn()
	if err := writer.Close(); err != nil {
		t.Fatalf("close stderr writer: %v", err)
	}
	data, err := io.ReadAll(reader)
	if err != nil {
		t.Fatalf("read stderr: %v", err)
	}
	return string(data)
}

func captureStdout(t *testing.T, fn func()) string {
	t.Helper()
	original := os.Stdout
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatalf("create stdout pipe: %v", err)
	}
	os.Stdout = writer
	defer func() {
		os.Stdout = original
	}()

	fn()
	if err := writer.Close(); err != nil {
		t.Fatalf("close stdout writer: %v", err)
	}
	data, err := io.ReadAll(reader)
	if err != nil {
		t.Fatalf("read stdout: %v", err)
	}
	return string(data)
}

func containsInterfaceString(items []interface{}, want string) bool {
	for _, item := range items {
		if item == want {
			return true
		}
	}
	return false
}

func argAfter(args []string, flag string) string {
	for i, arg := range args {
		if arg == flag && i+1 < len(args) {
			return args[i+1]
		}
	}
	return ""
}

func argIndex(args []string, want string) int {
	for i, arg := range args {
		if arg == want {
			return i
		}
	}
	return -1
}

func containsOrdered(args []string, first, second string) bool {
	for i, arg := range args {
		if arg == first && i+1 < len(args) && args[i+1] == second {
			return true
		}
	}
	return false
}

func writeForgeConfig(t *testing.T, home, content string) {
	t.Helper()
	t.Setenv("HOME", home)
	configDir := filepath.Join(home, ".config", "forge")
	if err := os.MkdirAll(configDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(configDir, "config.json"), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func embeddedProfileForTest(t *testing.T, name string) profile {
	t.Helper()
	m := manifest.BuiltinManifest()
	p, ok := m.Profiles[name]
	if !ok {
		t.Fatalf("embedded profile %q not found", name)
	}
	return p
}

func writeFakeExecutable(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o755); err != nil {
		t.Fatal(err)
	}
}

func parseJSONLines(t *testing.T, output string) []map[string]any {
	t.Helper()
	lines := strings.Split(strings.TrimSpace(output), "\n")
	events := make([]map[string]any, 0, len(lines))
	for _, line := range lines {
		if strings.TrimSpace(line) == "" {
			continue
		}
		var event map[string]any
		if err := json.Unmarshal([]byte(line), &event); err != nil {
			t.Fatalf("parse JSONL event %q: %v", line, err)
		}
		events = append(events, event)
	}
	return events
}

func writeFakeCodexExecutable(t *testing.T, bin string, ok bool) {
	t.Helper()
	if runtime.GOOS == "windows" {
		content := "@echo off\r\n"
		if ok {
			content += "exit /b 0\r\n"
		} else {
			content += "echo Error: invalid type: boolean true, expected struct MemoriesToml 1>&2\r\nexit /b 1\r\n"
		}
		// Use .exe rather than codex.cmd so default tests never materialize a
		// real agent CLI shim name (LookPath("codex") resolves via PATHEXT).
		writeFakeExecutable(t, filepath.Join(bin, "codex.exe"), content)
		return
	}
	if ok {
		writeFakeExecutable(t, filepath.Join(bin, "codex"), "#!/bin/sh\nexit 0\n")
		return
	}
	writeFakeExecutable(t, filepath.Join(bin, "codex"), "#!/bin/sh\nprintf '%s\\n' 'Error: invalid type: boolean true, expected struct MemoriesToml' >&2\nexit 1\n")
}

func installFakeNodeRecordingAgent(t *testing.T, argsPath, envPath, nativeSessionID, summary string) {
	t.Helper()
	binDir := t.TempDir()
	srcPath := filepath.Join(binDir, "fake-node.go")
	exePath := filepath.Join(binDir, "node")
	if runtime.GOOS == "windows" {
		exePath += ".exe"
	}
	source := fmt.Sprintf(`package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strconv"
)

func writeJSONLine(v any) {
	data, _ := json.Marshal(v)
	fmt.Println(string(data))
}

func main() {
	argsPath := %q
	envPath := %q
	argsData, _ := json.Marshal(os.Args)
	_ = os.WriteFile(argsPath, argsData, 0o644)
	stdinData, _ := io.ReadAll(os.Stdin)
	_ = os.WriteFile(argsPath+".stdin", stdinData, 0o644)
	env := map[string]string{}
	for _, key := range []string{"PATH", "HOME", "CLAUDE_CONFIG_DIR", "CLAUDE_JOB_DIR", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_DEFAULT_OPUS_MODEL", "FORGE_PROFILE"} {
		if value, ok := os.LookupEnv(key); ok {
			env[key] = value
		}
	}
	envData, _ := json.Marshal(env)
	_ = os.WriteFile(envPath, envData, 0o644)
	writeJSONLine(map[string]any{"type":"system","subtype":"init","session_id":%q})
	writeJSONLine(map[string]any{"type":"assistant","message":map[string]any{"content":[]any{map[string]any{"type":"text","text":%q}}}})
	writeJSONLine(map[string]any{"type":"result","is_error":false,"session_id":%q})
	if childStderr := os.Getenv("FORGE_TEST_CHILD_STDERR"); childStderr != "" {
		fmt.Fprint(os.Stderr, childStderr)
	}
	if rawExitCode := os.Getenv("FORGE_TEST_CHILD_EXIT_CODE"); rawExitCode != "" {
		exitCode, _ := strconv.Atoi(rawExitCode)
		os.Exit(exitCode)
	}
}
`, argsPath, envPath, nativeSessionID, summary, nativeSessionID)
	if err := os.WriteFile(srcPath, []byte(source), 0o644); err != nil {
		t.Fatalf("write fake node source: %v", err)
	}
	build := exec.Command("go", "build", "-o", exePath, srcPath)
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build fake node: %v\n%s", err, string(output))
	}
	t.Setenv("PATH", binDir+string(os.PathListSeparator)+os.Getenv("PATH"))
}

func installFakeOpenCodeRun(t *testing.T, argsPath, envPath, summary string) {
	t.Helper()
	binDir := t.TempDir()
	srcPath := filepath.Join(binDir, "fake-opencode.go")
	exePath := filepath.Join(binDir, "opencode")
	if runtime.GOOS == "windows" {
		exePath += ".exe"
	}
	source := fmt.Sprintf(`package main

import (
	"encoding/json"
	"fmt"
	"os"
	"reflect"
)

func main() {
	argsPath := %q
	envPath := %q
	summary := %q
	argsData, _ := json.Marshal(os.Args)
	_ = os.WriteFile(argsPath, argsData, 0o644)
	env := map[string]string{}
	for _, key := range []string{"OPENCODE_MODEL", "FORGE_PROFILE", "PATH"} {
		if value, ok := os.LookupEnv(key); ok {
			env[key] = value
		}
	}
	envData, _ := json.Marshal(env)
	_ = os.WriteFile(envPath, envData, 0o644)

	wantArgs := []string{os.Args[0], "run", "-m", "openai/gpt-5.5", "--format", "json", "--pure", "write a short answer"}
	if !reflect.DeepEqual(os.Args, wantArgs) {
		fmt.Fprintf(os.Stderr, "unexpected args: %%v want %%v\n", os.Args, wantArgs)
		os.Exit(64)
	}

	_ = json.NewEncoder(os.Stdout).Encode(map[string]any{"type": "message", "message": summary})
}
`, argsPath, envPath, summary)
	if err := os.WriteFile(srcPath, []byte(source), 0o644); err != nil {
		t.Fatalf("write fake opencode source: %v", err)
	}
	build := exec.Command("go", "build", "-o", exePath, srcPath)
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build fake opencode: %v\n%s", err, string(output))
	}
	t.Setenv("PATH", binDir+string(os.PathListSeparator)+os.Getenv("PATH"))
}

func readRecordedStringSlice(t *testing.T, path string) []string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read recorded args %s: %v", path, err)
	}
	var out []string
	if err := json.Unmarshal(data, &out); err != nil {
		t.Fatalf("decode recorded args: %v\n%s", err, string(data))
	}
	return out
}

func readRecordedStringMap(t *testing.T, path string) map[string]string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read recorded env %s: %v", path, err)
	}
	var out map[string]string
	if err := json.Unmarshal(data, &out); err != nil {
		t.Fatalf("decode recorded env: %v\n%s", err, string(data))
	}
	return out
}

func jsonEscapedPath(t *testing.T, path string) string {
	t.Helper()
	encoded, err := json.Marshal(path)
	if err != nil {
		t.Fatal(err)
	}
	return strings.Trim(string(encoded), `"`)
}

// TestShellDaemonCheckProfileScoped verifies Finding 5: shellDaemonCheck
// only validates the daemon plugins actually required by managed profiles,
// not the first daemon plugin found.
// testReloadManifest forces the profile manifest to be reloaded from disk.
func testReloadManifest() error {
	_, err := loadManifest()
	return err
}
