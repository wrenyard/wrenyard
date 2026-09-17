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

// Codex app-server transport. Forge drives `codex app-server --stdio`
// as a JSON-RPC peer instead of the one-shot `codex exec` JSONL stream. The
// bridge converts the native thread/turn/item notification schema into the
// existing exec-shaped internal records so normalize.go's codexNormalizer stays
// the single owner of normalized content.
//
// The transport is deliberately closed: `codex exec` is never an alternative
// path here, and no delegation or plan agent is involved.

const (
	// wrenyardCodexAuthHomeEnv names the original (source) Codex home whose
	// staged ChatGPT credentials authenticated this run.
	wrenyardCodexAuthHomeEnv = "WRENYARD_CODEX_AUTH_HOME"
	// wrenyardCodexHomeEnv names the stable isolated Codex home the child uses.
	wrenyardCodexHomeEnv       = "WRENYARD_CODEX_HOME"
	codexAppServerClientName   = "wrenyard-forge"
	codexAppServerClientTitle  = "Wrenyard Forge"
	codexAppServerClientVer    = "0.0.0"
	codexStderrCaptureLimit    = 4096
	codexCleanupBoundedTimeout = 2 * time.Second
)

// codexAppServerInvocation is the transport-level view of the internal Codex
// argv.
type codexAppServerInvocation struct {
	Model             string
	Sandbox           string
	ResumeID          string
	OutputLastMessage string
	ReasoningEffort   string
	Search            bool
	RawConfig         []string

	// AuthEnabled is resolved from the provider configuration, never from
	// argv, and only selects whether the child gets the ephemeral credential
	// store override.
	AuthEnabled bool
}

// parseCodexAppServerArgs interprets the internal argv Forge hands to the
// app-server transport. Config overrides are collected separately so callers
// can assert they are placed before the `app-server` subcommand.
func parseCodexAppServerArgs(args []string) (codexAppServerInvocation, error) {
	var inv codexAppServerInvocation
	for i := 0; i < len(args); i++ {
		arg := args[i]
		next := func() (string, error) {
			if i+1 >= len(args) {
				return "", fmt.Errorf("codex app-server: %s requires a value", arg)
			}
			i++
			return args[i], nil
		}
		switch {
		case arg == "--search":
			inv.Search = true
		case arg == "--strict-config":
		case arg == "--model":
			value, err := next()
			if err != nil {
				return inv, err
			}
			inv.Model = value
		case arg == "--sandbox":
			value, err := next()
			if err != nil {
				return inv, err
			}
			inv.Sandbox = value
		case arg == "--resume":
			value, err := next()
			if err != nil {
				return inv, err
			}
			inv.ResumeID = value
		case arg == "--output-last-message":
			value, err := next()
			if err != nil {
				return inv, err
			}
			inv.OutputLastMessage = value
		case arg == "-c" || arg == "--config":
			value, err := next()
			if err != nil {
				return inv, err
			}
			inv.consumeConfig(value)
		case strings.HasPrefix(arg, "-c="), strings.HasPrefix(arg, "--config="):
			inv.consumeConfig(arg[strings.IndexByte(arg, '=')+1:])
		case strings.HasPrefix(arg, "-c"):
			inv.consumeConfig(strings.TrimPrefix(arg, "-c"))
		case strings.TrimSpace(arg) == "":
			// Tolerate empty padding entries.
		case arg == "-":
			// Trailing stdin marker: the prompt already arrives on stdin.
		case strings.HasPrefix(arg, "-"):
			return inv, fmt.Errorf("codex app-server: unexpected flag %q", arg)
		default:
			return inv, fmt.Errorf("codex app-server: unexpected positional argument %q", arg)
		}
	}
	return inv, nil
}

// consumeConfig records one `-c key=value` override. model_reasoning_effort is
// extracted because it must also travel on the turn/start request.
func (inv *codexAppServerInvocation) consumeConfig(entry string) {
	entry = strings.TrimSpace(entry)
	if entry == "" {
		return
	}
	key, value, ok := strings.Cut(entry, "=")
	if !ok {
		inv.RawConfig = append(inv.RawConfig, entry)
		return
	}
	if strings.TrimSpace(key) == "model_reasoning_effort" {
		if inv.ReasoningEffort == "" {
			inv.ReasoningEffort = unquoteCodexConfigValue(value)
		}
		return
	}
	inv.RawConfig = append(inv.RawConfig, entry)
}

