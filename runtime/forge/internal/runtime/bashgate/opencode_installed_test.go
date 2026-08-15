package bashgate

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/catalog"
)

const installedOpenCodeBashGateEnv = "FORGE_TEST_INSTALLED_OPENCODE_BASHGATE"
const installedOpenCodeTerminalMarker = "LOCAL_MODEL_DONE"
const installedOpenCodeTerminalRequests = 2
const installedOpenCodeCleanupTimeout = 5 * time.Second
const installedOpenCodeMarkerPoll = 25 * time.Millisecond

var errOpenCodeProcessDidNotExit = errors.New("opencode process did not exit within bounded cleanup interval")

func TestInstalledOpenCodeLocalMockUsesBlockingToolHook(t *testing.T) {
	if os.Getenv(installedOpenCodeBashGateEnv) != "1" {
		t.Skipf("set %s=1 to run the installed OpenCode local-model contract", installedOpenCodeBashGateEnv)
	}
	opencode, err := exec.LookPath("opencode")
	if err != nil {
		t.Fatalf("installed OpenCode is unavailable: %v", err)
	}
	versionCtx, versionCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer versionCancel()
	versionOutput, err := exec.CommandContext(versionCtx, opencode, "--version").CombinedOutput()
	if err != nil || len(bytes.TrimSpace(versionOutput)) == 0 {
		t.Fatalf("installed OpenCode version probe failed: %v output=%s", err, versionOutput)
	}

	forgeBinary := buildInstalledOpenCodeProbeForge(t)
	for _, tc := range []struct {
		name               string
		command            string
		pluginMode         string
		wantTerminal       bool
		wantsRequestsAfter int32
	}{
		{name: "safe semicolon chain", command: "pwd ; rg forge", pluginMode: "production", wantTerminal: true, wantsRequestsAfter: installedOpenCodeTerminalRequests},
		{name: "unsafe second segment", command: "pwd ; rm victim.txt", pluginMode: "production", wantsRequestsAfter: installedOpenCodeTerminalRequests},
		{name: "config hook missing policy", command: "pwd ; rm victim.txt", pluginMode: "missing-policy", wantsRequestsAfter: installedOpenCodeTerminalRequests},
		{name: "plugin load failure", command: "pwd ; rm victim.txt", pluginMode: "missing-plugin", wantsRequestsAfter: installedOpenCodeTerminalRequests},
	} {
		t.Run(tc.name, func(t *testing.T) {
			workDir := t.TempDir()
			victim := filepath.Join(workDir, "victim.txt")
			if err := os.WriteFile(victim, []byte("PRESERVE\n"), 0o600); err != nil {
				t.Fatal(err)
			}
			server, requests := newOpenCodeToolMock(t, tc.command)
			defer server.Close()
			configDir, env := installedOpenCodeProbeConfig(t, forgeBinary, server.URL, tc.pluginMode)

			ctx, cancel := context.WithTimeout(context.Background(), 32*time.Second)
			defer cancel()
			cmd := exec.CommandContext(ctx, opencode, "run", "--format", "json", "-m", "forge-probe/mock", "run the requested Bash probe")
			cmd.Dir = workDir
			cmd.Env = env
			output, runErr, terminalObserved := runOpenCodeProbeCommand(t, cmd, ctx, requests, tc.wantTerminal, tc.wantsRequestsAfter)
			if ctx.Err() != nil && !terminalObserved {
				t.Fatalf("installed OpenCode probe timed out: %v output=%s", ctx.Err(), output)
			}
			if tc.wantsRequestsAfter > 0 {
				if !terminalObserved {
					t.Fatalf("installed OpenCode did not complete the expected turn: requests=%d output=%s", requests.Load(), output)
				}
				if requests.Load() < tc.wantsRequestsAfter {
					t.Fatalf("installed OpenCode did not emit complete mocked turn: requests=%d output=%s", requests.Load(), output)
				}
			} else if requests.Load() == 0 {
				t.Fatalf("installed OpenCode never reached its configured loopback model: err=%v output=%s", runErr, output)
			}
			if tc.pluginMode == "production" && tc.command == "pwd ; rg forge" {
				if runErr != nil || !bytes.Contains(output, []byte("LOCAL_MODEL_DONE")) {
					t.Fatalf("installed OpenCode rejected safe gated chain: err=%v output=%s", runErr, output)
				}
			} else {
				var exitErr *exec.ExitError
				if runErr != nil && !errors.As(runErr, &exitErr) {
					t.Fatalf("installed OpenCode blocking probe failed unexpectedly: %v output=%s", runErr, output)
				}
			}
			victimBytes, readErr := os.ReadFile(victim)
			if readErr != nil || string(victimBytes) != "PRESERVE\n" {
				t.Fatalf("installed OpenCode executed a denied command: bytes=%q err=%v output=%s", victimBytes, readErr, output)
			}
			if info, statErr := os.Stat(configDir); statErr != nil || !info.IsDir() {
				t.Fatalf("installed contract probe lost its isolated config before inspection: %v", statErr)
			}
		})
	}
}

