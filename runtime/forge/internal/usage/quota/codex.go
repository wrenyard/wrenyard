package quota

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"strings"
	"sync"
	"time"
)

// errCodexAppServerNotFound is returned when the codex binary cannot be found.
var errCodexAppServerNotFound = errors.New("codex executable not found")

// codexAppServerProcess holds the subprocess state from RunRPC.
// Fake processes may have nil cmd, nil stderrBuf.
type codexAppServerProcess struct {
	cmd       *exec.Cmd
	stdout    io.Reader
	stdin     io.WriteCloser
	stderrBuf *bytes.Buffer
}

// CodexProvider fetches Codex quota via the codex app-server stdio protocol.
// It has exactly one authoritative source: account/rateLimits/read.
type CodexProvider struct {
	ProviderName string

	// RunRPC is a test seam. When non-nil it is called instead of exec.Command
	// to start the codex app-server subprocess. It must return a
	// codexAppServerProcess and any startup error.
	RunRPC func(ctx context.Context, args []string) (codexAppServerProcess, error)
}

func (p CodexProvider) Name() string {
	if strings.TrimSpace(p.ProviderName) != "" {
		return strings.TrimSpace(p.ProviderName)
	}
	return "codex"
}

// bucketForProvider maps a Codex provider name to the rate limits bucket ID
// used in the account/rateLimits/read RPC.
func bucketForProvider(provider string) string {
	provider = strings.ToLower(strings.TrimSpace(provider))
	provider = strings.ReplaceAll(provider, "_", "-")
	switch provider {
	case "codex-spark":
		return "codex_bengalfox"
	default:
		return "codex"
	}
}

// GetAccountRateLimitsResponse mirrors the generated account/rateLimits/read result.
type GetAccountRateLimitsResponse struct {
	RateLimitsByLimitID map[string]RateLimitsEntry `json:"rateLimitsByLimitId"`
}

// RateLimitsEntry is a single rate limit entry keyed by limitId.
type RateLimitsEntry struct {
	Primary   *RateLimitWindow `json:"primary"`
	Secondary *RateLimitWindow `json:"secondary"`
	PlanType  string           `json:"planType"`
	LimitID   string           `json:"limitId"`
	LimitName string           `json:"limitName"`
}

// RateLimitWindow is a single rate limit window.
type RateLimitWindow struct {
	UsedPercent    *float64 `json:"usedPercent"`
	WindowDuration *float64 `json:"windowDurationMins"`
	ResetsAt       *float64 `json:"resetsAt"`
}