func unquoteCodexConfigValue(value string) string {
	value = strings.TrimSpace(value)
	if len(value) >= 2 && (value[0] == '"' || value[0] == '\'') && value[len(value)-1] == value[0] {
		return value[1 : len(value)-1]
	}
	return value
}

func (inv codexAppServerInvocation) configValue(key string) (string, bool) {
	for _, entry := range inv.RawConfig {
		entryKey, value, ok := strings.Cut(entry, "=")
		if ok && strings.TrimSpace(entryKey) == key {
			return unquoteCodexConfigValue(value), true
		}
	}
	return "", false
}

// codexAppServerCommandArgs renders the child argv with the app-server
// subcommand LAST: every config override precedes it. The protocol transport is
// selected by --stdio; there is no --listen flag. The model is not a CLI
// argument: it travels on the thread/start request.
func codexAppServerCommandArgs(inv codexAppServerInvocation) []string {
	args := make([]string, 0, 2*len(inv.RawConfig)+8)
	for _, entry := range inv.RawConfig {
		args = append(args, "-c", entry)
	}
	if inv.Search {
		// The interactive app-server has no --search flag; live web search is
		// engaged through the documented config override instead.
		args = append(args, "-c", "web_search="+tomlLiteral("live"))
	}
	// Approvals are always "never": Forge runs unattended and this transport
	// auto-accepts every known approval request.
	args = append(args, "-c", "approval_policy="+tomlLiteral("never"))
	if sandbox := strings.TrimSpace(inv.Sandbox); sandbox != "" {
		args = append(args, "-c", "sandbox_mode="+tomlLiteral(sandbox))
	}
	if inv.AuthEnabled {
		// The injected ChatGPT token is held in process memory only. A config
		// override is the only thing that selects the ephemeral store: an
		// environment variable of the same name has no effect on the child.
		args = append(args, "-c", "cli_auth_credentials_store="+tomlLiteral("ephemeral"))
	}
	return append(args, "app-server", "--stdio")
}

// codexAppServerAuth is the resolved ChatGPT credential state for the child.
type codexAppServerAuth struct {
	Enabled    bool
	SourceHome string
}

// nativeCodexProvider reports whether the run uses native OpenAI/ChatGPT auth.
// A provider override (model_provider != openai) is served by the local
// Gateway: gateway environment passes through unchanged and no native auth is
// injected.
func nativeCodexProvider(inv codexAppServerInvocation) bool {
	provider, ok := inv.configValue("model_provider")
	return !ok || provider == "openai"
}

func resolveCodexAppServerAuth(inv codexAppServerInvocation) codexAppServerAuth {
	if !nativeCodexProvider(inv) {
		return codexAppServerAuth{}
	}
	return codexAppServerAuth{Enabled: true, SourceHome: codexAuthSourceHome()}
}

// codexAuthSourceHome resolves the original Codex home supplied by Forge,
// falling back to CODEX_HOME and finally ~/.codex. It is read-only here: the
// auth module owns every credential read and refresh.
func codexAuthSourceHome() string {
	for _, key := range []string{wrenyardCodexAuthHomeEnv, "CODEX_HOME"} {
		if value := strings.TrimSpace(os.Getenv(key)); value != "" {
			return value
		}
	}
	if home, err := os.UserHomeDir(); err == nil && strings.TrimSpace(home) != "" {
		return filepath.Join(home, ".codex")
	}
	return ""
}

// codexIsolatedHome resolves the stable per-user isolated Codex home. It is
// never copied from the source home: no config and no credentials are
// mirrored, and the inherited HOME is preserved untouched.
func codexIsolatedHome() (string, error) {
	if value := strings.TrimSpace(os.Getenv(wrenyardCodexHomeEnv)); value != "" {
		return value, nil
	}
	cache, err := os.UserCacheDir()
	if err != nil {
		return "", fmt.Errorf("codex app-server: resolve isolated Codex home: %w", err)
	}
	return filepath.Join(cache, "wrenyard", "codex-home"), nil
}

// codexAppServerEnv builds the child environment. CODEX_HOME points at the
// isolated home with an ephemeral credential store so no ChatGPT token is
// persisted; the API-key variables are cleared so the injected credentials are
// the only possible source. Everything else, including the Gateway variables,
// is inherited by BuildChildEnv.
func codexAppServerEnv(auth codexAppServerAuth, isolatedHome string) []string {
	planned := map[string]string{"CODEX_HOME": isolatedHome}
	if auth.Enabled {
		planned["CODEX_API_KEY"] = ""
		planned["OPENAI_API_KEY"] = ""
	}
	return BuildChildEnv(planned)
}

