//go:build !windows

package execution

import (
	"bytes"
	"context"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/catalog"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/driver"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/protocol"
)

func resourcePlan(t *testing.T, exitCommand string) (driver.CommandPlan, string) {
	t.Helper()
	root := t.TempDir()
	home := filepath.Join(root, "agent-grok", "run-test")
	if err := os.MkdirAll(home, 0o700); err != nil {
		t.Fatal(err)
	}
	return driver.CommandPlan{
		Dialect: catalog.DialectGrok,
		Command: []string{"sh", "-c", exitCommand},
		WorkDir: root,
		Resources: []driver.ExecutionResource{{
			Path: home, OwnershipRoot: filepath.Dir(home), RemoveOnSuccess: true,
		}},
	}, home
}

func runResourcePlan(ctx context.Context, plan driver.CommandPlan) ChildResult {
	sink := newEventSink(io.Discard, protocol.OutputFormatText, Result{Status: "running"})
	return defaultChildRunner(ctx, AttemptRequest{Plan: plan, ClientFamily: "grok", sink: sink, stderr: io.Discard})
}

func otherGrokStreamCommand(streamCase string) []string {
	scripts := map[string]string{
		"empty":                    `exit 0`,
		"malformed":                `printf '%s\n' 'not-json'`,
		"truncated":                `printf '%s' '{"type":"end","stopReason":"EndTurn"'`,
		"incomplete":               `printf '%s\n' '{"type":"end"}'`,
		"duplicate":                `printf '%s\n' '{"type":"end","stopReason":"EndTurn"}' '{"type":"end","stopReason":"EndTurn"}'`,
		"non-final-after-terminal": `printf '%s\n' '{"type":"end","stopReason":"EndTurn"}' '{"type":"thought","data":"late"}'`,
		"failed":                   `printf '%s\n' '{"type":"error","message":"native failure"}'`,
		"cancelled":                `printf '%s\n' '{"type":"end","stopReason":"Cancelled"}'`,
		"valid":                    `printf '%s\n' '{"type":"text","data":"ok"}' '{"type":"end","stopReason":"EndTurn"}'`,
		"native-nonzero":           `printf '%s\n' '{"type":"error","message":"native failure"}'; exit 7`,
	}
	return []string{"sh", "-c", scripts[streamCase]}
}

func TestResourceLifecycleGrokNativeStreamMatrix(t *testing.T) {
	for _, streamCase := range []string{"empty", "malformed", "truncated", "incomplete", "duplicate", "non-final-after-terminal", "failed", "cancelled", "valid", "native-nonzero"} {
		t.Run(streamCase, func(t *testing.T) {
			plan, home := resourcePlan(t, "exit 0")
			plan.Command = otherGrokStreamCommand(streamCase)
			result := runResourcePlan(context.Background(), plan)
			result, _ = enforceGrokNativeStreamResult("grok", result)

			switch streamCase {
			case "valid":
				if result.Status != "done" || result.ExitCode != 0 || result.Error != "" || !result.GrokStream.IsValid() {
					t.Fatalf("valid result = %+v", result)
				}
				if err := cleanupSuccessfulResources(plan.Resources); err != nil {
					t.Fatal(err)
				}
				if _, err := os.Stat(home); !os.IsNotExist(err) {
					t.Fatalf("valid success retained run Home: %v", err)
				}
			case "failed":
				if result.Status != "failed" || result.ExitCode != 1 || result.Error != "native failure" {
					t.Fatalf("native diagnostic result = %+v", result)
				}
				if _, err := os.Stat(home); err != nil {
					t.Fatalf("native diagnostic removed run Home: %v", err)
				}
			case "cancelled":
				if result.Status != "failed" || result.ExitCode != 1 || result.Error != "Cancelled" {
					t.Fatalf("native cancellation result = %+v", result)
				}
				if _, err := os.Stat(home); err != nil {
					t.Fatalf("native cancellation removed run Home: %v", err)
				}
			case "native-nonzero":
				if result.Status != "failed" || result.ExitCode != 7 || result.Error != "native failure" {
					t.Fatalf("native nonzero result = %+v", result)
				}
				if _, err := os.Stat(home); err != nil {
					t.Fatalf("native nonzero removed run Home: %v", err)
				}
			default:
				if result.Status != "failed" || result.ExitCode != 1 || result.Error != invalidGrokNativeOutputError || result.GrokStream.IsValid() {
					t.Fatalf("invalid result = %+v", result)
				}
				if _, err := os.Stat(home); err != nil {
					t.Fatalf("invalid stream removed run Home: %v", err)
				}
			}
		})
	}
}

