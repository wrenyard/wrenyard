package driver

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// codexCancelWatchdogGrace is how long a cancelled run lets an in-flight
// turn/interrupt land before the child tree is force-killed.
const codexCancelWatchdogGrace = codexCleanupBoundedTimeout

// codexAppServerRun drives one full app-server turn: start the child, do the
// handshake, start or resume the thread, submit the turn, translate every
// notification into exec-shaped records, and shut the child down cleanly.
func (b *codexAppServerBridge) run(ctx context.Context, home, prompt string, output, errorOutput io.Writer) (int, error) {
	argv := codexAppServerCommandArgs(b.inv)
	stderr := &codexBoundedWriter{limit: codexStderrCaptureLimit}

	starter := b.starter
	if starter == nil {
		starter = defaultCodexAppServerStarter
	}
	proc, err := starter(ctx, home, argv, codexAppServerEnv(b.auth, home), stderr)
	if err != nil {
		return 0, err
	}

	// waitDone carries the single wait result and is then CLOSED, so both
	// waiters observe completion: awaitTurn classifies the exit, and the
	// deferred teardown skips killing a PID that has already been reaped.
	waitDone := make(chan error, 1)
	if proc.cmd != nil {
		go func() {
			waitDone <- proc.cmd.Wait()
			close(waitDone)
		}()
	}

	conn := newCodexAppServerConn(proc.stdin, proc.stdout)

	// The terminal path is teardown. It is guarded by a Once because the
	// cancellation watchdog and the deferred call race, and reaping or
	// killing twice is unsafe.
	var cleanupOnce sync.Once
	cleanup := func() {
		cleanupOnce.Do(func() {
			if proc.stdin != nil {
				_ = proc.stdin.Close()
			}
			conn.close()
			terminateCodexAppServerChild(proc, waitDone)
			if closer, ok := proc.stdout.(io.Closer); ok {
				_ = closer.Close()
			}
		})
	}
	defer cleanup()

	// A cancelled or hung handshake must not stall forever on a blocking
	// conn.call/send. Cancellation first gives an in-flight turn/interrupt a
	// bounded chance to land, then kills the child tree and closes the pipes
	// so any blocked write or read fails instead of hanging. The watchdog is
	// stopped on normal completion, so it never lingers.
	watchdog := make(chan struct{})
	watchdogDone := make(chan struct{})
	go func() {
		defer close(watchdogDone)
		select {
		case <-ctx.Done():
		case <-watchdog:
			return
		}
		select {
		case <-watchdog:
			return
		case <-time.After(codexCancelWatchdogGrace):
		}
		cleanup()
	}()
	defer func() {
		close(watchdog)
		<-watchdogDone
	}()

	b.conn = conn
	b.output = output
	b.runCtx = ctx

	// initialize must complete before initialized, and both before any
	// account/login/start request.
	initParams := map[string]any{
		"clientInfo": map[string]any{
			"name":    codexAppServerClientName,
			"title":   codexAppServerClientTitle,
			"version": codexAppServerClientVer,
		},
		"capabilities": map[string]any{"experimentalApi": true},
	}
	if _, err := conn.call(ctx, "initialize", initParams, b.handleInbound); err != nil {
		return 0, fmt.Errorf("codex app-server: initialize: %w", err)
	}
	if err := conn.notify("initialized", nil); err != nil {
		return 0, fmt.Errorf("codex app-server: initialized: %w", err)
	}
	if err := b.ensureNativeAuth(ctx, conn); err != nil {
		return 0, err
	}
	thread, err := b.startThread(ctx, conn)
	if err != nil {
		return 0, err
	}
	b.emitThreadStarted(thread)
	if err := b.startTurn(ctx, conn, thread, prompt); err != nil {
		return 0, err
	}
	return b.awaitTurn(ctx, conn, thread), nil
}

// handleInbound is the shared inbound dispatcher used while a request is
// outstanding: server requests are answered and notifications are translated
// immediately so no event is lost between polls.
func (b *codexAppServerBridge) handleInbound(msg codexAppServerMessage) error {
	if msg.Method == "" {
		return nil
	}
	if msg.hasID() {
		b.answerServerRequest(b.conn, msg)
		return nil
	}
	b.handleNotification(msg)
	return nil
}