// RunCodexAppServer executes one Codex app-server turn, streaming
// exec-compatible JSONL records to output and returning the child exit code.
func RunCodexAppServer(ctx context.Context, input io.Reader, output, errorOutput io.Writer, args []string) int {
	inv, err := parseCodexAppServerArgs(args)
	if err != nil {
		writeCodexAppServerError(errorOutput, err)
		return 2
	}
	return runCodexAppServerWithInvocation(ctx, input, output, errorOutput, inv)
}

func runCodexAppServerWithInvocation(ctx context.Context, input io.Reader, output, errorOutput io.Writer, inv codexAppServerInvocation) int {
	if ctx == nil {
		ctx = context.Background()
	}
	isolatedHome, err := codexIsolatedHome()
	if err != nil {
		writeCodexAppServerError(errorOutput, err)
		return 1
	}
	auth := resolveCodexAppServerAuth(inv)
	if auth.Enabled && auth.SourceHome == "" {
		writeCodexAppServerError(errorOutput, errors.New("codex app-server: ChatGPT auth home is unavailable"))
		return 1
	}
	if err := os.MkdirAll(isolatedHome, 0o700); err != nil {
		writeCodexAppServerError(errorOutput, fmt.Errorf("codex app-server: prepare isolated home: %w", err))
		return 1
	}
	prompt, err := readCodexAppServerPrompt(input)
	if err != nil {
		writeCodexAppServerError(errorOutput, err)
		return 1
	}

	bridge := newCodexAppServerBridge(auth, inv)
	code, runErr := bridge.run(ctx, isolatedHome, prompt, output, errorOutput)
	if runErr != nil {
		writeCodexAppServerError(errorOutput, runErr)
		if bridge.failureEmitted {
			// The failure is already visible on the transcript; report it as a
			// failed turn rather than as a transport crash.
			return code
		}
		return 1
	}
	return code
}

func writeCodexAppServerError(w io.Writer, err error) {
	if w == nil || err == nil {
		return
	}
	fmt.Fprintln(w, err)
}

// readCodexAppServerPrompt consumes the raw prompt from stdin. A missing
// reader is an empty prompt so a resume can still be driven.
func readCodexAppServerPrompt(input io.Reader) (string, error) {
	if input == nil {
		return "", nil
	}
	data, err := io.ReadAll(input)
	if err != nil {
		return "", fmt.Errorf("codex app-server: read prompt: %w", err)
	}
	return string(data), nil
}

// codexAppServerProcess is the running child, or an in-memory peer in tests.
type codexAppServerProcess struct {
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	stdout io.Reader
}

// codexAppServerStarter starts the app-server peer. It is a seam so tests can
// substitute a fake JSON-RPC server with no live process.
type codexAppServerStarter func(ctx context.Context, home string, args []string, env []string, stderr io.Writer) (codexAppServerProcess, error)

var defaultCodexAppServerStarter codexAppServerStarter = startCodexAppServerProcess

func startCodexAppServerProcess(ctx context.Context, _ string, args []string, env []string, stderr io.Writer) (codexAppServerProcess, error) {
	cmd := exec.CommandContext(ctx, "codex", args...)
	cmd.Env = env
	cmd.Stderr = stderr
	configureCodexChildProcess(cmd)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return codexAppServerProcess{}, fmt.Errorf("codex app-server: stdin pipe: %w", err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		_ = stdin.Close()
		return codexAppServerProcess{}, fmt.Errorf("codex app-server: stdout pipe: %w", err)
	}
	if err := cmd.Start(); err != nil {
		_ = stdin.Close()
		return codexAppServerProcess{}, fmt.Errorf("codex app-server: start: %w", err)
	}
	return codexAppServerProcess{cmd: cmd, stdin: stdin, stdout: stdout}, nil
}

