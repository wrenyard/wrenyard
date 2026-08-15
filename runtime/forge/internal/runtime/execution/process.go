package execution

import (
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"syscall"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/driver"
)

// cancelSignalNotify installs SIGINT/SIGTERM notification for the Forge process
// so the synchronous direct runtime can own cancellation of the worker it
// started. It is a package-level variable so unit tests can deterministically
// trigger cancellation without real OS signals.
var cancelSignalNotify = func(ch chan<- os.Signal) {
	signal.Notify(ch, syscall.SIGINT, syscall.SIGTERM)
}

// cancelSignalStop removes the notification installed by cancelSignalNotify.
var cancelSignalStop = func(ch chan<- os.Signal) {
	signal.Stop(ch)
}

// runProcess launches the planned command, tees its stdout transcript into the
// JSONL log, passthroughs stderr to the given writer, preserves the child exit
// code, and parses the transcript for the native session id. It returns the
// final (status, exitCode, err) and the parsed native session id. There is no
// Forge session state created.
//
// The synchronous direct runtime owns worker cancellation: after starting the
// worker it watches SIGINT/SIGTERM sent to the Forge process. On signal it
// synchronously terminates the worker process tree (platform specific) and
// waits for the worker to fully exit before returning a "cancelled" result.
// A platform termination failure is bounded and returned as an actionable
// process error so abnormal resources are retained.
func runProcess(ctx context.Context, plan driver.CommandPlan, clientFamily string, sink *eventSink, logPath string, logFile *os.File, stderr io.Writer) (status string, exitCode int, nativeSessionID string, grokStream driver.GrokStreamValidity, err error) {
	cmd := exec.Command(plan.Command[0], plan.Command[1:]...)
	cmd.Dir = plan.WorkDir
	cmd.Stdin = plan.Stdin
	cmd.Env = driver.BuildChildEnvForPermission(plan.Env, plan.Permission)
	family := plan.TranscriptFamily
	if family == "" {
		family = clientFamily
	}
	transcript := driver.NewTranscriptTeeWithEventHandler(family, logFile, sink.handleNormalizedEvent)
	cmd.Stdout = transcript
	cmd.Stderr = stderr
	hideCommandWindow(cmd)
	defer func() {
		transcript.FinalizeOpenCodeStream()
		grokStream = transcript.FinalizeGrokStream()
	}()

	if startErr := cmd.Start(); startErr != nil {
		if closeErr := logFile.Close(); closeErr != nil && err == nil {
			err = closeErr
		}
		return "failed", 1, "", driver.GrokStreamValidity{}, startErr
	}

	sigCh := make(chan os.Signal, 1)
	cancelSignalNotify(sigCh)
	defer cancelSignalStop(sigCh)
	// Close the log only after the worker has finished and we have read its
	// transcript, including on the cancellation path.
	defer func() {
		if closeErr := logFile.Close(); closeErr != nil && err == nil {
			err = closeErr
		}
	}()

	waitDone := make(chan error, 1)
	go func() { waitDone <- cmd.Wait() }()

	select {
	case waitErr := <-waitDone:
		// Worker exited on its own (success or failure).
		err = waitErr
	case <-sigCh:
		// The Forge process received a cancellation signal. Terminate the
		// worker tree synchronously and wait for it to exit before returning.
		terminationErr := terminateWorkerTree(cmd, waitDone)
		status = "cancelled"
		err = terminationErr
		if terminationErr != nil {
			status = "failed"
			exitCode = 1
		}
		return status, exitCode, nativeSessionID, grokStream, err
	case <-ctx.Done():
		terminationErr := terminateWorkerTreeNow(cmd, waitDone)
		status = "cancelled"
		exitCode = 1
		err = terminationErr
		if terminationErr != nil {
			status = "failed"
		}
		return status, exitCode, nativeSessionID, grokStream, err
	}

	exitCode = 0
	status = "done"
	if err != nil {
		status = "failed"
		exitCode = 1
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			exitCode = exitErr.ExitCode()
		}
	}

	if parser := driver.ParserForDialect(plan.Dialect); parser != nil {
		if nativeID, parseErr := parser.ParseSessionID(logPath); parseErr == nil {
			nativeSessionID = trimSpace(nativeID)
		}
	}

	return status, exitCode, nativeSessionID, grokStream, err
}

func trimSpace(s string) string {
	return string(stripSpace([]byte(s)))
}

func stripSpace(b []byte) []byte {
	start := 0
	for start < len(b) && (b[start] == ' ' || b[start] == '\t' || b[start] == '\n' || b[start] == '\r') {
		start++
	}
	end := len(b)
	for end > start && (b[end-1] == ' ' || b[end-1] == '\t' || b[end-1] == '\n' || b[end-1] == '\r') {
		end--
	}
	return b[start:end]
}
