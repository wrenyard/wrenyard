package driver

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// Native Codex credential bridge for the app-server transport.
//
// Forge never speaks OAuth itself. This module reads the *source* Codex home
// and turns its auth.json into the `account/login/start` params the child
// app-server understands. When the child asks for a refresh, the only
// permitted mutation is to ask the native Codex CLI to refresh its own
// credential; Forge simply re-reads the file afterwards. No OAuth HTTP is
// implemented here and no refresh token is ever copied, echoed, or logged.

const (
	// codexAuthFileMode is the mode of the source auth.json Forge reads.
	codexAuthFileMode = 0o600

	// codexAuthReadLimit bounds the auth.json read so a hostile or corrupt
	// file cannot be slurped into memory unbounded.
	codexAuthReadLimit = 1 << 20

	// codexAuthDefaultExecutable is the native CLI resolved through PATH when
	// no explicit override is set.
	codexAuthDefaultExecutable = "codex"

	// codexAuthOperationBudget bounds one full native refresh operation, the
	// advisory lock included.
	codexAuthOperationBudget = 8 * time.Second

	// codexAuthLockPoll is the interval between advisory-lock attempts.
	codexAuthLockPoll = 25 * time.Millisecond

	// codexAuthStderrLimit caps captured child stderr. Credential payloads are
	// never surfaced: the capture exists only for transport diagnostics.
	codexAuthStderrLimit = 4096
)

// codexAuthClientInfo is the client identity the native refresh handshake
// announces. It matches the app-server transport's identity so the native CLI
// treats both as the same client.
var codexAuthClientInfo = map[string]any{
	"name":    codexAppServerClientName,
	"title":   codexAppServerClientTitle,
	"version": codexAppServerClientVer,
}

// codexExternalAuth builds the `account/login/start` params for the child
// app-server from the source Codex home.
//
// sourceHome is the original Codex home (WRENYARD_CODEX_AUTH_HOME / CODEX_HOME
// / ~/.codex); the real HOME is never redirected. When the source holds
// ChatGPT tokens the result is:
//
//	{"type":"chatgptAuthTokens","accessToken":...,"chatgptAccountId":...}
//
// with chatgptPlanType added only when the source actually carries a plan.
// When the source has no ChatGPT tokens but does carry an API key the result
// is {"type":"apiKey","apiKey":...}. Missing or keyring-only auth yields a
// safe (credential-free) error.
//
// refresh requests a native refresh. It is serialized by a cross-process
// advisory lock keyed by sourceHome; the source file is re-read after the lock
// is taken, and when the access token already differs from previousAccess the
// caller's (fresher) token is reused without any extra work.
func codexExternalAuth(ctx context.Context, sourceHome string, refresh bool, previousAccess string) (map[string]any, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	home := strings.TrimSpace(sourceHome)
	if home == "" {
		return nil, codexAuthError("Codex auth home is unavailable")
	}
	authPath := filepath.Join(home, "auth.json")

	cred, err := readCodexSourceAuth(authPath)
	if err != nil {
		return nil, err
	}
	if refresh {
		// Re-read under the cross-process lock. A concurrent owner may have
		// already refreshed, in which case the newer token is reused as-is.
		cred, err = codexRefreshAuth(ctx, home, authPath, previousAccess, cred)
		if err != nil {
			return nil, err
		}
	}
	return codexAuthParams(cred)
}

// codexSourceAuth is the minimal credential view of a source auth.json.
// Token values are used only to build params and are never formatted into
// errors or logs. Whether a refresh token exists is tracked as a boolean: the
// value itself is never needed by Forge.
type codexSourceAuth struct {
	AccessToken string
	AccountID   string
	PlanType    string
	IsAPIKey    bool
	APIKey      string
	HasRefresh  bool
	HasChatGPT  bool
}