// codexAppServerBridge owns the JSON-RPC conversation for one run.
type codexAppServerBridge struct {
	auth    codexAppServerAuth
	inv     codexAppServerInvocation
	starter codexAppServerStarter

	conn   *codexAppServerConn
	output io.Writer

	// runCtx is the run's context. Server-initiated work that happens while
	// the bridge is not parked on a request (an auth refresh) is scoped to it
	// so a cancelled task cancels that work too.
	runCtx context.Context

	accessToken string

	threadID string
	turnID   string
	model    string

	sampler responseTPSSampler

	// Per-response generation window. Deltas of one response accumulate here,
	// concatenated per content channel and item id; the sample measures from
	// the first to the last non-empty delta, never the completion's arrival.
	responseWindow codexDeltaWindow
	responseSeq    int

	// Per-response usage window for the CURRENT TURN. turn/completed carries no
	// usage, so each distinct rawResponse/completed is accumulated here. The
	// window is keyed by response id so a duplicate completion is counted once
	// per turn; it is never the cumulative thread usage, which a resumed
	// session would double count.
	responseUsageSeen     map[string]bool
	responseInputTokens   int64
	responseOutputTokens  int64
	responseCachedTokens  int64
	responseUsageObserved bool

	// Resume usage window. Codex 0.148 thread/resume has no rawResponse
	// completions, so a resumed turn learns usage only from
	// thread/tokenUsage/updated. That notification's `total` is cumulative for
	// the whole thread, so only the delta from the pre-turn baseline belongs to
	// this turn. The state is per bridge (per task) and never global.
	resumeUsage          codexResumeUsageState
	resumeUsageSeenTotal *codexResumeTotals

	lastAgentMessage string

	turnCompleted   bool
	turnFailed      bool
	transportFailed bool
	transportErr    error
	terminal        bool

	failureEmitted bool
}

// codexAppServerThread is the native thread identity resolved by thread/start
// or thread/resume.
type codexAppServerThread struct {
	ThreadID string
	Model    string
}

func newCodexAppServerBridge(auth codexAppServerAuth, inv codexAppServerInvocation) *codexAppServerBridge {
	inv.AuthEnabled = auth.Enabled
	return &codexAppServerBridge{
		auth:              auth,
		inv:               inv,
		model:             strings.TrimSpace(inv.Model),
		sampler:           newResponseTPSSampler(nil),
		responseUsageSeen: make(map[string]bool),
		resumeUsage:       newCodexResumeUsageState(),
	}
}

// codexAppServerConn is the JSON-RPC client over the child's stdio. A dedicated
// reader goroutine decodes every newline-delimited message onto a buffered
// channel, so a request waiting for its response still dispatches
// notifications in arrival order and no event is dropped between polls.
type codexAppServerConn struct {
	stdin io.WriteCloser

	writeMu sync.Mutex
	idMu    sync.Mutex
	nextID  int64
	closed  bool
	readErr error

	// done is closed exactly once when the connection is torn down. The
	// reader goroutine selects on it, so teardown never blocks on a full
	// stream buffer and cannot leak the reader.
	done     chan struct{}
	doneOnce sync.Once

	stream chan codexAppServerMessage
}

// closeDone signals teardown to every waiter exactly once.
func (c *codexAppServerConn) closeDone() {
	c.doneOnce.Do(func() { close(c.done) })
}