// ensureNativeAuth runs the ChatGPT token handshake before the thread starts.
// Non-native (Gateway) providers skip it entirely. The injected access token is
// taken from the request PARAMS: the response only reports the login type and
// never echoes the credential back.
func (b *codexAppServerBridge) ensureNativeAuth(ctx context.Context, conn *codexAppServerConn) error {
	if !b.auth.Enabled {
		return nil
	}
	params, err := codexExternalAuth(ctx, b.auth.SourceHome, false, b.accessToken)
	if err != nil {
		return fmt.Errorf("codex app-server: ChatGPT auth: %w", err)
	}
	if token, ok := params["accessToken"].(string); ok {
		b.accessToken = strings.TrimSpace(token)
	}
	if _, err := conn.call(ctx, "account/login/start", params, b.handleInbound); err != nil {
		return fmt.Errorf("codex app-server: account/login/start: %w", err)
	}
	return nil
}

// startThread issues thread/start for a fresh run and thread/resume when a
// native thread id was supplied. The response carries the thread id nested in
// result.thread, but the model at the top level of the result: the thread
// object itself has no model field.
func (b *codexAppServerBridge) startThread(ctx context.Context, conn *codexAppServerConn) (codexAppServerThread, error) {
	params := map[string]any{
		"model":                 b.inv.Model,
		"cwd":                   b.workDir(),
		"approvalPolicy":        "never",
		"sandbox":               b.inv.Sandbox,
		"experimentalRawEvents": true,
	}
	method := "thread/start"
	if resume := strings.TrimSpace(b.inv.ResumeID); resume != "" {
		method = "thread/resume"
		params["threadId"] = resume
		// Only a resumed thread is streamed without experimentalRawEvents and
		// therefore reports usage through thread/tokenUsage/updated instead.
		b.threadID = resume
		delete(params, "experimentalRawEvents")
		b.armResumeUsage()
	}
	raw, err := conn.call(ctx, method, params, b.handleInbound)
	if err != nil {
		return codexAppServerThread{}, fmt.Errorf("codex app-server: %s: %w", method, err)
	}
	thread := codexAppServerThread{ThreadID: strings.TrimSpace(b.inv.ResumeID), Model: b.inv.Model}
	if len(raw) > 0 {
		var result struct {
			Model  string `json:"model"`
			Thread struct {
				ID string `json:"id"`
			} `json:"thread"`
		}
		if err := json.Unmarshal(raw, &result); err == nil {
			if result.Thread.ID != "" {
				thread.ThreadID = result.Thread.ID
			}
			if result.Model != "" {
				thread.Model = result.Model
			}
		}
	}
	if thread.ThreadID != "" {
		b.threadID = thread.ThreadID
	}
	if thread.Model != "" {
		b.model = thread.Model
	}
	return thread, nil
}

func (b *codexAppServerBridge) workDir() string {
	if wd, err := os.Getwd(); err == nil {
		return wd
	}
	return ""
}

// emitThreadStarted publishes the exec-compatible thread.started record the
// Codex adapter's session parser already consumes.
func (b *codexAppServerBridge) emitThreadStarted(thread codexAppServerThread) {
	if thread.ThreadID == "" {
		return
	}
	b.writeRecord(map[string]any{"type": "thread.started", "thread_id": thread.ThreadID})
}

// startTurn submits the user prompt as a turn/start request and captures the
// resulting turn id, which turn/interrupt requires.
func (b *codexAppServerBridge) startTurn(ctx context.Context, conn *codexAppServerConn, thread codexAppServerThread, prompt string) error {
	params := map[string]any{
		"threadId": thread.ThreadID,
		"input":    []any{map[string]any{"type": "text", "text": prompt}},
	}
	if effort := strings.TrimSpace(b.inv.ReasoningEffort); effort != "" {
		params["effort"] = effort
	}
	raw, err := conn.call(ctx, "turn/start", params, b.handleInbound)
	if err != nil {
		return fmt.Errorf("codex app-server: turn/start: %w", err)
	}
	if len(raw) > 0 {
		var result struct {
			Turn struct {
				ID string `json:"id"`
			} `json:"turn"`
		}
		if err := json.Unmarshal(raw, &result); err == nil && result.Turn.ID != "" {
			b.turnID = result.Turn.ID
		}
	}
	return nil
}

// awaitTurn consumes the stdout stream until the active turn terminates, the
// context is cancelled, or the stream closes. It never races process exit
// against buffered notifications: the reader closes the channel only after
// every decoded message has been delivered, so nothing queued is dropped.
func (b *codexAppServerBridge) awaitTurn(ctx context.Context, conn *codexAppServerConn, thread codexAppServerThread) int {
	interrupted := false
	for {
		if b.terminal {
			return b.finalize()
		}
		select {
		case <-ctx.Done():
			if !interrupted {
				b.interruptTurn(conn, thread)
				interrupted = true
			}
			b.cancelTurn()
			return b.finalize()
		case msg, ok := <-conn.stream:
			if !ok {
				// The peer is gone and every buffered message was already
				// handled by the client loop, so the transport is truncated
				// unless a terminal notification was seen.
				if !b.terminal {
					b.transportEnded(conn.streamError())
				}
				return b.finalize()
			}
			if err := b.handleInbound(msg); err != nil {
				b.transportEnded(err)
				return b.finalize()
			}
		}
	}
}