// codexAuthParams renders the account/login/start params for a credential.
// A ChatGPT token is only usable when the source also names its account, so a
// missing account id is reported as a safe error rather than sent as an empty
// field.
func codexAuthParams(cred codexSourceAuth) (map[string]any, error) {
	if token := strings.TrimSpace(cred.AccessToken); token != "" {
		account := strings.TrimSpace(cred.AccountID)
		if account == "" {
			return nil, codexAuthError("Codex auth.json ChatGPT token has no account id")
		}
		params := map[string]any{
			"type":             "chatgptAuthTokens",
			"accessToken":      token,
			"chatgptAccountId": account,
		}
		if plan := strings.TrimSpace(cred.PlanType); plan != "" {
			params["chatgptPlanType"] = plan
		}
		return params, nil
	}
	if key := strings.TrimSpace(cred.APIKey); key != "" {
		return map[string]any{"type": "apiKey", "apiKey": key}, nil
	}
	return nil, codexAuthError("Codex auth.json has no usable ChatGPT token or API key")
}

// readCodexSourceAuth reads only the few fields the bridge needs. Unknown
// shapes are tolerated; a missing file, an unreadable file, or a file with no
// usable credential is reported as a safe error that never echoes file
// contents.
func readCodexSourceAuth(authPath string) (codexSourceAuth, error) {
	var cred codexSourceAuth

	info, err := os.Stat(authPath)
	if err != nil {
		if os.IsNotExist(err) {
			return cred, codexAuthError("Codex auth.json not found")
		}
		return cred, codexAuthError("Codex auth.json is unreadable")
	}
	if info.IsDir() {
		return cred, codexAuthError("Codex auth.json is not a regular file")
	}
	if info.Size() > codexAuthReadLimit {
		return cred, codexAuthError("Codex auth.json is too large to read")
	}

	raw, err := readBoundedFile(authPath, codexAuthReadLimit)
	if err != nil {
		return cred, codexAuthError("Codex auth.json is unreadable")
	}

	var data map[string]any
	if err := json.Unmarshal(raw, &data); err != nil {
		return cred, codexAuthError("Codex auth.json is not valid JSON")
	}

	if tokens, ok := data["tokens"].(map[string]any); ok {
		cred.AccessToken = jsonStringField(tokens, "access_token")
		cred.AccountID = jsonStringField(tokens, "account_id")
		cred.PlanType = jsonStringField(tokens, "plan_type")
		cred.HasRefresh = jsonStringField(tokens, "refresh_token") != ""
		cred.HasChatGPT = cred.AccessToken != "" || cred.HasRefresh
		if cred.PlanType == "" {
			cred.PlanType = jsonStringField(data, "plan_type")
		}
	}
	if cred.APIKey == "" {
		cred.APIKey = jsonStringField(data, "OPENAI_API_KEY")
	}

	// Keyring-only auth: the source records that ChatGPT login exists but the
	// secret lives in the OS keyring, which Forge deliberately cannot read.
	if strings.TrimSpace(cred.AccessToken) == "" && strings.TrimSpace(cred.APIKey) == "" && codexAuthIsKeyringBacked(data, cred) {
		return cred, codexAuthError("Codex auth is stored in the OS keyring; re-run `codex login` to write auth.json")
	}
	return cred, nil
}

// codexAuthIsKeyringBacked reports whether the auth file claims a login whose
// secret is not embedded (ephemeral/keyring credential store).
func codexAuthIsKeyringBacked(data map[string]any, cred codexSourceAuth) bool {
	if store := strings.ToLower(jsonStringField(data, "cli_auth_credentials_store")); store == "keyring" {
		return true
	}
	if lastRefresh := jsonStringField(data, "last_refresh"); lastRefresh != "" {
		return true
	}
	return cred.HasChatGPT
}

// readBoundedFile reads at most limit+1 bytes so a caller can detect overflow.
func readBoundedFile(path string, limit int) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return io.ReadAll(io.LimitReader(f, int64(limit)+1))
}

// jsonStringField extracts a non-empty string field.
func jsonStringField(data map[string]any, key string) string {
	value, ok := data[key].(string)
	if !ok {
		return ""
	}
	return strings.TrimSpace(value)
}

// codexAuthError wraps a safe, credential-free diagnostic. The wrapped cause
// is never included: it is not needed to act on the message.
func codexAuthError(message string) error {
	return fmt.Errorf("codex auth: %s", message)
}

// errCodexAuthTimeout marks a native refresh that exceeded its budget.
var errCodexAuthTimeout = errors.New("codex auth: native refresh timed out")