// codexAppServerMessage is the JSON-RPC envelope. Server request ids may be
// numeric or string, so the raw rendering is preserved and echoed back on the
// response instead of being coerced to one shape.
type codexAppServerMessage struct {
	ID     json.RawMessage `json:"id,omitempty"`
	Method string          `json:"method,omitempty"`
	Params json.RawMessage `json:"params,omitempty"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  *codexRPCError  `json:"error,omitempty"`
}

// hasID reports whether the message carries a request id at all, including a
// JSON null.
func (m codexAppServerMessage) hasID() bool { return len(m.ID) > 0 }

// equalsNumber reports whether the message id is this client's own numeric
// request id. Only the client's own ids are compared numerically, and a
// non-numeric id (a string or null) never matches.
func (m codexAppServerMessage) equalsNumber(id int64) bool {
	if !m.hasID() {
		return false
	}
	var numeric int64
	if err := json.Unmarshal(m.ID, &numeric); err != nil {
		return false
	}
	return numeric == id
}

type codexRPCError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type codexAppServerRequestError struct {
	Code    int
	Message string
	Method  string
}

func (e *codexAppServerRequestError) Error() string {
	return fmt.Sprintf("codex app-server: %s failed (%d): %s", e.Method, e.Code, e.Message)
}

// errCodexAppServerMalformed marks a decode failure. It always fails the turn;
// it is never mistaken for clean end of stream.
var errCodexAppServerMalformed = errors.New("codex app-server: malformed protocol message")

// errCodexAppServerClosed marks a truncated stream. Neither error is retried.
var errCodexAppServerClosed = errors.New("codex app-server: connection closed before the turn finished")

func newCodexAppServerConn(stdin io.WriteCloser, stdout io.Reader) *codexAppServerConn {
	conn := &codexAppServerConn{
		stdin:  stdin,
		done:   make(chan struct{}),
		stream: make(chan codexAppServerMessage, 1024),
	}
	go conn.readLoop(stdout)
	return conn
}

func (c *codexAppServerConn) readLoop(stdout io.Reader) {
	defer close(c.stream)
	reader := bufio.NewReaderSize(stdout, 64*1024)
	for {
		line, err := reader.ReadBytes('\n')
		if trimmed := bytes.TrimSpace(line); len(trimmed) > 0 {
			var msg codexAppServerMessage
			if decodeErr := json.Unmarshal(trimmed, &msg); decodeErr != nil {
				// A malformed line is a protocol failure, never silently
				// skipped: skipping could desynchronise the response stream.
				c.fail(fmt.Errorf("%w: %v", errCodexAppServerMalformed, decodeErr))
				return
			}
			// A full buffer must never pin the reader goroutine forever: once
			// the connection is torn down the reader gives up the message and
			// ends.
			select {
			case c.stream <- msg:
			case <-c.done:
				return
			}
		}
		if err != nil {
			if errors.Is(err, io.EOF) {
				c.fail(errCodexAppServerClosed)
			} else {
				c.fail(err)
			}
			return
		}
	}
}

func (c *codexAppServerConn) fail(err error) {
	c.writeMu.Lock()
	if !c.closed {
		c.closed = true
		c.readErr = err
	}
	c.writeMu.Unlock()
}

func (c *codexAppServerConn) send(msg codexAppServerMessage) error {
	body, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	body = append(body, '\n')
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	if c.closed {
		return io.ErrClosedPipe
	}
	_, err = c.stdin.Write(body)
	return err
}

func (c *codexAppServerConn) notify(method string, params any) error {
	raw, err := encodeCodexAppServerParams(params)
	if err != nil {
		return err
	}
	return c.send(codexAppServerMessage{Method: method, Params: raw})
}

// respond answers a server request, echoing the request's own id verbatim so a
// numeric id stays numeric and a string id stays a string.
func (c *codexAppServerConn) respond(id json.RawMessage, result any) error {
	raw, err := encodeCodexAppServerParams(result)
	if err != nil {
		return err
	}
	return c.send(codexAppServerMessage{ID: id, Result: raw})
}

func (c *codexAppServerConn) respondMethodNotFound(id json.RawMessage, method string) error {
	return c.send(codexAppServerMessage{
		ID:    id,
		Error: &codexRPCError{Code: -32601, Message: fmt.Sprintf("method not found: %s", method)},
	})
}

func encodeCodexAppServerParams(value any) (json.RawMessage, error) {
	if value == nil {
		return nil, nil
	}
	body, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	return json.RawMessage(body), nil
}

// call issues a numbered request and pumps every inbound message until its
// matching response arrives, the context is cancelled, or the peer fails.
// Notifications observed while waiting are dispatched through handle, so a
// server request that arrives mid-wait is still answered.
func (c *codexAppServerConn) call(ctx context.Context, method string, params any, handle func(codexAppServerMessage) error) (json.RawMessage, error) {
	c.idMu.Lock()
	c.nextID++
	id := c.nextID
	c.idMu.Unlock()

	raw, err := encodeCodexAppServerParams(params)
	if err != nil {
		return nil, err
	}
	requestID, err := json.Marshal(id)
	if err != nil {
		return nil, err
	}
	if err := c.send(codexAppServerMessage{ID: requestID, Method: method, Params: raw}); err != nil {
		return nil, err
	}

	for {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case msg, ok := <-c.stream:
			if !ok {
				return nil, c.streamError()
			}
			isResponse := msg.Method == "" && msg.equalsNumber(id)
			if !isResponse {
				if handle != nil {
					if handleErr := handle(msg); handleErr != nil {
						return nil, handleErr
					}
				}
				continue
			}
			if msg.Error != nil {
				return nil, &codexAppServerRequestError{Code: msg.Error.Code, Message: msg.Error.Message, Method: method}
			}
			return msg.Result, nil
		}
	}
}

func (c *codexAppServerConn) streamError() error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	if c.readErr != nil {
		return c.readErr
	}
	return errCodexAppServerClosed
}

// close tears the connection down: the reader goroutine is released even if it
// is parked on a full stream buffer, and the write lock is only taken after
// stdin is closed so a writer blocked inside Write cannot hold teardown up.
func (c *codexAppServerConn) close() {
	c.closeDone()
	if c.stdin != nil {
		_ = c.stdin.Close()
	}
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	c.closed = true
}