func TestResourceLifecycleStartAndNonzeroRetainRunHome(t *testing.T) {
	plan, home := resourcePlan(t, "exit 7")
	result := runResourcePlan(context.Background(), plan)
	if result.Status != "failed" || result.ExitCode != 7 {
		t.Fatalf("nonzero result = %+v", result)
	}
	if _, err := os.Stat(home); err != nil {
		t.Fatalf("nonzero run home was removed: %v", err)
	}

	plan, startHome := resourcePlan(t, "exit 0")
	plan.Command[0] = filepath.Join(t.TempDir(), "missing-child")
	result = runResourcePlan(context.Background(), plan)
	if result.Status != "failed" {
		t.Fatalf("start failure result = %+v", result)
	}
	if _, err := os.Stat(startHome); err != nil {
		t.Fatalf("start-failure run home was removed: %v", err)
	}
}

func TestResourceLifecycleCancellationRetainsRunHome(t *testing.T) {
	plan, home := resourcePlan(t, "sleep 30")
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan ChildResult, 1)
	go func() { done <- runResourcePlan(ctx, plan) }()
	time.Sleep(100 * time.Millisecond)
	cancel()
	select {
	case result := <-done:
		if result.Status != "cancelled" {
			t.Fatalf("cancel result = %+v", result)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("cancelled child did not terminate")
	}
	if _, err := os.Stat(home); err != nil {
		t.Fatalf("cancelled run home was removed: %v", err)
	}
}

func TestCancellationWithDetachedDescriptorHolderIsBoundedAndRetainsRunHome(t *testing.T) {
	if _, err := exec.LookPath("setsid"); err != nil {
		t.Skip("setsid is required for the detached process-group regression")
	}
	oldGraceful := nonWindowsGracefulWaitTimeout
	oldForced := nonWindowsForcedWaitTimeout
	nonWindowsGracefulWaitTimeout = 150 * time.Millisecond
	nonWindowsForcedWaitTimeout = 150 * time.Millisecond
	defer func() {
		nonWindowsGracefulWaitTimeout = oldGraceful
		nonWindowsForcedWaitTimeout = oldForced
	}()

	for _, branch := range []string{"initial-context-cancellation", "graceful-timeout-forced-kill"} {
		t.Run(branch, func(t *testing.T) {
			pidFile := filepath.Join(t.TempDir(), "detached.pid")
			plan, home := resourcePlan(t, `setsid sh -c 'sleep 30' & echo $! > "$PID_FILE"; wait`)
			plan.Env = map[string]string{"PID_FILE": pidFile}

			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			if branch == "graceful-timeout-forced-kill" {
				oldNotify := cancelSignalNotify
				oldStop := cancelSignalStop
				cancelSignalNotify = func(ch chan<- os.Signal) {
					go func() {
						if waitForPath(pidFile, 3*time.Second) {
							ch <- os.Interrupt
						}
					}()
				}
				cancelSignalStop = func(chan<- os.Signal) {}
				defer func() {
					cancelSignalNotify = oldNotify
					cancelSignalStop = oldStop
				}()
			}

			started := time.Now()
			done := make(chan ChildResult, 1)
			go func() { done <- runResourcePlan(ctx, plan) }()
			if !waitForPath(pidFile, 3*time.Second) {
				t.Fatal("detached descriptor holder did not start")
			}
			pid := readPID(t, pidFile)
			t.Cleanup(func() { _ = syscall.Kill(-pid, syscall.SIGKILL) })
			if branch == "initial-context-cancellation" {
				cancel()
			}

			select {
			case result := <-done:
				boundedFailure := result.Status == "failed" && result.ExitCode == 1 && strings.Contains(result.Error, "not reaped within")
				if result.Status != "cancelled" && !boundedFailure {
					t.Fatalf("bounded detached cancellation result = %+v", result)
				}
			case <-time.After(2 * time.Second):
				t.Fatal("cancellation remained blocked after the forced-kill reap bound")
			}
			if elapsed := time.Since(started); elapsed > 2*time.Second {
				t.Fatalf("bounded detached cancellation took %s", elapsed)
			}
			if _, err := os.Stat(home); err != nil {
				t.Fatalf("abnormal cancellation removed run Home: %v", err)
			}
		})
	}
}

