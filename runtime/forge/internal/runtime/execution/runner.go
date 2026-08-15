package execution

import (
	"context"
	"io"
	"os"
	"strings"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/driver"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/protocol"
)

// AttemptRequest is the fakeable child-runner boundary. Plan already contains
// the exact same profile, prompt stdin, permissions, and client arguments that
// production would execute; retry metadata is observable for offline tests.
type AttemptRequest struct {
	Plan         driver.CommandPlan
	Profile      string
	Prompt       string
	ResumeID     string
	ClientFamily string
	Attempt      int
	Retry        int
	Mode         string
	Context      context.Context

	sink   *eventSink
	stderr io.Writer
}

// ChildResult contains normalized output from one child attempt. Events are
// the only classifier input; Error is retained only for the final compatible
// result/error presentation and is never persisted in circuit state.
type ChildResult struct {
	Status          string
	ExitCode        int
	NativeSessionID string
	GrokStream      driver.GrokStreamValidity
	Summary         string
	Usage           protocol.Usage
	Error           string
	ProcessError    bool
	Events          []protocol.Event
	EventsEmitted   bool
	ClientFamily    string
}

type ChildRunner func(context.Context, AttemptRequest) ChildResult

func defaultChildRunner(ctx context.Context, request AttemptRequest) ChildResult {
	if err := ctx.Err(); err != nil {
		return ChildResult{Status: "failed", ExitCode: 1, Error: err.Error(), ProcessError: true}
	}
	logFile, err := os.CreateTemp("", "forge-direct-*.jsonl")
	if err != nil {
		return ChildResult{Status: "failed", ExitCode: 1, Error: err.Error(), ProcessError: true}
	}
	logPath := logFile.Name()
	defer os.Remove(logPath)
	defer logFile.Close()

	stderr := request.stderr
	if stderr == nil {
		stderr = io.Discard
	}
	status, exitCode, nativeSessionID, grokStream, procErr := runProcess(ctx, request.Plan, request.ClientFamily, request.sink, logPath, logFile, stderr)
	if request.ClientFamily != "grok" && request.sink != nil && status == "done" && exitCode == 0 && procErr == nil {
		if nativeFailure := finalNormalizedFailure(request.sink.attemptSnapshot()); nativeFailure != "" {
			status = "failed"
			exitCode = 1
		}
	}
	result := ChildResult{
		Status:          status,
		ExitCode:        exitCode,
		NativeSessionID: strings.TrimSpace(nativeSessionID),
		GrokStream:      grokStream,
		ClientFamily:    request.ClientFamily,
	}
	if procErr != nil {
		result.Error = procErr.Error()
		result.ProcessError = true
	}
	if parser := driver.ParserForDialect(request.Plan.Dialect); parser != nil {
		if summary, parseErr := parser.ParseResult(logPath); parseErr == nil {
			result.Summary = strings.TrimSpace(summary)
		}
	}
	if request.sink != nil {
		result.Events = request.sink.attemptSnapshot()
		result.EventsEmitted = true
		snapshot := request.sink.resultSnapshot()
		if result.Summary == "" {
			result.Summary = snapshot.Summary
		}
		if snapshot.Usage != nil {
			result.Usage = snapshot.Usage
		}
	}
	if request.ClientFamily == "grok" {
		if normalized := normalizedFailureMessage(result.Events); normalized != "" {
			result.Error = normalized
		}
	}
	result, _ = enforceChildError(result)
	return result
}

// enforceChildError is the generic child/process invariant. An error reported
// alongside a nominal done/zero result is still a failed attempt, and an
// existing native nonzero code or more specific diagnostic is preserved.
func enforceChildError(child ChildResult) (ChildResult, bool) {
	if strings.TrimSpace(child.Error) == "" {
		return child, false
	}
	child.Status = "failed"
	if child.ExitCode == 0 {
		child.ExitCode = 1
	}
	return child, true
}

func finalNormalizedFailure(events []protocol.Event) string {
	for i := len(events) - 1; i >= 0; i-- {
		if events[i].Type != protocol.EventRunFinished || events[i].Data == nil {
			continue
		}
		if status, _ := events[i].Data["status"].(string); strings.EqualFold(strings.TrimSpace(status), "done") {
			return ""
		}
		return strings.TrimSpace(normalizedText(events[i].Data["error"]))
	}
	return ""
}
