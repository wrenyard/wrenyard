package forge

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// fakeCodexBridgeObservation is the argv/env record the fake native Codex CLI
// writes for the bridge integration test. It carries no credential material:
// only the invoked argv, the CODEX_HOME the child was handed, and its cwd.
type fakeCodexBridgeObservation struct {
	Argv             []string `json:"argv"`
	CodexHome        string   `json:"codex_home"`
	CWD              string   `json:"cwd"`
	AppServerInvoked bool     `json:"app_server_invoked"`
	AuthLogins       int      `json:"auth_logins"`
	ThreadStarts     int      `json:"thread_starts"`
	TurnStarts       int      `json:"turn_starts"`
	Fake             bool     `json:"fake"`
}

// fakeCodexBridgeFinalMarker is the assistant marker the fake turn completes
// with. The test asserts it survives the whole app-server -> normalized-record
// path.
const fakeCodexBridgeFinalMarker = "FAKE_CODEX_FINAL"

// configSentinelPrefix is the distinctive, unmistakable content written into
// the source Codex config. The run must never copy or mutate it.
const configSentinelPrefix = "FORGE_SOURCE_CONFIG_SENTINEL"

const fakeCodexSourceConfig = "model = \"" + configSentinelPrefix + "\"\n"

const fakeCodexSourceAuth = `{"tokens":{"access_token":"fake-source-access-token","account_id":"fake-account-id"}}`

// TestBuiltForgeCodexAppServerBridgeIntegration exercises the REAL built Forge
// binary end to end. Forge's Codex bridge spawns the native `codex` CLI on PATH
// talking the app-server stdio JSON-RPC protocol; here that CLI is the built
// fake_codex fixture, so the transport, the record translation, the session
// extraction and the usage accounting are all exercised without any live model
// call or network access.
//
// The test pins the two isolation guarantees of the bridge:
//
//  1. The child receives a dedicated isolated WRENYARD_CODEX_HOME that is NOT
//     the source Codex home.
//  2. The source auth.json and config.toml are never copied into that isolated
//     home and are byte-identical after the run.
//
// It is bounded to 30s: a bridge that hangs on a missing handshake fails loudly
// instead of stalling the suite.
func TestBuiltForgeCodexAppServerBridgeIntegration(t *testing.T) {
	forgeBinary, fakeCodex, sourceHome, isolatedHome := buildFakeCodexBridgeBinaries(t)
	workDir := t.TempDir()

	observation := runFakeCodexBridge(t, forgeBinary, fakeCodex, sourceHome, isolatedHome, workDir)

	// --- The native CLI was really driven on the app-server transport. ---
	if !observation.Fake {
		t.Fatalf("the Codex child was not the fake fixture: %+v", observation)
	}
	if !observation.AppServerInvoked {
		t.Fatalf("the Codex child was not invoked as `app-server --stdio`: %v", observation.Argv)
	}
	for _, arg := range observation.Argv {
		if arg == "exec" {
			t.Fatalf("the Codex child must never run the legacy exec transport: %v", observation.Argv)
		}
	}

	// --- The child ran against the dedicated isolated home, not the source. ---
	if strings.TrimSpace(observation.CodexHome) == "" {
		t.Fatalf("the Codex child ran without a CODEX_HOME: %+v", observation)
	}
	if samePath(observation.CodexHome, sourceHome) {
		t.Fatalf("the Codex child must not run against the source Codex home %q", sourceHome)
	}
	if !samePath(observation.CodexHome, isolatedHome) {
		t.Fatalf("CODEX_HOME = %q, want the isolated home %q", observation.CodexHome, isolatedHome)
	}

	// --- The full native handshake ran, and the turn actually started. ---
	if observation.AuthLogins != 1 {
		t.Fatalf("account/login/start count = %d, want 1: %+v", observation.AuthLogins, observation)
	}
	if observation.ThreadStarts != 1 {
		t.Fatalf("thread/start count = %d, want 1: %+v", observation.ThreadStarts, observation)
	}
	if observation.TurnStarts != 1 {
		t.Fatalf("turn/start count = %d, want 1: %+v", observation.TurnStarts, observation)
	}

	// --- The source Codex state is untouched. ---
	assertSourceCodexHomeUnchanged(t, sourceHome)

	// --- The isolated home never receives the source credentials or config. ---
	assertIsolatedCodexHomeClean(t, isolatedHome)

	// --- The normalized run produced the native session, the tool records and
	// the usage the fake turn carried. ---
	assertBridgeRunResult(t, forgeBinary, fakeCodex, sourceHome, isolatedHome, workDir)
}