// codexRefreshAuth re-reads the source after taking a cross-process advisory
// lock keyed by the source home, then refreshes through the native CLI when
// the source token is still the one the caller already held.
//
// The lock wait and the refresh share one budget, so a refresh can never
// outlast codexAuthOperationBudget. The lock is advisory and OS-backed, so it
// is released automatically if the holding process dies; it never leaks
// across a crash.
func codexRefreshAuth(ctx context.Context, home, authPath, previousAccess string, known codexSourceAuth) (codexSourceAuth, error) {
	ctx, cancel := context.WithTimeout(ctx, codexAuthOperationBudget)
	defer cancel()

	unlock, err := acquireCodexAuthLock(ctx, home)
	if err != nil {
		return known, err
	}
	defer unlock()

	// Re-read under the lock: a concurrent owner may have refreshed already.
	cred, err := readCodexSourceAuth(authPath)
	if err != nil {
		return known, err
	}
	if reuseCodexAccess(cred, known, previousAccess) {
		return cred, nil
	}
	if !cred.HasRefresh && strings.TrimSpace(cred.AccessToken) != "" {
		// Nothing to refresh with; the held token is the best available.
		return cred, nil
	}

	if err := codexAuthRunNative(ctx, home); err != nil {
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return known, errCodexAuthTimeout
		}
		return known, codexAuthError("native Codex refresh failed")
	}

	// The native refresh is the only sanctioned source mutation. Re-read the
	// original file rather than trusting any child output.
	refreshed, err := readCodexSourceAuth(authPath)
	if err != nil {
		return known, err
	}
	if strings.TrimSpace(refreshed.AccessToken) == "" {
		return known, codexAuthError("native Codex refresh produced no access token")
	}
	return refreshed, nil
}

// runNativeCodexRefresh drives the native Codex CLI through its app-server
// stdio protocol and asks it to refresh its own credential. Forge performs no
// OAuth exchange: it only triggers the native refresh and lets Codex rewrite
// its own auth.json.
//
// CODEX_HOME points at the source home so the native CLI mutates exactly the
// file Forge re-reads. The child runs in its own process group and its whole
// tree is terminated on every exit path, then reaped exactly once.
func runNativeCodexRefresh(ctx context.Context, home string) error {
	cmd := codexAuthNativeCommand(home)
	cmd.Stderr = &codexAuthDiscard{limit: codexAuthStderrLimit}
	configureCodexChildProcess(cmd)

	stdin, err := cmd.StdinPipe()
	if err != nil {
		return codexAuthError("prepare native Codex stdin")
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		_ = stdin.Close()
		return codexAuthError("prepare native Codex stdout")
	}
	if err := cmd.Start(); err != nil {
		_ = stdin.Close()
		return codexAuthError("start native Codex")
	}

	// waitDone carries the single wait result. Killing the process group also
	// makes the child exit, so a peer that died early resolves the tree kill
	// instead of stalling it.
	waitDone := make(chan error, 1)
	go func() {
		waitDone <- cmd.Wait()
		// Closing makes repeated completion observers safe: every later
		// receive returns immediately instead of blocking forever.
		close(waitDone)
	}()

	// Cleanup on every terminal path: close stdin, terminate any surviving
	// descendant, and collect the one wait result. The delete-helper and the
	// defer may race, so it is guarded by a Once.
	proc := codexAppServerProcess{cmd: cmd}
	var cleanupOnce sync.Once
	cleanup := func() {
		cleanupOnce.Do(func() {
			_ = stdin.Close()
			terminateCodexAppServerChild(proc, waitDone)
			_ = stdout.Close()
		})
	}
	defer cleanup()

	// Blocking reads are a lost peer, not a long refresh: a woken read fails
	// with a pipe error once the child tree is gone. Cancellation must
	// interrupt a blocking readOne, so it tears the child down exactly like
	// the defer does.
	stopCallback := context.AfterFunc(ctx, cleanup)
	defer stopCallback()

	conn := &codexAuthConn{
		stdin:  stdin,
		reader: bufio.NewReaderSize(stdout, 64*1024),
	}
	return conn.refresh(ctx)
}

