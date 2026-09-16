package driver

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

// These tests exercise the native credential bridge with fake source
// credentials. The transport tests launch a real helper process; only the
// credential values are fabricated. No real credential, no live Codex CLI, and
// no OAuth endpoint is ever involved.

// writeFakeAuth writes a source auth.json with fabricated (non-secret) values.
func writeFakeAuth(t *testing.T, home string, contents map[string]any) string {
	t.Helper()
	if err := os.MkdirAll(home, 0o700); err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(contents)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(home, "auth.json")
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

// withNativeRefresh swaps the native refresh for the duration of a test.
func withNativeRefresh(t *testing.T, fn func(ctx context.Context, home string) error) {
	t.Helper()
	previousExecutable := codexAuthNativeExecutable
	previous := codexAuthRunNative
	codexAuthRunNative = fn
	t.Cleanup(func() {
		codexAuthRunNative = previous
		codexAuthNativeExecutable = previousExecutable
	})
}

// withHelperProcess routes the real native refresh at a helper executable while
// leaving every production launch, transport, and cleanup step in the path.
func withHelperProcess(t *testing.T, helper string) {
	t.Helper()
	previous := codexAuthNativeExecutable
	codexAuthNativeExecutable = helper
	t.Cleanup(func() { codexAuthNativeExecutable = previous })
}

// The helper exits the way the test asks: it either drives the app-server
// handshake (then blocks until its stdin closes), or exits without answering.
const (
	codexAuthHelperHandshakeEnv = "WRENYARD_TEST_CODEX_AUTH_HELPER"
	codexAuthHelperExitingEnv   = "WRENYARD_TEST_CODEX_AUTH_HELPER_EXITING"
)

// TestMain turns the test binary into the helper process when the launch
// request says so, so the refresh can launch a real subprocess.
func TestMain(m *testing.M) {
	if os.Getenv(codexAuthHelperHandshakeEnv) != "" {
		codexAuthHelperHandshake()
		return
	}
	if os.Getenv(codexAuthHelperExitingEnv) != "" {
		os.Exit(3)
	}
	os.Exit(m.Run())
}

// codexAuthHelperHandshake answers the handshake from the requested path and
// then blocks on stdin, which is how the parent ends the exchange.
func codexAuthHelperHandshake() {
	reader := bufio.NewReader(os.Stdin)
	for {
		line, err := reader.ReadBytes('\n')
		if err != nil {
			os.Exit(0)
		}
		trimmed := bytes.TrimSpace(line)
		if len(trimmed) == 0 {
			continue
		}
		var msg codexAuthWire
		if err := json.Unmarshal(trimmed, &msg); err != nil || msg.ID == nil {
			continue
		}
		raw, err := json.Marshal(map[string]any{"id": *msg.ID, "result": map[string]any{}})
		if err != nil {
			os.Exit(1)
		}
		if _, err := os.Stdout.Write(append(raw, '\n')); err != nil {
			os.Exit(1)
		}
	}
}

// codexAuthBlockerHelperSource is the helper the cancellation test builds. It
// starts a descendant that inherits the helper's process group and its stdout,
// then blocks. Terminating only the direct child would leave that descendant
// holding the pipe, so the refresh must terminate the whole group.
const codexAuthBlockerHelperSource = `package main

import (
	"os"
	"os/exec"
	"time"
)

func main() {
 if len(os.Args)>1 && os.Args[1]=="--descendant" { time.Sleep(60*time.Second); return }
 exe, err := os.Executable(); if err != nil { os.Exit(5) }
	child := exec.Command(exe, "--descendant")
	child.Stdout = os.Stdout
	child.Stderr = os.Stderr
	if err := child.Start(); err != nil {
		os.Exit(4)
	}
	time.Sleep(60 * time.Second)
}
`

// writeCodexAuthBlockerHelperBinary compiles the blocker helper and returns the
// executable the refresh should launch.
func writeCodexAuthBlockerHelperBinary(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	source := filepath.Join(dir, "main.go")
	if err := os.WriteFile(source, []byte(codexAuthBlockerHelperSource), 0o600); err != nil {
		t.Fatal(err)
	}
	binary := filepath.Join(dir, "codex-helper")
	build := exec.Command("go", "build", "-o", binary, source)
	build.Dir = dir
	if out, err := build.CombinedOutput(); err != nil {
		t.Skipf("cannot build the helper binary: %v (%s)", err, out)
	}
	return binary
}

// writeCodexAuthHelperBinary places an executable named "codex" on disk so the
// production PATH lookup resolves to this test binary.
func writeCodexAuthHelperBinary(t *testing.T, dir string) string {
	t.Helper()
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	name := "codex"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	path := filepath.Join(dir, name)
	data, err := os.ReadFile(exe)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o755); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestCodexExternalAuthChatGPTTokens(t *testing.T) {
	home := t.TempDir()
	writeFakeAuth(t, home, map[string]any{
		"tokens": map[string]any{
			"access_token": "fake-access-token",
			"account_id":   "fake-account-id",
			"plan_type":    "pro",
		},
	})

	params, err := codexExternalAuth(context.Background(), home, false, "")
	if err != nil {
		t.Fatalf("codexExternalAuth error = %v", err)
	}
	if params["type"] != "chatgptAuthTokens" {
		t.Fatalf("type = %v, want chatgptAuthTokens", params["type"])
	}
	if params["accessToken"] != "fake-access-token" {
		t.Fatalf("accessToken = %v, want fake-access-token", params["accessToken"])
	}
	if params["chatgptAccountId"] != "fake-account-id" {
		t.Fatalf("chatgptAccountId = %v, want fake-account-id", params["chatgptAccountId"])
	}
	if params["chatgptPlanType"] != "pro" {
		t.Fatalf("chatgptPlanType = %v, want pro", params["chatgptPlanType"])
	}
	if _, hasKey := params["apiKey"]; hasKey {
		t.Fatal("ChatGPT auth params must not carry an API key")
	}
}

func TestCodexExternalAuthOmitsMissingPlanType(t *testing.T) {
	home := t.TempDir()
	writeFakeAuth(t, home, map[string]any{
		"tokens": map[string]any{
			"access_token": "fake-access-token",
			"account_id":   "fake-account-id",
		},
	})

	params, err := codexExternalAuth(context.Background(), home, false, "")
	if err != nil {
		t.Fatalf("codexExternalAuth error = %v", err)
	}
	if _, hasPlan := params["chatgptPlanType"]; hasPlan {
		t.Fatalf("chatgptPlanType must be omitted when absent, got %v", params["chatgptPlanType"])
	}
}

// TestCodexAuthParamsRequireAccountID verifies a ChatGPT token without an
// account id is refused rather than sent as an unusable empty field.
func TestCodexAuthParamsRequireAccountID(t *testing.T) {
	home := t.TempDir()
	writeFakeAuth(t, home, map[string]any{
		"tokens": map[string]any{"access_token": "fake-access-token"},
	})

	params, err := codexExternalAuth(context.Background(), home, false, "")
	if err == nil {
		t.Fatalf("expected an error for a token with no account id, got %v", params)
	}
	if !strings.Contains(err.Error(), "account id") {
		t.Fatalf("error = %v, want an account-id diagnostic", err)
	}
	assertNoCredentialLeak(t, err, "fake-access-token")
}

func TestCodexExternalAuthAPIKeyFallback(t *testing.T) {
	home := t.TempDir()
	writeFakeAuth(t, home, map[string]any{"OPENAI_API_KEY": "fake-api-key"})

	params, err := codexExternalAuth(context.Background(), home, false, "")
	if err != nil {
		t.Fatalf("codexExternalAuth error = %v", err)
	}
	if params["type"] != "apiKey" {
		t.Fatalf("type = %v, want apiKey", params["type"])
	}
	if params["apiKey"] != "fake-api-key" {
		t.Fatalf("apiKey = %v, want fake-api-key", params["apiKey"])
	}
	if _, hasToken := params["accessToken"]; hasToken {
		t.Fatal("API-key auth params must not carry an access token")
	}
}

func TestCodexExternalAuthMissingAuthFileIsSafe(t *testing.T) {
	home := t.TempDir()
	_, err := codexExternalAuth(context.Background(), home, false, "")
	if err == nil {
		t.Fatal("expected an error for a missing auth.json")
	}
	if !strings.Contains(err.Error(), "not found") {
		t.Fatalf("error = %v, want a not-found diagnostic", err)
	}
	assertNoCredentialLeak(t, err, home)
}

func TestCodexExternalAuthKeyringOnlyIsSafe(t *testing.T) {
	home := t.TempDir()
	writeFakeAuth(t, home, map[string]any{
		"cli_auth_credentials_store": "keyring",
		"tokens":                     map[string]any{"refresh_token": "fake-refresh-token"},
	})

	_, err := codexExternalAuth(context.Background(), home, false, "")
	if err == nil {
		t.Fatal("expected a safe error for keyring-only auth")
	}
	if !strings.Contains(err.Error(), "keyring") {
		t.Fatalf("error = %v, want a keyring diagnostic", err)
	}
	assertNoCredentialLeak(t, err, "fake-refresh-token")
}

func TestCodexExternalAuthMalformedAuthFileIsSafe(t *testing.T) {
	home := t.TempDir()
	if err := os.MkdirAll(home, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, "auth.json"), []byte("{not-json"), 0o600); err != nil {
		t.Fatal(err)
	}

	_, err := codexExternalAuth(context.Background(), home, false, "")
	if err == nil {
		t.Fatal("expected an error for malformed auth.json")
	}
	if !strings.Contains(err.Error(), "not valid JSON") {
		t.Fatalf("error = %v, want a JSON diagnostic", err)
	}
}