// runFakeCodexBridge runs one built-Forge Codex turn against the fake native
// CLI and returns the child's argv/env observation.
func runFakeCodexBridge(t *testing.T, forgeBinary, fakeCodex, sourceHome, isolatedHome, workDir string) fakeCodexBridgeObservation {
	t.Helper()
	output, observation := runFakeCodexBridgeCommand(t, forgeBinary, fakeCodex, sourceHome, isolatedHome, workDir, "codex-sol", "text")
	if !strings.Contains(output, fakeCodexBridgeFinalMarker) {
		t.Fatalf("final assistant marker missing from built-Forge output; output=%s", output)
	}
	return observation
}

// assertBridgeRunResult re-runs the turn in stream-json form so the test can
// assert the normalized event contract (native session id, command tool
// call/result, and turn usage) rather than only the process exit.
func assertBridgeRunResult(t *testing.T, forgeBinary, fakeCodex, sourceHome, isolatedHome, workDir string) {
	t.Helper()
	output, _ := runFakeCodexBridgeCommand(t, forgeBinary, fakeCodex, sourceHome, isolatedHome, workDir, "codex-sol", "stream-json")

	sessionID, toolCall, toolResult, usage := parseBuiltForgeStream(t, output)

	// The native session id comes from the app-server thread identity.
	if sessionID != "thread-fake" {
		t.Fatalf("native session id = %q, want thread-fake; stream=%s", sessionID, output)
	}
	if toolCall == "" {
		t.Fatalf("no command tool call record in the built-Forge stream; stream=%s", output)
	}
	if !strings.Contains(toolResult, "fake-codex-tool-output") {
		t.Fatalf("command tool result missing its aggregated output; stream=%s", output)
	}
	// The turn's usage is summed from the native rawResponse/completed.
	if usage["input_tokens"] != float64(128) || usage["output_tokens"] != float64(16) {
		t.Fatalf("turn usage = %v, want input_tokens=128 output_tokens=16", usage)
	}
}

// runFakeCodexBridgeCommand builds the Forge command, runs it, and returns its
// combined output plus the fake child's observation record.
func runFakeCodexBridgeCommand(
	t *testing.T,
	forgeBinary, fakeCodex, sourceHome, isolatedHome, workDir string,
	profile, format string,
) (string, fakeCodexBridgeObservation) {
	t.Helper()

	observationPath := filepath.Join(t.TempDir(), "fake-codex-observation.json")
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	// Forge resolves `~/.codex` from HOME, so the source Codex home is the
	// test HOME's own `.codex` directory. HOME itself is therefore never
	// redirected: Forge derives it exactly as it does in production.
	cmd := exec.CommandContext(ctx, forgeBinary,
		"-p", profile, "-C", workDir, "-f", format, "exercise the native Codex app-server bridge",
	)
	cmd.Env = append(os.Environ(),
		"HOME="+sourceHome,
		"USERPROFILE="+sourceHome,
		"CODEX_HOME=",
		"WRENYARD_CODEX_HOME="+isolatedHome,
		"FAKE_CODEX_OBSERVATION="+observationPath,
		"XDG_DATA_HOME="+filepath.Join(sourceHome, "data"),
		"XDG_CONFIG_HOME="+filepath.Join(sourceHome, "config"),
		"PATH="+filepath.Dir(fakeCodex)+string(os.PathListSeparator)+os.Getenv("PATH"),
	)
	var output bytes.Buffer
	cmd.Stdout = &output
	cmd.Stderr = &output
	runErr := cmd.Run()
	if ctx.Err() != nil {
		t.Fatalf("built-Forge Codex bridge timed out: %v output=%s", ctx.Err(), output.String())
	}

	body, err := os.ReadFile(observationPath)
	if err != nil {
		t.Fatalf("read the fake Codex observation: %v output=%s", err, output.String())
	}
	var observation fakeCodexBridgeObservation
	if err := json.Unmarshal(body, &observation); err != nil {
		t.Fatalf("decode the fake Codex observation: %v", err)
	}
	if runErr != nil {
		t.Fatalf("built-Forge Codex run failed: %v output=%s", runErr, output.String())
	}
	return output.String(), observation
}