// codexAuthNativeExecutable overrides the native Codex binary. Tests point it
// at a helper process; production leaves it empty so "codex" is resolved
// through PATH.
var codexAuthNativeExecutable = ""

// codexAuthNativeBinary resolves the native CLI, defaulting to PATH lookup.
func codexAuthNativeBinary() string {
	if executable := strings.TrimSpace(codexAuthNativeExecutable); executable != "" {
		return executable
	}
	return codexAuthDefaultExecutable
}

// reuseCodexAccess reports whether the freshly read credential is already
// different from what the caller held, meaning no refresh work is needed.
func reuseCodexAccess(current, known codexSourceAuth, previousAccess string) bool {
	token := strings.TrimSpace(current.AccessToken)
	if token == "" {
		return false
	}
	if previous := strings.TrimSpace(previousAccess); previous != "" && token != previous {
		return true
	}
	if knownToken := strings.TrimSpace(known.AccessToken); knownToken != "" && token != knownToken {
		return true
	}
	return false
}

// acquireCodexAuthLock takes the cross-process advisory lock for a source home
// and returns an idempotent release function. The lock file lives beside the
// auth file so its lifetime tracks the credential it protects.
func acquireCodexAuthLock(ctx context.Context, home string) (func(), error) {
	lockPath := filepath.Join(home, "forge-auth.refresh.lock")
	if err := os.MkdirAll(filepath.Dir(lockPath), 0o700); err != nil {
		return nil, codexAuthError("prepare auth refresh lock")
	}
	f, err := os.OpenFile(lockPath, os.O_CREATE|os.O_RDWR, codexAuthFileMode)
	if err != nil {
		return nil, codexAuthError("open auth refresh lock")
	}

	if err := acquireAuthGuard(f); err == nil {
		return codexAuthUnlock(f), nil
	} else if !authGuardContended(err) {
		// A lock that cannot be taken for any other reason will never become
		// takeable by retrying, so fail instead of spinning until the budget.
		_ = f.Close()
		return nil, codexAuthError("acquire auth refresh lock")
	}

	// Contended: wait for the holder, bounded by the caller's context.
	ticker := time.NewTicker(codexAuthLockPoll)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			_ = f.Close()
			return nil, ctx.Err()
		case <-ticker.C:
			if err := acquireAuthGuard(f); err == nil {
				return codexAuthUnlock(f), nil
			} else if !authGuardContended(err) {
				_ = f.Close()
				return nil, codexAuthError("acquire auth refresh lock")
			}
		}
	}
}

// codexAuthUnlock releases the OS lock and closes the lock file. It is safe to
// call more than once.
func codexAuthUnlock(f *os.File) func() {
	var once sync.Once
	return func() {
		once.Do(func() {
			_ = releaseAuthGuard(f)
			_ = f.Close()
		})
	}
}

// codexAuthNativeEnv builds the native CLI environment. CODEX_HOME is pinned
// to the source home, every API-key variable is cleared so the native CLI uses
// the ChatGPT credential being refreshed, and the inherited parent
// environment (including the real HOME) is preserved.
func codexAuthNativeEnv(home string) []string {
	return BuildChildEnv(map[string]string{
		"CODEX_HOME":     home,
		"CODEX_API_KEY":  "",
		"OPENAI_API_KEY": "",
	})
}

// codexAuthRunNative performs the native credential refresh. Tests replace it
// with a stub; the production value always launches the real CLI.
var codexAuthRunNative = func(ctx context.Context, home string) error {
	return runNativeCodexRefresh(ctx, home)
}

// codexAuthHelperCommand lets a test stand in for the native CLI: it receives
// the command already built for the requested home and returns the command to
// start. The request path stays production code, so only the process is faked.
var codexAuthHelperCommand func(cmd *exec.Cmd) *exec.Cmd

// codexAuthNativeCommand builds the native CLI command for a source home.
func codexAuthNativeCommand(home string) *exec.Cmd {
	cmd := exec.Command(codexAuthNativeBinary(), "app-server", "--stdio")
	cmd.Env = codexAuthNativeEnv(home)
	if codexAuthHelperCommand != nil {
		return codexAuthHelperCommand(cmd)
	}
	return cmd
}