// finalize reports the exit code for the run. A terminal turn already wrote its
// own turn.completed/turn.failed record; a partially-completed run reports
// usage without any TPS claim. A truncated stream is always a failure: a run
// never finalizes clean without a successfully completed turn.
func (b *codexAppServerBridge) finalize() int {
	b.writeLastMessage()
	switch {
	case b.turnFailed:
		return 1
	case b.transportFailed:
		if !b.turnCompleted {
			b.emitTurnFailed("codex app-server: transport ended before the turn completed")
		}
		return 1
	case !b.turnCompleted:
		b.emitTurnFailed("codex app-server: turn ended without a completion")
		return 1
	default:
		return 0
	}
}

// writeLastMessage persists the final agent message to the requested file.
// Only agentMessage items are considered: reasoning text never reaches the
// output-last-message contract. A failure to write is reported as a turn
// failure instead of being silently ignored.
func (b *codexAppServerBridge) writeLastMessage() {
	path := strings.TrimSpace(b.inv.OutputLastMessage)
	if path == "" || !b.turnCompleted || b.lastAgentMessage == "" {
		return
	}
	if err := ensureDirectoryFor(path); err != nil {
		b.failLastMessage(err)
		return
	}
	if err := os.WriteFile(path, []byte(b.lastAgentMessage), 0o600); err != nil {
		b.failLastMessage(err)
	}
}

// failLastMessage reports an unwritable output-last-message as a failure so the
// run exits nonzero rather than claiming a success it did not record.
func (b *codexAppServerBridge) failLastMessage(err error) {
	b.emitTurnFailed(fmt.Sprintf("codex app-server: write output-last-message: %v", err))
	b.turnFailed = true
	b.terminal = true
}

// interruptTurn sends turn/interrupt and performs bounded cleanup. Both the
// thread and the turn id are mandatory for the request. A slow or failed
// interrupt never blocks the run: the deferred child teardown always kills the
// process group or tree.
func (b *codexAppServerBridge) interruptTurn(conn *codexAppServerConn, thread codexAppServerThread) {
	ctx, cancel := context.WithTimeout(context.Background(), codexCleanupBoundedTimeout)
	defer cancel()
	params := map[string]any{}
	if threadID := firstNonEmpty(b.threadID, thread.ThreadID); threadID != "" {
		params["threadId"] = threadID
	}
	if turnID := strings.TrimSpace(b.turnID); turnID != "" {
		params["turnId"] = turnID
	}
	if len(params) < 2 {
		// Without both identities the request would be rejected; the bounded
		// child teardown still ends the run.
		return
	}
	_, _ = conn.call(ctx, "turn/interrupt", params, nil)
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			return trimmed
		}
	}
	return ""
}

// terminateCodexAppServerChild closes the peer and reaps the child within a
// bounded window, escalating to a process-group or process-tree kill. A reaped
// leader is NOT sufficient to return: descendants can survive their parent, so
// the kill path runs whenever the process group (or tree) is still alive. When
// the group has already vanished this returns promptly, so a normally completed
// call pays no extra latency.
func terminateCodexAppServerChild(proc codexAppServerProcess, waitDone <-chan error) {
	if proc.cmd == nil || proc.cmd.Process == nil {
		return
	}
	if codexChildTreeExited(proc, waitDone) {
		return
	}
	select {
	case <-waitDone:
	case <-time.After(codexCleanupBoundedTimeout):
	}
	if codexChildTreeExited(proc, waitDone) {
		return
	}
	killCodexChildTree(proc, waitDone)
}

// codexChildTreeExited reports whether the child's whole process tree is
// already gone. On Unix this probes the process group, which is the only
// reliable signal: the group leader's Wait completing says nothing about
// surviving grandchildren. The platform helper lives next to the kill logic so
// Windows keeps its PID-reuse-safe semantics.
func codexChildTreeExited(proc codexAppServerProcess, waitDone <-chan error) bool {
	if proc.cmd == nil || proc.cmd.Process == nil {
		return true
	}
	return codexChildTreeGone(proc.cmd.Process.Pid, waitDone)
}