// parseBuiltForgeStream decodes the Forge stream-json envelopes into the native
// session id, the command tool call/result, and the turn usage. Every envelope
// carries its payload under `data`; the session id is published with the
// terminal run_finished event.
func parseBuiltForgeStream(t *testing.T, output string) (sessionID, toolCall, toolResult string, usage map[string]any) {
	t.Helper()
	usage = map[string]any{}
	for _, line := range strings.Split(strings.TrimSpace(output), "\n") {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, "{") {
			continue
		}
		var envelope struct {
			Type string         `json:"type"`
			Data map[string]any `json:"data"`
		}
		if err := json.Unmarshal([]byte(line), &envelope); err != nil {
			// Non-envelope lines (child stderr, diagnostics) are ignored.
			continue
		}
		switch envelope.Type {
		case "tool_call":
			if name, _ := envelope.Data["name"].(string); name != "" {
				toolCall = name
			}
		case "tool_result":
			if tail, ok := envelope.Data["output_tail"].(string); ok {
				toolResult = tail
			}
		case "turn_usage":
			for key, value := range envelope.Data {
				usage[key] = value
			}
		case "run_finished":
			if id, ok := envelope.Data["native_session_id"].(string); ok && id != "" {
				sessionID = id
			}
		}
	}
	return sessionID, toolCall, toolResult, usage
}

// assertSourceCodexHomeUnchanged proves the run neither mutated nor mirrored
// the source Codex state.
func assertSourceCodexHomeUnchanged(t *testing.T, sourceHome string) {
	t.Helper()
	authPath := filepath.Join(sourceHome, ".codex", "auth.json")
	configPath := filepath.Join(sourceHome, ".codex", "config.toml")

	auth, err := os.ReadFile(authPath)
	if err != nil {
		t.Fatalf("read the source auth.json: %v", err)
	}
	if string(auth) != fakeCodexSourceAuth {
		t.Fatalf("the source auth.json was mutated: %q", auth)
	}
	config, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatalf("read the source config.toml: %v", err)
	}
	if string(config) != fakeCodexSourceConfig {
		t.Fatalf("the source config.toml was mutated: %q", config)
	}
}

// assertIsolatedCodexHomeClean proves the source credentials and config were
// never copied into the dedicated isolated home.
func assertIsolatedCodexHomeClean(t *testing.T, isolatedHome string) {
	t.Helper()
	for _, name := range []string{"auth.json", "config.toml"} {
		path := filepath.Join(isolatedHome, name)
		if data, err := os.ReadFile(path); err == nil {
			t.Fatalf("the isolated Codex home must not mirror the source %s: %q", name, data)
		}
	}
	entries, err := os.ReadDir(isolatedHome)
	if err != nil {
		t.Fatalf("read the isolated Codex home: %v", err)
	}
	for _, entry := range entries {
		if entry.Name() == "auth.json" || entry.Name() == "config.toml" {
			t.Fatalf("the isolated Codex home must not mirror the source %q", entry.Name())
		}
	}
}

// buildFakeCodexBridgeBinaries builds the real Forge binary and the fake native
// Codex CLI, then prepares a throwaway source Codex home carrying the sentinel
// config and the native ChatGPT auth the bridge authenticates with.
func buildFakeCodexBridgeBinaries(t *testing.T) (forgeBinary, fakeCodex, sourceHome, isolatedHome string) {
	t.Helper()
	moduleRoot, err := filepath.Abs(filepath.Join("..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	bin := t.TempDir()
	forgeBinary = filepath.Join(bin, forgeExecutableName())
	fakeCodex = filepath.Join(bin, codexExecutableName())
	for target, source := range map[string]string{
		forgeBinary: "./cmd/forge",
		fakeCodex:   "./internal/forge/testdata/fake_codex",
	} {
		cmd := exec.Command("go", "build", "-o", target, source)
		cmd.Dir = moduleRoot
		if output, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("build %s: %v\n%s", source, err, output)
		}
	}

	// Both homes are throwaway. The source home holds the fixture auth and the
	// sentinel config; the isolated home is empty and is where the child runs.
	sourceHome = t.TempDir()
	isolatedHome = t.TempDir()
	sourceCodexDir := filepath.Join(sourceHome, ".codex")
	if err := os.MkdirAll(sourceCodexDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sourceCodexDir, "auth.json"), []byte(fakeCodexSourceAuth), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sourceCodexDir, "config.toml"), []byte(fakeCodexSourceConfig), 0o600); err != nil {
		t.Fatal(err)
	}
	return forgeBinary, fakeCodex, sourceHome, isolatedHome
}

func forgeExecutableName() string {
	if runtime.GOOS == "windows" {
		return "forge.exe"
	}
	return "forge"
}

func codexExecutableName() string {
	if runtime.GOOS == "windows" {
		return "codex.exe"
	}
	return "codex"
}

// samePath compares two filesystem paths for identity on the host platform.
func samePath(left, right string) bool {
	if left == "" || right == "" {
		return false
	}
	a := filepath.Clean(left)
	b := filepath.Clean(right)
	if runtime.GOOS == "windows" {
		return strings.EqualFold(a, b)
	}
	return a == b
}