func TestCodexExternalAuthEmptyHomeIsSafe(t *testing.T) {
	_, err := codexExternalAuth(context.Background(), "  ", false, "")
	if err == nil {
		t.Fatal("expected an error for an empty auth home")
	}
	if !strings.Contains(err.Error(), "unavailable") {
		t.Fatalf("error = %v, want an unavailable diagnostic", err)
	}
}

func TestCodexExternalAuthRefreshUsesNativeRefresh(t *testing.T) {
	home := t.TempDir()
	writeFakeAuth(t, home, map[string]any{
		"tokens": map[string]any{
			"access_token":  "fake-access-old",
			"account_id":    "fake-account-id",
			"refresh_token": "fake-refresh-token",
		},
	})

	var calls int
	withNativeRefresh(t, func(ctx context.Context, gotHome string) error {
		calls++
		if gotHome != home {
			t.Errorf("native refresh home = %q, want %q", gotHome, home)
		}
		// The native refresh owns the source mutation.
		writeFakeAuth(t, home, map[string]any{
			"tokens": map[string]any{
				"access_token": "fake-access-new",
				"account_id":   "fake-account-id",
			},
		})
		return nil
	})

	params, err := codexExternalAuth(context.Background(), home, true, "fake-access-old")
	if err != nil {
		t.Fatalf("codexExternalAuth error = %v", err)
	}
	if calls != 1 {
		t.Fatalf("native refresh calls = %d, want 1", calls)
	}
	if params["accessToken"] != "fake-access-new" {
		t.Fatalf("accessToken = %v, want fake-access-new", params["accessToken"])
	}
}