// answerServerRequest auto-accepts every known approval request under the
// unattended YOLO policy, serves the auth refresh endpoint, and replies
// method-not-found to anything unrecognised so the peer never blocks.
func (b *codexAppServerBridge) answerServerRequest(conn *codexAppServerConn, msg codexAppServerMessage) {
	switch {
	case codexApprovalMethod(msg.Method):
		_ = conn.respond(msg.ID, map[string]any{"decision": "accept"})
	case codexAuthRefreshMethod(msg.Method):
		if !b.auth.Enabled {
			_ = conn.respondMethodNotFound(msg.ID, msg.Method)
			return
		}
		// The refresh shares the run's context, so a cancelled or expired task
		// cancels the refresh instead of outliving it.
		credentials, err := codexExternalAuth(b.runCtx, b.auth.SourceHome, true, b.accessTokenOr(msg.Params))
		if err != nil {
			_ = conn.respondMethodNotFound(msg.ID, msg.Method)
			return
		}
		_ = conn.respond(msg.ID, codexAuthRefreshPayload(credentials, b))
	default:
		_ = conn.respondMethodNotFound(msg.ID, msg.Method)
	}
}

// accessTokenOr falls back to the request's own access token so a refresh can
// present the credential the server already knows about.
func (b *codexAppServerBridge) accessTokenOr(params json.RawMessage) string {
	if b.accessToken != "" {
		return b.accessToken
	}
	if len(params) == 0 {
		return ""
	}
	var decoded map[string]any
	if err := json.Unmarshal(params, &decoded); err != nil {
		return ""
	}
	if token, ok := decoded["accessToken"].(string); ok {
		return strings.TrimSpace(token)
	}
	return ""
}

// codexAuthRefreshPayload returns only the fields a refresh response carries
// back: the access token, the ChatGPT account id, and the optional plan. The
// plan field is named chatgptPlanType in the refresh response.
func codexAuthRefreshPayload(credentials map[string]any, b *codexAppServerBridge) map[string]any {
	payload := map[string]any{}
	if token, ok := credentials["accessToken"]; ok {
		payload["accessToken"] = token
		if text, isText := token.(string); isText {
			b.accessToken = strings.TrimSpace(text)
		}
	}
	if account, ok := credentials["chatgptAccountId"]; ok {
		payload["chatgptAccountId"] = account
	}
	if plan, ok := credentials["chatgptPlanType"]; ok {
		payload["chatgptPlanType"] = plan
	}
	return payload
}

// codexApprovalMethods are the interactive approval requests this transport
// accepts on behalf of the unattended run.
var codexApprovalMethods = map[string]bool{
	"execCommandApproval":                   true,
	"applyPatchApproval":                    true,
	"item/commandExecution/requestApproval": true,
	"item/fileChange/requestApproval":       true,
}

func codexApprovalMethod(method string) bool { return codexApprovalMethods[method] }

func codexAuthRefreshMethod(method string) bool {
	return method == "account/chatgptAuthTokens/refresh"
}

// codexBoundedWriter captures a capped prefix of the child's stderr. Raw auth
// payloads are never forwarded: only a bounded prefix is retained for transport
// diagnostics, and it is never echoed into the transcript.
type codexBoundedWriter struct {
	limit   int
	written int
	buf     bytes.Buffer
}

func (w *codexBoundedWriter) Write(p []byte) (int, error) {
	remaining := w.limit - w.written
	if remaining > 0 {
		chunk := p
		if len(chunk) > remaining {
			chunk = chunk[:remaining]
		}
		w.buf.Write(chunk)
		w.written += len(chunk)
	}
	// Always report a full write so the child is never blocked on stderr.
	return len(p), nil
}

// writeRecord marshals one internal record and appends it as a JSONL line.
func (b *codexAppServerBridge) writeRecord(record map[string]any) {
	if b.output == nil || record == nil {
		return
	}
	body, err := json.Marshal(record)
	if err != nil {
		return
	}
	_, _ = b.output.Write(append(body, '\n'))
}

// codexStringField returns the first non-empty string among keys.
func codexStringField(source map[string]any, keys ...string) string {
	for _, key := range keys {
		if value, ok := source[key].(string); ok && strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

// codexThreadIdentity pulls the thread identity from a notification that may
// carry it flat, under params, or nested in params.thread.
func codexThreadIdentity(params map[string]any) string {
	if id := codexStringField(params, "threadId", "thread_id"); id != "" {
		return id
	}
	if thread, ok := params["thread"].(map[string]any); ok {
		return codexStringField(thread, "id", "threadId")
	}
	return ""
}

func codexTurnIdentity(params map[string]any) string {
	return codexStringField(params, "turnId", "turn_id")
}

// ensureDirectoryFor creates the parent directory of path when needed.
func ensureDirectoryFor(path string) error {
	dir := filepath.Dir(path)
	if dir == "" || dir == "." {
		return nil
	}
	return os.MkdirAll(dir, 0o700)
}