func TestExecuteDetachedDescriptorCancellationReturnsBoundedFailureAndPreservesResources(t *testing.T) {
	if _, err := exec.LookPath("setsid"); err != nil {
		t.Skip("setsid is required for the detached process-group regression")
	}
	oldGraceful := nonWindowsGracefulWaitTimeout
	oldForced := nonWindowsForcedWaitTimeout
	nonWindowsGracefulWaitTimeout = 150 * time.Millisecond
	nonWindowsForcedWaitTimeout = 150 * time.Millisecond
	defer func() {
		nonWindowsGracefulWaitTimeout = oldGraceful
		nonWindowsForcedWaitTimeout = oldForced
	}()

	for _, branch := range []string{"initial-context-cancellation", "graceful-timeout-forced-kill"} {
		t.Run(branch, func(t *testing.T) {
			binDir := t.TempDir()
			if err := os.WriteFile(filepath.Join(binDir, "go"), []byte("#!/bin/sh\nexit 0\n"), 0o700); err != nil {
				t.Fatal(err)
			}
			t.Setenv("PATH", binDir+string(os.PathListSeparator)+os.Getenv("PATH"))
			pidFile := filepath.Join(t.TempDir(), "detached.pid")
			deps, homes := grokResilienceDeps(t, func(ctx context.Context, request AttemptRequest) ChildResult {
				request.Plan.Command = []string{"sh", "-c", `setsid sh -c 'sleep 30' & echo $! > "$PID_FILE"; wait`}
				if request.Plan.Env == nil {
					request.Plan.Env = map[string]string{}
				}
				request.Plan.Env["PID_FILE"] = pidFile
				return defaultChildRunner(ctx, request)
			})
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			if branch == "graceful-timeout-forced-kill" {
				oldNotify := cancelSignalNotify
				oldStop := cancelSignalStop
				cancelSignalNotify = func(ch chan<- os.Signal) {
					go func() {
						if waitForPath(pidFile, 3*time.Second) {
							ch <- os.Interrupt
						}
					}()
				}
				cancelSignalStop = func(chan<- os.Signal) {}
				defer func() {
					cancelSignalNotify = oldNotify
					cancelSignalStop = oldStop
				}()
			}

			started := time.Now()
			workDir := t.TempDir()
			type executeResult struct {
				result Result
				err    error
			}
			done := make(chan executeResult, 1)
			go func() {
				result, err := Execute(Request{
					ProfileName: "grok-cancel", Prompt: "cancel detached worker", WorkDir: workDir,
					Permission: catalog.PermissionReadonly, Format: protocol.OutputFormatJSON, Context: ctx,
				}, deps, &bytes.Buffer{}, &bytes.Buffer{})
				done <- executeResult{result: result, err: err}
			}()
			if !waitForPath(pidFile, 3*time.Second) {
				t.Fatal("Execute did not start its detached descriptor holder")
			}
			pid := readPID(t, pidFile)
			t.Cleanup(func() { _ = syscall.Kill(-pid, syscall.SIGKILL) })
			if branch == "initial-context-cancellation" {
				cancel()
			}

			select {
			case outcome := <-done:
				// Go/OS pipe reaping differs once the detached descriptor holder
				// outlives the direct worker: some hosts hit the explicit forced-reap
				// bound, while others reap the direct worker promptly and Execute
				// projects the clean cancellation through its generic terminal error.
				// Both are bounded non-success outcomes; the lower-level test above
				// separately proves the actionable forced-reap diagnostic.
				boundedFailure := strings.Contains(outcome.result.Error, "not reaped within")
				cleanCancellation := outcome.result.Error == "runtime attempt failed"
				if outcome.err == nil || outcome.result.Status != "failed" || outcome.result.ExitCode != 1 || (!boundedFailure && !cleanCancellation) {
					t.Fatalf("Execute bounded cancellation result=%+v err=%v", outcome.result, outcome.err)
				}
			case <-time.After(2 * time.Second):
				t.Fatal("Execute remained blocked after the forced-kill reap bound")
			}
			if elapsed := time.Since(started); elapsed > 2*time.Second {
				t.Fatalf("Execute bounded cancellation took %s", elapsed)
			}
			if len(*homes) != 1 {
				t.Fatalf("Execute attempt homes = %v", *homes)
			}
			if _, err := os.Stat((*homes)[0]); err != nil {
				t.Fatalf("Execute false-success cleanup removed abnormal run Home: %v", err)
			}
		})
	}
}

func waitForPath(path string, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(path); err == nil {
			return true
		}
		time.Sleep(10 * time.Millisecond)
	}
	return false
}

func readPID(t *testing.T, path string) int {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(data)))
	if err != nil || pid <= 0 {
		t.Fatalf("invalid detached pid %q: %v", data, err)
	}
	return pid
}