func TestCodexExternalAuthRefreshReusesNewerToken(t *testing.T) {
	home := t.TempDir()
	writeFakeAuth(t, home, map[string]any{
		"tokens": map[string]any{
			"access_token":  "fake-access-newer",
			"account_id":    "fake-account-id",
			"refresh_token": "fake-refresh-token",
		},
	})

	calls := 0
	withNativeRefresh(t, func(context.Context, string) error {
		calls++
		return nil
	})

	params, err := codexExternalAuth(context.Background(), home, true, "fake-access-old")
	if err != nil {
		t.Fatalf("codexExternalAuth error = %v", err)
	}
	if calls != 0 {
		t.Fatalf("native refresh calls = %d, want 0 (token already changed)", calls)
	}
	if params["accessToken"] != "fake-access-newer" {
		t.Fatalf("accessToken = %v, want fake-access-newer", params["accessToken"])
	}
}

func TestCodexExternalAuthRefreshNativeFailureIsSafe(t *testing.T) {
	home := t.TempDir()
	writeFakeAuth(t, home, map[string]any{
		"tokens": map[string]any{
			"access_token":  "fake-access-old",
			"account_id":    "fake-account-id",
			"refresh_token": "fake-refresh-token",
		},
	})

	withNativeRefresh(t, func(context.Context, string) error {
		return context.DeadlineExceeded
	})

	_, err := codexExternalAuth(context.Background(), home, true, "fake-access-old")
	if err == nil {
		t.Fatal("expected an error when the native refresh fails")
	}
	assertNoCredentialLeak(t, err, "fake-access-old")
}

