package execution

import (
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
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
		Command: []string{"cmd.exe", "/d", "/s", "/c", exitCommand},
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

func windowsGrokStreamCommand(streamCase string) []string {
	scripts := map[string]string{
		"empty":                    `exit 0`,
		"malformed":                `[Console]::Out.WriteLine('not-json')`,
		"truncated":                `[Console]::Out.Write('{"type":"end","stopReason":"EndTurn"')`,
		"incomplete":               `[Console]::Out.WriteLine('{"type":"end"}')`,
		"duplicate":                `[Console]::Out.WriteLine('{"type":"end","stopReason":"EndTurn"}'); [Console]::Out.WriteLine('{"type":"end","stopReason":"EndTurn"}')`,
		"non-final-after-terminal": `[Console]::Out.WriteLine('{"type":"end","stopReason":"EndTurn"}'); [Console]::Out.WriteLine('{"type":"thought","data":"late"}')`,
		"failed":                   `[Console]::Out.WriteLine('{"type":"error","message":"native failure"}')`,
		"cancelled":                `[Console]::Out.WriteLine('{"type":"end","stopReason":"Cancelled"}')`,
		"valid":                    `[Console]::Out.WriteLine('{"type":"text","data":"ok"}'); [Console]::Out.WriteLine('{"type":"end","stopReason":"EndTurn"}')`,
		"native-nonzero":           `[Console]::Out.WriteLine('{"type":"error","message":"native failure"}'); exit 7`,
	}
	return []string{"powershell.exe", "-NoProfile", "-NonInteractive", "-Command", scripts[streamCase]}
}

func TestResourceLifecycleGrokNativeStreamMatrix(t *testing.T) {
	for _, streamCase := range []string{"empty", "malformed", "truncated", "incomplete", "duplicate", "non-final-after-terminal", "failed", "cancelled", "valid", "native-nonzero"} {
		t.Run(streamCase, func(t *testing.T) {
			plan, home := resourcePlan(t, "exit /b 0")
			plan.Command = windowsGrokStreamCommand(streamCase)
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
	plan, home := resourcePlan(t, "exit /b 7")
	result := runResourcePlan(context.Background(), plan)
	if result.Status != "failed" || result.ExitCode != 7 {
		t.Fatalf("nonzero result = %+v", result)
	}
	if _, err := os.Stat(home); err != nil {
		t.Fatalf("nonzero run home was removed: %v", err)
	}

	plan, startHome := resourcePlan(t, "exit /b 0")
	plan.Command[0] = filepath.Join(t.TempDir(), "missing-child.exe")
	result = runResourcePlan(context.Background(), plan)
	if result.Status != "failed" {
		t.Fatalf("start failure result = %+v", result)
	}
	if _, err := os.Stat(startHome); err != nil {
		t.Fatalf("start-failure run home was removed: %v", err)
	}
}

func TestResourceLifecycleCancellationRetainsRunHome(t *testing.T) {
	plan, home := resourcePlan(t, "ping -n 30 127.0.0.1 >nul")
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

func TestWindowsCancellationTaskkillFailuresUseProcessKillFallback(t *testing.T) {
	cases := []struct {
		name string
		err  error
	}{
		{name: "unavailable", err: exec.ErrNotFound},
		{name: "start failure", err: &os.PathError{Op: "fork/exec", Path: "taskkill", Err: errors.New("start failure")}},
		{name: "access denial", err: syscall.Errno(5)},
		{name: "nonzero result", err: errors.New("taskkill exited with status 1")},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			restore := installWindowsTerminationSeams(t)
			defer restore()
			windowsForcedWaitTimeout = 500 * time.Millisecond
			windowsKillTree = func(int, bool) error { return tc.err }
			fallbackCalls := 0
			var worker *os.Process
			windowsKillProcess = func(process *os.Process) error {
				fallbackCalls++
				worker = process
				return process.Kill()
			}

			plan, home := longWindowsWorkerPlan(t)
			result, elapsed := cancelResourcePlan(t, plan)
			if result.Status != "cancelled" || result.ProcessError || result.Error != "" {
				t.Fatalf("fallback-success result = %+v", result)
			}
			if fallbackCalls != 1 || worker == nil {
				t.Fatalf("Process.Kill fallback calls=%d worker=%v", fallbackCalls, worker)
			}
			if elapsed > 2*time.Second {
				t.Fatalf("fallback cancellation exceeded bound: %s", elapsed)
			}
			if err := worker.Kill(); err == nil {
				t.Fatal("worker remained live after successful Process.Kill fallback and Wait")
			}
			assertAbnormalHomePreserved(t, home)
		})
	}
}

func TestWindowsCancellationFallbackFailureReturnsBoundedActionableError(t *testing.T) {
	restore := installWindowsTerminationSeams(t)
	defer restore()
	windowsForcedWaitTimeout = 200 * time.Millisecond
	windowsKillTree = func(int, bool) error { return errors.New("taskkill access denied") }
	var worker *os.Process
	windowsKillProcess = func(process *os.Process) error {
		worker = process
		return errors.New("fallback access denied")
	}

	plan, home := longWindowsWorkerPlan(t)
	result, elapsed := cancelResourcePlan(t, plan)
	if result.Status != "failed" || !result.ProcessError || !strings.Contains(result.Error, "taskkill access denied") || !strings.Contains(result.Error, "Process.Kill fallback failed") {
		t.Fatalf("fallback-failure result = %+v", result)
	}
	if elapsed > 2*time.Second {
		t.Fatalf("fallback-failure cancellation exceeded bound: %s", elapsed)
	}
	assertAbnormalHomePreserved(t, home)
	if worker == nil {
		t.Fatal("fallback did not receive the live worker")
	}
	_ = worker.Kill()
	time.Sleep(200 * time.Millisecond)
}

func TestWindowsCancellationStubbornTaskkillFallsBackAfterBoundedWait(t *testing.T) {
	restore := installWindowsTerminationSeams(t)
	defer restore()
	windowsForcedWaitTimeout = 500 * time.Millisecond
	windowsKillTree = func(int, bool) error { return nil }
	fallbackCalls := 0
	windowsKillProcess = func(process *os.Process) error {
		fallbackCalls++
		return process.Kill()
	}

	plan, home := longWindowsWorkerPlan(t)
	result, elapsed := cancelResourcePlan(t, plan)
	if result.Status != "cancelled" || result.ProcessError || fallbackCalls != 1 {
		t.Fatalf("stubborn-child result=%+v fallbackCalls=%d", result, fallbackCalls)
	}
	if elapsed < windowsForcedWaitTimeout || elapsed > 2*time.Second {
		t.Fatalf("stubborn-child cancellation elapsed=%s", elapsed)
	}
	assertAbnormalHomePreserved(t, home)
}

func longWindowsWorkerPlan(t *testing.T) (driver.CommandPlan, string) {
	plan, home := resourcePlan(t, "exit /b 0")
	plan.Command = []string{"powershell.exe", "-NoProfile", "-NonInteractive", "-Command", "Start-Sleep -Seconds 30"}
	return plan, home
}

func installWindowsTerminationSeams(t *testing.T) func() {
	t.Helper()
	oldTree := windowsKillTree
	oldProcess := windowsKillProcess
	oldGrace := windowsGracefulWaitTimeout
	oldForced := windowsForcedWaitTimeout
	return func() {
		windowsKillTree = oldTree
		windowsKillProcess = oldProcess
		windowsGracefulWaitTimeout = oldGrace
		windowsForcedWaitTimeout = oldForced
	}
}

func cancelResourcePlan(t *testing.T, plan driver.CommandPlan) (ChildResult, time.Duration) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan ChildResult, 1)
	start := time.Now()
	go func() { done <- runResourcePlan(ctx, plan) }()
	time.Sleep(40 * time.Millisecond)
	cancel()
	select {
	case result := <-done:
		return result, time.Since(start)
	case <-time.After(2 * time.Second):
		t.Fatal("cancelled execution did not return within the test bound")
		return ChildResult{}, 0
	}
}

func assertAbnormalHomePreserved(t *testing.T, home string) {
	t.Helper()
	if _, err := os.Stat(home); err != nil {
		t.Fatalf("abnormal cancellation removed run Home: %v", err)
	}
}