// jsonrpcMessage is a JSON-RPC message on the wire. No mandatory jsonrpc field.
type jsonrpcMessage struct {
	ID     *int            `json:"id,omitempty"`
	Method string          `json:"method,omitempty"`
	Params json.RawMessage `json:"params,omitempty"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  *jsonrpcError   `json:"error,omitempty"`
}

type jsonrpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

// rpcConn manages the stdio connection to a JSON-RPC subprocess over newline-delimited JSON.
type rpcConn struct {
	cmd       *exec.Cmd
	stdin     io.WriteCloser
	stdout    io.Reader
	mu        sync.Mutex
	nextID    int
	scanner   *bufio.Scanner
	stderrBuf *bytes.Buffer
}

// defaultCodexRunRPC starts the real codex app-server subprocess.
func defaultCodexRunRPC(ctx context.Context, _ []string) (codexAppServerProcess, error) {
	codexPath, err := exec.LookPath("codex")
	if err != nil {
		return codexAppServerProcess{}, err
	}
	cmd := exec.CommandContext(ctx, codexPath, "app-server", "--stdio")
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return codexAppServerProcess{}, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		stdin.Close()
		return codexAppServerProcess{}, err
	}
	var stderrBuf bytes.Buffer
	cmd.Stderr = &limitWriter{w: &stderrBuf, limit: 4096}
	applyCodexHiddenProcess(cmd)
	if err := cmd.Start(); err != nil {
		stdin.Close()
		return codexAppServerProcess{}, err
	}
	return codexAppServerProcess{cmd: cmd, stdout: stdout, stdin: stdin, stderrBuf: &stderrBuf}, nil
}

// limitWriter is an io.Writer that discards writes after N bytes.
type limitWriter struct {
	w       io.Writer
	limit   int
	written int
}

func (w *limitWriter) Write(p []byte) (int, error) {
	remaining := w.limit - w.written
	if remaining <= 0 {
		return len(p), nil
	}
	originalLen := len(p)
	if len(p) > remaining {
		p = p[:remaining]
	}
	n, err := w.w.Write(p)
	w.written += n
	if err != nil {
		return n, err
	}
	return originalLen, nil
}

func (c *rpcConn) call(ctx context.Context, method string, params json.RawMessage) (json.RawMessage, error) {
	c.mu.Lock()
	c.nextID++
	id := c.nextID
	c.mu.Unlock()

	msg := jsonrpcMessage{
		ID:     &id,
		Method: method,
		Params: params,
	}

	body, err := json.Marshal(msg)
	if err != nil {
		return nil, err
	}

	// Write as newline-delimited JSON.
	body = append(body, '\n')
	if _, err := c.stdin.Write(body); err != nil {
		return nil, err
	}

	// Read response messages until we find one matching our ID.
	for {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		default:
		}

		resp, err := c.readOneLine()
		if err != nil {
			return nil, err
		}

		// Ignore notifications (no ID).
		if resp.ID == nil {
			continue
		}

		// Match our request ID.
		if *resp.ID != id {
			continue
		}

		if resp.Error != nil {
			return nil, fmt.Errorf("JSON-RPC error %d: %s", resp.Error.Code, resp.Error.Message)
		}

		return resp.Result, nil
	}
}

// notify sends a JSON-RPC notification (no ID).
func (c *rpcConn) notify(method string, params json.RawMessage) {
	msg := jsonrpcMessage{
		Method: method,
		Params: params,
	}
	body, err := json.Marshal(msg)
	if err != nil {
		return
	}
	body = append(body, '\n')
	c.stdin.Write(body)
}

// readOneLine reads one newline-delimited JSON message from the stdio stream.
func (c *rpcConn) readOneLine() (jsonrpcMessage, error) {
	if c.scanner == nil {
		c.scanner = bufio.NewScanner(c.stdout)
		c.scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	}
	for c.scanner.Scan() {
		line := strings.TrimSpace(c.scanner.Text())
		if line == "" {
			continue
		}
		var msg jsonrpcMessage
		if err := json.Unmarshal([]byte(line), &msg); err != nil {
			return jsonrpcMessage{}, fmt.Errorf("unmarshal response: %w", err)
		}
		return msg, nil
	}
	if err := c.scanner.Err(); err != nil {
		return jsonrpcMessage{}, err
	}
	return jsonrpcMessage{}, fmt.Errorf("connection closed unexpectedly: %w", io.ErrUnexpectedEOF)
}

// wrapErr wraps the error with bounded stderr content if non-empty.
func (c *rpcConn) wrapErr(err error) error {
	if err == nil || c.stderrBuf == nil || c.stderrBuf.Len() == 0 {
		return err
	}
	stderr := strings.TrimSpace(c.stderrBuf.String())
	if stderr == "" {
		return err
	}
	return fmt.Errorf("%s (stderr: %s)", err.Error(), stderr)
}

func (p CodexProvider) Fetch(ctx context.Context) (Quota, error) {
	runRPC := p.RunRPC
	if runRPC == nil {
		runRPC = defaultCodexRunRPC
	}

	proc, err := runRPC(ctx, nil)
	if err != nil {
		if errors.Is(err, exec.ErrNotFound) {
			return Quota{}, fmt.Errorf("%s: %w", p.Name(), errCodexAppServerNotFound)
		}
		return Quota{}, fmt.Errorf("%s: start codex app-server: %w", p.Name(), err)
	}

	conn := &rpcConn{
		cmd:       proc.cmd,
		stdin:     proc.stdin,
		stdout:    proc.stdout,
		stderrBuf: proc.stderrBuf,
	}

	// Ensure cleanup on every terminal path: close stdin, terminate if still
	// running, and call Wait exactly once to reap the child.
	defer func() {
		if conn.stdin != nil {
			conn.stdin.Close()
		}
		if conn.cmd != nil && conn.cmd.Process != nil {
			_ = conn.cmd.Process.Kill()
		}
		if conn.cmd != nil {
			_ = conn.cmd.Wait()
		}
	}()

	// 1. Send initialize request with client info.
	initParams := []byte(`{"clientInfo":{"name":"forge","title":"Forge","version":"0.0.0"}}`)
	_, err = conn.call(ctx, "initialize", json.RawMessage(initParams))
	if err != nil {
		return Quota{}, conn.wrapErr(fmt.Errorf("%s: initialize: %w", p.Name(), err))
	}

	// 2. Send initialized notification (no params — omit the field entirely).
	conn.notify("initialized", nil)

	// 3. Call account/rateLimits/read with null params (no bucket parameter).
	result, err := conn.call(ctx, "account/rateLimits/read", json.RawMessage("null"))
	if err != nil {
		return Quota{}, conn.wrapErr(fmt.Errorf("%s: account/rateLimits/read: %w", p.Name(), err))
	}

	var resp GetAccountRateLimitsResponse
	if err := json.Unmarshal(result, &resp); err != nil {
		return Quota{}, conn.wrapErr(fmt.Errorf("%s: parse rate limits response: %w", p.Name(), err))
	}

	if len(resp.RateLimitsByLimitID) == 0 {
		return Quota{}, conn.wrapErr(fmt.Errorf("%s: rateLimitsByLimitId is empty", p.Name()))
	}

	bucket := bucketForProvider(p.Name())
	entry, ok := resp.RateLimitsByLimitID[bucket]
	if !ok {
		return Quota{}, conn.wrapErr(fmt.Errorf("%s: bucket %q not found in rateLimitsByLimitId", p.Name(), bucket))
	}

	windows := make([]Window, 0, 2)
	if w := convertRateLimitWindow(entry.Primary); w != nil {
		windows = append(windows, *w)
	}
	if w := convertRateLimitWindow(entry.Secondary); w != nil {
		windows = append(windows, *w)
	}
	if len(windows) == 0 {
		return Quota{}, conn.wrapErr(fmt.Errorf("%s: no rate limit windows available", p.Name()))
	}

	now := time.Now()
	q := Quota{
		Provider:  p.Name(),
		Windows:   windows,
		Source:    "codex-app-server",
		FetchedAt: now,
	}
	if entry.PlanType != "" {
		q.Message = "plan: " + entry.PlanType
	}
	return q, nil
}

// convertRateLimitWindow converts a RateLimitWindow from the
// account/rateLimits/read response into a Forge Window.
func convertRateLimitWindow(rlw *RateLimitWindow) *Window {
	if rlw == nil {
		return nil
	}
	if rlw.UsedPercent == nil {
		return nil
	}
	pct := *rlw.UsedPercent
	wm := 300
	if rlw.WindowDuration != nil && *rlw.WindowDuration > 0 {
		wm = int(*rlw.WindowDuration)
	}
	w := Window{
		Name:          windowName(wm),
		Pct:           pct,
		WindowMinutes: wm,
	}
	if rlw.ResetsAt != nil && *rlw.ResetsAt > 0 {
		t := time.Unix(int64(*rlw.ResetsAt), 0)
		w.ResetsAt = &t
	}
	return &w
}