// codexAuthDiscard caps how much child stderr is retained. Nothing is ever
// forwarded: the capture exists only to keep the pipe drained so the child
// cannot block on a full stderr buffer.
type codexAuthDiscard struct {
	mu      sync.Mutex
	limit   int
	written int
}

func (w *codexAuthDiscard) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.written < w.limit {
		remaining := w.limit - w.written
		if len(p) < remaining {
			remaining = len(p)
		}
		w.written += remaining
	}
	return len(p), nil
}

// codexAuthConn is a minimal, strictly serialized JSON-RPC client over the
// native CLI's stdio. Requests are issued one at a time; notifications are
// skipped; EOF and context cancellation terminate the exchange.
type codexAuthConn struct {
	stdin  io.WriteCloser
	reader *bufio.Reader

	mu     sync.Mutex
	nextID int
}

// refresh performs the initialize -> initialized -> account/read handshake.
// Every method here is credential-free: the native CLI owns the refresh and
// Forge never transmits a refresh token.
func (c *codexAuthConn) refresh(ctx context.Context) error {
	if _, err := c.call(ctx, "initialize", map[string]any{"clientInfo": codexAuthClientInfo}); err != nil {
		return err
	}
	if err := c.notify("initialized"); err != nil {
		return err
	}
	if _, err := c.call(ctx, "account/read", map[string]any{"refreshToken": true}); err != nil {
		return err
	}
	return nil
}

// call issues one request and waits for its matching response. Unknown
// notifications are ignored so asynchronous traffic cannot stall the wait.
func (c *codexAuthConn) call(ctx context.Context, method string, params any) (json.RawMessage, error) {
	c.mu.Lock()
	c.nextID++
	id := c.nextID
	c.mu.Unlock()

	rawParams, err := encodeCodexAppServerParams(params)
	if err != nil {
		return nil, codexAuthError("encode native request")
	}
	if err := c.send(codexAuthWire{ID: &id, Method: method, Params: rawParams}); err != nil {
		return nil, codexAuthError("write native request")
	}

	for {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		default:
		}

		msg, err := c.readOne()
		if err != nil {
			if errors.Is(err, io.EOF) {
				return nil, codexAuthError("native Codex closed the connection")
			}
			return nil, err
		}
		if msg.Method != "" {
			continue // notification or server request — not our response
		}
		if msg.ID == nil || *msg.ID != id {
			continue
		}
		if msg.Error != nil {
			return nil, codexAuthError(fmt.Sprintf("native Codex rejected %s (%d)", method, msg.Error.Code))
		}
		return msg.Result, nil
	}
}

// notify sends a JSON-RPC notification with no id and no params field.
func (c *codexAuthConn) notify(method string) error {
	if err := c.send(codexAuthWire{Method: method}); err != nil {
		return codexAuthError("write native notification")
	}
	return nil
}

func (c *codexAuthConn) send(msg codexAuthWire) error {
	body, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	body = append(body, '\n')
	_, err = c.stdin.Write(body)
	return err
}

// readOne decodes one newline-delimited message. Blank lines are skipped; a
// decode failure is fatal rather than silently ignored.
func (c *codexAuthConn) readOne() (codexAuthWire, error) {
	for {
		line, err := c.reader.ReadBytes('\n')
		trimmed := bytes.TrimSpace(line)
		if len(trimmed) > 0 {
			var msg codexAuthWire
			if decodeErr := json.Unmarshal(trimmed, &msg); decodeErr != nil {
				return codexAuthWire{}, codexAuthError("native Codex sent a malformed message")
			}
			return msg, nil
		}
		if err != nil {
			return codexAuthWire{}, err
		}
	}
}

// codexAuthWire is the native CLI's JSON-RPC envelope. No mandatory jsonrpc
// field: the app-server protocol omits it.
type codexAuthWire struct {
	ID     *int                `json:"id,omitempty"`
	Method string              `json:"method,omitempty"`
	Params json.RawMessage     `json:"params,omitempty"`
	Result json.RawMessage     `json:"result,omitempty"`
	Error  *codexAuthWireError `json:"error,omitempty"`
}

type codexAuthWireError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}
