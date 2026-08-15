package execution

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/driver"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/protocol"
)

// installImmediateCancel overrides the cancellation signal mechanism with a
// deterministic trigger that fires as soon as runProcess installs it. This lets
// the cancellation path be exercised without real OS signals and without
// disturbing the test process's real signal disposition. It returns a function
// that restores the original behavior.
func installImmediateCancel() func() {
	prevNotify := cancelSignalNotify
	prevStop := cancelSignalStop
	cancelSignalNotify = func(ch chan<- os.Signal) {
		// Simulate the Forge process receiving SIGINT immediately after the
		// worker has been started.
		ch <- os.Interrupt
	}
	cancelSignalStop = func(ch chan<- os.Signal) {}
	return func() {
		cancelSignalNotify = prevNotify
		cancelSignalStop = prevStop
	}
}

// normalChildCmd returns a child command that prints a line and exits 0,
// portable across the build platforms.
func normalChildCmd() []string {
	if runtime.GOOS == "windows" {
		return []string{"cmd", "/C", "echo hello"}
	}
	return []string{"sh", "-c", "echo hello"}
}

// failingChildCmd returns a child command that exits with a non-zero code,
// portable across the build platforms.
func failingChildCmd() []string {
	if runtime.GOOS == "windows" {
		return []string{"cmd", "/C", "exit 3"}
	}
	return []string{"sh", "-c", "exit 3"}
}

// longRunningChildCmd returns a child command that runs for a long time, so the
// cancellation path must actively terminate it. It is killed well before its
// natural end by terminateWorkerTree.
func longRunningChildCmd() []string {
	if runtime.GOOS == "windows" {
		return []string{"timeout", "/T", "120"}
	}
	return []string{"sleep", "120"}
}

func runProcessHelper(t *testing.T, command []string) (status string, exitCode int, nativeID string, grokStream driver.GrokStreamValidity, procErr error) {
	t.Helper()
	logFile, err := os.CreateTemp("", "forge-exec-test-*.jsonl")
	if err != nil {
		t.Fatalf("create temp log: %v", err)
	}
	logPath := logFile.Name()
	t.Cleanup(func() { os.Remove(logPath) })

	sink := newEventSink(io.Discard, protocol.OutputFormatJSON, Result{})
	plan := driver.CommandPlan{Command: command}
	return runProcess(context.Background(), plan, "", sink, logPath, logFile, io.Discard)
}

func TestRunProcessNormalCompletion(t *testing.T) {
	status, exitCode, _, _, procErr := runProcessHelper(t, normalChildCmd())
	if procErr != nil {
		t.Fatalf("unexpected error: %v", procErr)
	}
	if status != "done" {
		t.Fatalf("expected status done, got %q", status)
	}
	if exitCode != 0 {
		t.Fatalf("expected exit code 0, got %d", exitCode)
	}
}

func TestRunProcessWorkerFailure(t *testing.T) {
	status, exitCode, _, _, procErr := runProcessHelper(t, failingChildCmd())
	if procErr == nil {
		t.Fatalf("expected non-nil error for failing worker")
	}
	if status != "failed" {
		t.Fatalf("expected status failed, got %q", status)
	}
	if exitCode != 3 {
		t.Fatalf("expected exit code 3, got %d", exitCode)
	}
}

func TestEnforceChildErrorRejectsNominalSuccessAndPreservesSpecificFailure(t *testing.T) {
	nominal, failed := enforceChildError(ChildResult{
		Status: "done", ExitCode: 0, Error: "close execution transcript: device failure",
	})
	if !failed || nominal.Status != "failed" || nominal.ExitCode != 1 || nominal.Error != "close execution transcript: device failure" {
		t.Fatalf("nominal success plus child error = %+v failed=%v", nominal, failed)
	}
	native, failed := enforceChildError(ChildResult{
		Status: "failed", ExitCode: 7, Error: "specific native diagnostic",
	})
	if !failed || native.Status != "failed" || native.ExitCode != 7 || native.Error != "specific native diagnostic" {
		t.Fatalf("native failure was masked = %+v failed=%v", native, failed)
	}
}

func TestRunProcessCancellation(t *testing.T) {
	restore := installImmediateCancel()
	defer restore()

	start := time.Now()
	status, exitCode, _, _, procErr := runProcessHelper(t, longRunningChildCmd())
	elapsed := time.Since(start)

	if procErr != nil {
		t.Fatalf("expected nil error on cancellation, got %v", procErr)
	}
	if status != "cancelled" {
		t.Fatalf("expected status cancelled, got %q", status)
	}
	if exitCode != 0 {
		t.Fatalf("expected cancelled exit code 0, got %d", exitCode)
	}
	// The worker was configured to run for ~120s. Cancellation must terminate
	// the worker and wait for it to exit, so runProcess must return far sooner
	// than the worker's natural lifetime. This proves the call does not return
	// until the worker has fully exited.
	if elapsed > 30*time.Second {
		t.Fatalf("cancellation returned too late (elapsed %s); worker was not terminated promptly", elapsed)
	}
}

// TestRunProcessCodeBuddyTranscriptFamilyUsesCodeBuddyCodec is the
// production-boundary proof that a CodeBuddy plan's runner-only
// TranscriptFamily routes child stdout through the codebuddy codec (summing
// the current invocation's assistant.message.usage into the canonical
// agent_turn_v1 turn_usage instead of the terminal cumulative result.usage)
// while the public ClientFamily reported in the ChildResult stays claude.
func TestRunProcessCodeBuddyTranscriptFamilyUsesCodeBuddyCodec(t *testing.T) {
	transcript := strings.Join([]string{
		`{"type":"assistant","message":{"content":[{"type":"text","text":"ready"}],"usage":{"input_tokens":1200,"output_tokens":1456}}}`,
		`{"type":"result","is_error":false,"duration_ms":23456,"usage":{"input_tokens":15000,"output_tokens":59043}}`,
		"",
	}, "\n")
	path := filepath.Join(t.TempDir(), "codebuddy.jsonl")
	if err := os.WriteFile(path, []byte(transcript), 0o600); err != nil {
		t.Fatal(err)
	}
	var command []string
	if runtime.GOOS == "windows" {
		command = []string{"cmd.exe", "/d", "/s", "/c", "type", path}
	} else {
		command = []string{"cat", path}
	}

	sink := newEventSink(io.Discard, protocol.OutputFormatJSON, Result{})
	result := defaultChildRunner(context.Background(), AttemptRequest{
		Plan:         driver.CommandPlan{Command: command, TranscriptFamily: "codebuddy"},
		ClientFamily: "claude",
		sink:         sink,
		stderr:       io.Discard,
	})
	if result.Status != "done" || result.ExitCode != 0 {
		t.Fatalf("child result = %+v, want done/0", result)
	}
	if result.ClientFamily != "claude" {
		t.Fatalf("public ClientFamily = %q, want claude", result.ClientFamily)
	}
	var usage map[string]any
	count := 0
	for _, event := range result.Events {
		if event.Type != "turn_usage" {
			continue
		}
		count++
		usage = event.Data
	}
	if count != 1 {
		t.Fatalf("turn_usage count = %d, want 1; events=%#v", count, result.Events)
	}
	want := map[string]any{
		"input_tokens":   1200,
		"output_tokens":  1456,
		"duration_ms":    23456,
		"token_scope":    "agent_turn",
		"duration_scope": "agent_turn",
		"tps_contract":   "agent_turn_v1",
	}
	if !reflect.DeepEqual(usage, want) {
		t.Fatalf("turn_usage mismatch\nwant: %#v\n got: %#v", want, usage)
	}
}