func buildInstalledOpenCodeProbeForge(t *testing.T) string {
	t.Helper()
	name := "forge-opencode-installed-probe"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	path := filepath.Join(t.TempDir(), name)
	cmd := exec.Command("go", "build", "-o", path, "../../../cmd/forge")
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("build installed OpenCode probe Forge: %v\n%s", err, output)
	}
	return path
}

func installedOpenCodeProbeConfig(t *testing.T, forgeBinary, endpoint, pluginMode string) (string, []string) {
	t.Helper()
	policy := catalog.PolicyFor(catalog.PermissionReadonly)
	allow, err := catalog.EffectiveBashAllow(policy, nil)
	if err != nil {
		t.Fatal(err)
	}
	encodedPolicy, err := EncodePolicy(ClientOpenCode, allow, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if pluginMode == "missing-policy" {
		encodedPolicy = ""
	}
	activeBash, err := catalog.EncodeOpenCodeBashPermission(policy)
	if err != nil {
		t.Fatal(err)
	}
	bootstrap, err := catalog.EncodeOpenCodeBootstrapPermissionConfig(policy)
	if err != nil {
		t.Fatal(err)
	}
	var config map[string]any
	if err := json.Unmarshal([]byte(bootstrap), &config); err != nil {
		t.Fatal(err)
	}
	config["model"] = "forge-probe/mock"
	config["small_model"] = "forge-probe/mock"
	config["share"] = "disabled"
	config["autoupdate"] = false
	config["provider"] = map[string]any{
		"forge-probe": map[string]any{
			"npm": "@ai-sdk/openai-compatible", "name": "Forge loopback probe",
			"options": map[string]any{"baseURL": endpoint + "/v1", "apiKey": "loopback-probe"},
			"models": map[string]any{
				"mock": map[string]any{"name": "Mock", "limit": map[string]any{"context": 32000, "output": 4096}},
			},
		},
	}
	configBytes, err := json.Marshal(config)
	if err != nil {
		t.Fatal(err)
	}

	configDir := t.TempDir()
	configPath := filepath.Join(configDir, "opencode.json")
	pluginPath := filepath.Join(configDir, "forge-bashgate.js")
	if err := os.WriteFile(configPath, append(configBytes, '\n'), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(pluginPath, OpenCodePluginBytes(), 0o600); err != nil {
		t.Fatal(err)
	}
	pluginTarget := pluginPath
	if pluginMode == "missing-plugin" {
		pluginTarget = filepath.Join(configDir, "missing-plugin.js")
	}
	pluginURL := installedOpenCodeFileURL(pluginTarget)
	registration, err := json.Marshal(map[string]any{"plugin": []string{pluginURL}})
	if err != nil {
		t.Fatal(err)
	}
	guardExecutable := forgeBinary
	if pluginMode == "missing-guard" {
		guardExecutable = filepath.Join(configDir, "missing-forge")
		if runtime.GOOS == "windows" {
			guardExecutable += ".exe"
		}
	}

	blocked := []string{"OPENCODE_", "FORGE_INTERNAL_OPENCODE_", "FORGE_INTERNAL_BASH_GATE_", "ANTHROPIC_", "OPENAI_"}
	env := make([]string, 0, len(os.Environ())+20)
	for _, entry := range os.Environ() {
		key, _, ok := strings.Cut(entry, "=")
		if !ok {
			continue
		}
		upper := strings.ToUpper(key)
		skip := false
		for _, prefix := range blocked {
			if strings.HasPrefix(upper, prefix) {
				skip = true
				break
			}
		}
		if !skip && !strings.HasPrefix(upper, "XDG_") {
			env = append(env, entry)
		}
	}
	env = append(env,
		"XDG_CONFIG_HOME="+configDir,
		"XDG_DATA_HOME="+filepath.Join(configDir, "data"),
		"XDG_CACHE_HOME="+filepath.Join(configDir, "cache"),
		"XDG_STATE_HOME="+filepath.Join(configDir, "state"),
		"OPENCODE_CONFIG="+configPath,
		"OPENCODE_CONFIG_DIR="+configDir,
		"OPENCODE_CONFIG_CONTENT="+string(registration),
		"OPENCODE_DISABLE_PROJECT_CONFIG=true",
		"OPENCODE_DISABLE_CLAUDE_CODE=true",
		ModeEnv+"="+string(ClientOpenCode),
		PolicyEnv+"="+encodedPolicy,
		OpenCodeExecutableEnv+"="+guardExecutable,
		OpenCodeBashPermissionEnv+"="+activeBash,
	)
	return configDir, env
}

func installedOpenCodeFileURL(path string) string {
	slash := filepath.ToSlash(path)
	if runtime.GOOS == "windows" && !strings.HasPrefix(slash, "/") {
		slash = "/" + slash
	}
	return (&url.URL{Scheme: "file", Path: slash}).String()
}

func runOpenCodeProbeCommand(t *testing.T, cmd *exec.Cmd, ctx context.Context, requests *atomic.Int32, wantTerminal bool, minRequests int32) ([]byte, error, bool) {
	t.Helper()
	setOpenCodeProcessGroup(cmd)
	var output threadSafeBuffer
	cmd.Stdout = &output
	cmd.Stderr = &output
	if err := cmd.Start(); err != nil {
		t.Fatalf("start installed OpenCode probe command: %v", err)
	}
	done := make(chan error, 1)
	go func() {
		done <- cmd.Wait()
	}()
	ticker := time.NewTicker(installedOpenCodeMarkerPoll)
	defer ticker.Stop()

	terminalObserved := false
	waitForTerminal := wantTerminal || minRequests > 0
	for {
		if waitForTerminal && !terminalObserved && observedOpenCodeTerminalTurn(&output, requests, minRequests) {
			terminalObserved = true
			if err := reapOpenCodeProcessTree(cmd, done); err != nil {
				if err != errOpenCodeProcessDidNotExit {
					return output.Bytes(), err, true
				}
				_ = cmd.Process.Kill()
			}
			return output.Bytes(), nil, true
		}
		select {
		case runErr := <-done:
			return output.Bytes(), runErr, terminalObserved
		case <-ctx.Done():
			if err := reapOpenCodeProcessTree(cmd, done); err != nil {
				return output.Bytes(), err, terminalObserved
			}
			return output.Bytes(), ctx.Err(), terminalObserved
		case <-ticker.C:
			// keep waiting for terminal marker, exit, or context.
		}
	}
}

func observedOpenCodeTerminalTurn(output *threadSafeBuffer, requests *atomic.Int32, minRequests int32) bool {
	if output == nil || requests == nil {
		return false
	}
	if minRequests > 0 && requests.Load() < minRequests {
		return false
	}
	return bytes.Contains(output.Bytes(), []byte(installedOpenCodeTerminalMarker))
}

func waitForOpenCodeProcessDone(waitDone <-chan error, timeout time.Duration) error {
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case err := <-waitDone:
		return err
	case <-timer.C:
		return errOpenCodeProcessDidNotExit
	}
}

func reapOpenCodeProcessTree(cmd *exec.Cmd, waitDone <-chan error) error {
	if cmd == nil || cmd.Process == nil {
		return nil
	}
	if err := sendOpenCodeProcessSignal(cmd.Process.Pid, "TERM"); err == nil {
		if err := waitForOpenCodeProcessDone(waitDone, installedOpenCodeCleanupTimeout); err == nil {
			return nil
		}
	}
	if err := sendOpenCodeProcessSignal(cmd.Process.Pid, "KILL"); err == nil {
		if err := waitForOpenCodeProcessDone(waitDone, installedOpenCodeCleanupTimeout); err == nil {
			return nil
		}
	}
	if err := cmd.Process.Kill(); err == nil {
		if err := waitForOpenCodeProcessDone(waitDone, installedOpenCodeCleanupTimeout); err == nil {
			return nil
		}
	}
	return errOpenCodeProcessDidNotExit
}

func taskkillOpenCodeProcessTree(pid int, force bool) error {
	args := []string{"/T", "/PID", fmt.Sprintf("%d", pid)}
	if force {
		args = append(args, "/F")
	}
	cmd := exec.Command("taskkill", args...)
	cmd.Stdout = io.Discard
	cmd.Stderr = io.Discard
	return cmd.Run()
}

type threadSafeBuffer struct {
	sync.Mutex
	bytes.Buffer
}

func (b *threadSafeBuffer) Write(p []byte) (int, error) {
	b.Lock()
	defer b.Unlock()
	return b.Buffer.Write(p)
}

func (b *threadSafeBuffer) Bytes() []byte {
	b.Lock()
	defer b.Unlock()
	return append([]byte(nil), b.Buffer.Bytes()...)
}

func newOpenCodeToolMock(t *testing.T, command string) (*httptest.Server, *atomic.Int32) {
	t.Helper()
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/chat/completions" {
			http.NotFound(w, r)
			return
		}
		var request map[string]any
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Errorf("decode OpenCode loopback request: %v", err)
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		attempt := requests.Add(1)
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		if attempt == 1 {
			arguments, _ := json.Marshal(map[string]any{"command": command, "description": "Forge installed hook probe"})
			writeOpenCodeSSE(w,
				map[string]any{"id": "chatcmpl-probe", "object": "chat.completion.chunk", "created": 1, "model": "mock", "choices": []any{map[string]any{"index": 0, "delta": map[string]any{"role": "assistant", "tool_calls": []any{map[string]any{"index": 0, "id": "call_probe", "type": "function", "function": map[string]any{"name": "bash", "arguments": string(arguments)}}}}, "finish_reason": nil}}},
				map[string]any{"id": "chatcmpl-probe", "object": "chat.completion.chunk", "created": 1, "model": "mock", "choices": []any{map[string]any{"index": 0, "delta": map[string]any{}, "finish_reason": "tool_calls"}}, "usage": map[string]any{"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15}},
			)
			return
		}
		writeOpenCodeSSE(w,
			map[string]any{"id": fmt.Sprintf("chatcmpl-probe-%d", attempt), "object": "chat.completion.chunk", "created": 1, "model": "mock", "choices": []any{map[string]any{"index": 0, "delta": map[string]any{"role": "assistant", "content": "LOCAL_MODEL_DONE"}, "finish_reason": nil}}},
			map[string]any{"id": fmt.Sprintf("chatcmpl-probe-%d", attempt), "object": "chat.completion.chunk", "created": 1, "model": "mock", "choices": []any{map[string]any{"index": 0, "delta": map[string]any{}, "finish_reason": "stop"}}, "usage": map[string]any{"prompt_tokens": 12, "completion_tokens": 2, "total_tokens": 14}},
		)
	}))
	return server, &requests
}

func writeOpenCodeSSE(w http.ResponseWriter, chunks ...map[string]any) {
	for _, chunk := range chunks {
		data, _ := json.Marshal(chunk)
		_, _ = fmt.Fprintf(w, "data: %s\n\n", data)
	}
	_, _ = fmt.Fprint(w, "data: [DONE]\n\n")
}