func TestCodexExternalAuthRefreshHonorsCancellation(t *testing.T) {
	home := t.TempDir()
	writeFakeAuth(t, home, map[string]any{
		"tokens": map[string]any{
			"access_token":  "fake-access-old",
			"account_id":    "fake-account-id",
			"refresh_token": "fake-refresh-token",
		},
	})

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	withNativeRefresh(t, func(ctx context.Context, _ string) error {
		return ctx.Err()
	})

	if _, err := codexExternalAuth(ctx, home, true, "fake-access-old"); err == nil {
		t.Fatal("expected an error when the context is cancelled")
	}
}

// TestCodexAuthLockSerializesConcurrentRefreshes verifies that the advisory
// lock is genuinely exclusive: a second holder cannot enter while the first is
// running, and the lock is released afterwards.
func TestCodexAuthLockSerializesConcurrentRefreshes(t *testing.T) {
	home := t.TempDir()

	var mu sync.Mutex
	inside, maxInside := 0, 0
	withNativeRefresh(t, func(context.Context, string) error {
		mu.Lock()
		inside++
		if inside > maxInside {
			maxInside = inside
		}
		mu.Unlock()

		time.Sleep(20 * time.Millisecond)

		mu.Lock()
		inside--
		mu.Unlock()
		return nil
	})

	writeFakeAuth(t, home, map[string]any{
		"tokens": map[string]any{
			"access_token":  "fake-access-old",
			"account_id":    "fake-account-id",
			"refresh_token": "fake-refresh-token",
		},
	})

	var wg sync.WaitGroup
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, _ = codexExternalAuth(context.Background(), home, true, "fake-access-old")
		}()
	}
	wg.Wait()

	if maxInside != 1 {
		t.Fatalf("concurrent native refreshes = %d, want at most 1", maxInside)
	}
}

// TestCodexAuthRefreshLockWaitIsBounded verifies the advisory-lock wait shares
// the refresh budget instead of waiting forever for a held lock.
func TestCodexAuthRefreshLockWaitIsBounded(t *testing.T) {
	home := t.TempDir()
	writeFakeAuth(t, home, map[string]any{
		"tokens": map[string]any{
			"access_token":  "fake-access-old",
			"account_id":    "fake-account-id",
			"refresh_token": "fake-refresh-token",
		},
	})

	unlock, err := acquireCodexAuthLock(context.Background(), home)
	if err != nil {
		t.Fatalf("acquireCodexAuthLock error = %v", err)
	}
	defer unlock()

	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	start := time.Now()
	if _, err := codexExternalAuth(ctx, home, true, "fake-access-old"); err == nil {
		t.Fatal("expected an error while the lock is held and the context is cancelled")
	}
	if elapsed := time.Since(start); elapsed > codexAuthOperationBudget+time.Second {
		t.Fatalf("refresh waited %v on a held lock, want a bounded wait", elapsed)
	}
}

// TestCodexAuthRefreshLockReleasedAfterFailure verifies the lock is not held
// after a failed operation, so a later attempt can still proceed.
func TestCodexAuthRefreshLockReleasedAfterFailure(t *testing.T) {
	home := t.TempDir()
	writeFakeAuth(t, home, map[string]any{
		"tokens": map[string]any{
			"access_token":  "fake-access-old",
			"account_id":    "fake-account-id",
			"refresh_token": "fake-refresh-token",
		},
	})

	withNativeRefresh(t, func(context.Context, string) error {
		return context.DeadlineExceeded
	})
	if _, err := codexExternalAuth(context.Background(), home, true, "fake-access-old"); err == nil {
		t.Fatal("expected the first attempt to fail")
	}

	// A subsequent attempt must still be able to take the lock.
	done := make(chan struct{})
	withNativeRefresh(t, func(context.Context, string) error {
		writeFakeAuth(t, home, map[string]any{
			"tokens": map[string]any{"access_token": "fake-access-recovered", "account_id": "fake-account-id"},
		})
		return nil
	})
	go func() {
		defer close(done)
		params, err := codexExternalAuth(context.Background(), home, true, "fake-access-old")
		if err != nil {
			t.Errorf("second attempt error = %v", err)
			return
		}
		if params["accessToken"] != "fake-access-recovered" {
			t.Errorf("accessToken = %v, want fake-access-recovered", params["accessToken"])
		}
	}()

	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("the refresh lock was not released after the failed attempt")
	}
}

// TestCodexAuthNativeRefreshRunsHelperSubprocess drives the real
// runNativeCodexRefresh through a real child process: the helper is resolved
// from PATH, speaks the app-server handshake over real pipes, and the bridge
// re-reads the source afterwards. Only the credentials are fake.
func TestCodexAuthNativeRefreshRunsHelperSubprocess(t *testing.T) {
	home := t.TempDir()
	authPath := writeFakeAuth(t, home, map[string]any{
		"tokens": map[string]any{
			"access_token":  "fake-access-old",
			"account_id":    "fake-account-id",
			"refresh_token": "fake-refresh-token",
		},
	})

	helperDir := t.TempDir()
	writeCodexAuthHelperBinary(t, helperDir)
	t.Setenv("PATH", helperDir+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv(codexAuthHelperHandshakeEnv, "1")
	withHelperProcess(t, "")

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := runNativeCodexRefresh(ctx, home); err != nil {
		t.Fatalf("runNativeCodexRefresh error = %v", err)
	}

	// The call only returns nil once the helper's replies were parsed, so the
	// handshake ran inside the real transport. The helper owns no mutation, so
	// the source must be untouched.
	after, err := readCodexSourceAuth(authPath)
	if err != nil {
		t.Fatalf("readCodexSourceAuth after refresh error = %v", err)
	}
	if after.AccessToken != "fake-access-old" {
		t.Fatalf("access token = %q, want the helper to leave it unchanged", after.AccessToken)
	}
}

// TestCodexAuthNativeRefreshCancellationReapsDescendant verifies cleanup kills
// the whole process group: the helper leaves a descendant holding its stdout,
// so returning promptly proves the tree was terminated rather than only the
// direct child.
func TestCodexAuthNativeRefreshCancellationReapsDescendant(t *testing.T) {
	home := t.TempDir()
	writeFakeAuth(t, home, map[string]any{
		"tokens": map[string]any{
			"access_token":  "fake-access-old",
			"account_id":    "fake-account-id",
			"refresh_token": "fake-refresh-token",
		},
	})

	withHelperProcess(t, writeCodexAuthBlockerHelperBinary(t))

	start := time.Now()
	params, err := codexExternalAuth(context.Background(), home, true, "fake-access-old")
	elapsed := time.Since(start)

	if err == nil {
		t.Fatal("expected the refresh to fail when the helper never answers")
	}
	if params != nil {
		t.Fatalf("params = %v, want none after a failed refresh", params)
	}
	// The budget plus one forced-kill window is the hard ceiling; a leaked
	// descendant holding stdout would push the wait far past it.
	if limit := codexAuthOperationBudget + codexForcedKillTimeout + 3*time.Second; elapsed > limit {
		t.Fatalf("refresh took %v, want it bounded under %v", elapsed, limit)
	}
}

// TestCodexAuthNativeRefreshFakeHelperPeer drives the refresh transport against
// an in-process fake peer. It asserts the exact handshake order and that no
// refresh token is ever transmitted by Forge.
func TestCodexAuthNativeRefreshFakeHelperPeer(t *testing.T) {
	fake := &fakeCodexAuthPeer{}
	home := t.TempDir()
	writeFakeAuth(t, home, map[string]any{
		"tokens": map[string]any{
			"access_token":  "fake-access-old",
			"account_id":    "fake-account-id",
			"refresh_token": "fake-refresh-token",
		},
	})

	withNativeRefresh(t, func(ctx context.Context, _ string) error {
		conn := fake.conn(t)
		return conn.refresh(ctx)
	})

	params, err := codexExternalAuth(context.Background(), home, true, "fake-access-old")
	if err != nil {
		t.Fatalf("codexExternalAuth error = %v", err)
	}
	if params["accessToken"] != "fake-access-old" {
		t.Fatalf("accessToken = %v, want fake-access-old", params["accessToken"])
	}

	methods := fake.recordedMethods()
	want := []string{"initialize", "initialized", "account/read"}
	if len(methods) != len(want) {
		t.Fatalf("handshake methods = %v, want %v", methods, want)
	}
	for i, method := range want {
		if methods[i] != method {
			t.Fatalf("handshake[%d] = %q, want %q", i, methods[i], method)
		}
	}
	if fake.sawRefreshToken {
		t.Fatal("Forge must never transmit the refresh token to the native CLI")
	}
	if fake.accountReadParams() != `{"refreshToken":true}` {
		t.Fatalf("account/read params = %s, want {\"refreshToken\":true}", fake.accountReadParams())
	}
}

// TestCodexAuthConnReportsEOF verifies a closed peer surfaces as a bounded,
// safe error instead of a hang.
func TestCodexAuthConnReportsEOF(t *testing.T) {
	conn := &codexAuthConn{
		stdin:  nopWriteCloser{},
		reader: bufio.NewReader(strings.NewReader("")),
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	_, err := conn.call(ctx, "initialize", map[string]any{})
	if err == nil {
		t.Fatal("expected an error when the peer closes the stream")
	}
	if !strings.Contains(err.Error(), "closed the connection") {
		t.Fatalf("error = %v, want a closed-connection diagnostic", err)
	}
}

// assertNoCredentialLeak fails when any needle appears in an error's text.
func assertNoCredentialLeak(t *testing.T, err error, needles ...string) {
	t.Helper()
	if err == nil {
		return
	}
	message := err.Error()
	for _, needle := range needles {
		if needle == "" {
			continue
		}
		if strings.Contains(message, needle) {
			t.Fatalf("error leaked credential material %q: %v", needle, err)
		}
	}
}

type nopWriteCloser struct{}

func (nopWriteCloser) Write(p []byte) (int, error) { return len(p), nil }
func (nopWriteCloser) Close() error                { return nil }

// fakeCodexAuthPeer is an in-memory JSON-RPC peer standing in for the native
// Codex CLI. It records the handshake so tests can assert ordering.
type fakeCodexAuthPeer struct {
	mu               sync.Mutex
	methods          []string
	sawRefreshToken  bool
	accountReadParam string
}

// conn wires a codexAuthConn to the fake peer over two io.Pipe pairs:
// clientWrite -> serverRead (Forge writes, peer reads) and
// serverWrite -> clientRead (peer writes, Forge reads).
func (f *fakeCodexAuthPeer) conn(t *testing.T) *codexAuthConn {
	t.Helper()
	serverRead, clientWrite := io.Pipe()
	clientRead, serverWrite := io.Pipe()
	go f.loop(t, serverRead, serverWrite)
	return &codexAuthConn{
		stdin:  clientWrite,
		reader: bufio.NewReader(clientRead),
	}
}

func (f *fakeCodexAuthPeer) loop(t *testing.T, serverRead io.Reader, serverWrite io.Writer) {
	t.Helper()
	defer serverWrite.(io.Closer).Close()
	scanner := bufio.NewScanner(serverRead)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		var req codexAuthWire
		if err := json.Unmarshal([]byte(line), &req); err != nil {
			continue
		}
		if strings.Contains(line, "refresh_token") || strings.Contains(line, "refreshtoken") {
			f.mu.Lock()
			f.sawRefreshToken = true
			f.mu.Unlock()
		}

		f.mu.Lock()
		f.methods = append(f.methods, req.Method)
		if req.Method == "account/read" {
			f.accountReadParam = string(req.Params)
		}
		f.mu.Unlock()

		if req.ID == nil {
			continue
		}
		writeCodexAuthResponse(serverWrite, *req.ID, map[string]any{})
	}
}

func (f *fakeCodexAuthPeer) recordedMethods() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.methods...)
}

func (f *fakeCodexAuthPeer) accountReadParams() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.accountReadParam
}

func writeCodexAuthResponse(stream io.Writer, id int, result any) {
	raw, err := json.Marshal(map[string]any{"id": id, "result": result})
	if err != nil {
		return
	}
	_, _ = stream.Write(append(raw, '\n'))
}
