//go:build !windows

package driver

import (
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// The app-server child can spawn helpers that outlive their group leader. These
// tests drive the real teardown against native processes only: no models, no
// credentials, no JSON-RPC fake.
//
// Helper topology, all in one process group:
//
//	leader (/bin/sh, group leader, exits on TERM)
//	  └── grandchild (/bin/sh, ignores TERM, outlives the leader)
//
// This is exactly the shape the old leader-exit early return leaked.

// TestKillCodexChildTreeKillsSurvivingGrandchildSignalIgnored is the core
// regression: the leader exits on TERM while a TERM-ignoring grandchild
// survives, and the grandchild must still be gone once teardown returns.
func TestKillCodexChildTreeKillsSurvivingGrandchildSignalIgnored(t *testing.T) {
	leader, pgid, grandchild := startCodexTreeWithTermIgnoringGrandchild(t)
	waitDone := waitForCodexProcess(leader)

	// SIGTERM only the leader: it dies, the grandchild ignores the signal.
	_ = syscall.Kill(leader.Process.Pid, syscall.SIGTERM)
	waitCodexProcessExit(t, leader, "leader")

	// The leader is reaped while the grandchild survives; signal 0 on the
	// group must still report it alive, which is what the old leader-exit
	// early return got wrong.
	if !codexChildTreeAliveForTest(pgid) {
		t.Fatalf("expected grandchild in group %d to still be alive after the leader exited", pgid)
	}

	done := make(chan struct{})
	go func() {
		defer close(done)
		killCodexChildTree(codexAppServerProcess{cmd: leader}, waitDone)
	}()
	select {
	case <-done:
	case <-time.After(4 * codexForcedKillTimeout):
		t.Fatalf("killCodexChildTree did not return within its bounded window")
	}

	if codexChildTreeAliveForTest(pgid) {
		_ = syscall.Kill(-pgid, syscall.SIGKILL)
		t.Fatalf("process group %d still alive after bounded cleanup", pgid)
	}
	if processAlive(grandchild) {
		t.Fatalf("grandchild pid %d survived bounded cleanup", grandchild)
	}
}

// TestTerminateCodexAppServerChildNoLatencyWhenGroupGone pins the fast path: a
// normally completed call whose group has already vanished must not pay the
// 2 second escalation window.
func TestTerminateCodexAppServerChildNoLatencyWhenGroupGone(t *testing.T) {
	leader, pgid, _ := startCodexTreeWithTermIgnoringGrandchild(t)
	waitDone := waitForCodexProcess(leader)

	// Tear the whole group down first so cleanup has nothing left to do.
	_ = syscall.Kill(-pgid, syscall.SIGKILL)
	waitCodexProcessExit(t, leader, "leader")
	if codexChildTreeAliveForTest(pgid) {
		t.Fatalf("test setup: process group %d unexpectedly alive", pgid)
	}

	start := time.Now()
	terminateCodexAppServerChild(codexAppServerProcess{cmd: leader}, waitDone)
	if elapsed := time.Since(start); elapsed >= codexCleanupBoundedTimeout {
		t.Fatalf("cleanup of an already-gone group took %v, expected well under %v", elapsed, codexCleanupBoundedTimeout)
	}
}

// TestTerminateCodexAppServerChildKillsGrandchildAfterLeaderExit exercises the
// terminate wrapper (not just the kill helper) on the leaking shape, proving
// the leader's completed Wait no longer short-circuits cleanup.
func TestTerminateCodexAppServerChildKillsGrandchildAfterLeaderExit(t *testing.T) {
	leader, pgid, grandchild := startCodexTreeWithTermIgnoringGrandchild(t)
	waitDone := waitForCodexProcess(leader)

	_ = syscall.Kill(leader.Process.Pid, syscall.SIGTERM)
	waitCodexProcessExit(t, leader, "leader")

	done := make(chan struct{})
	go func() {
		defer close(done)
		terminateCodexAppServerChild(codexAppServerProcess{cmd: leader}, waitDone)
	}()
	select {
	case <-done:
	case <-time.After(codexCancelWatchdogGrace + 4*codexForcedKillTimeout):
		t.Fatalf("terminateCodexAppServerChild did not return within its bounded window")
	}

	if processAlive(grandchild) {
		_ = syscall.Kill(-pgid, syscall.SIGKILL)
		t.Fatalf("grandchild pid %d survived teardown after the leader exited", grandchild)
	}
}

// startCodexTreeWithTermIgnoringGrandchild starts the native helper topology
// and returns the group leader cmd, its process group id, and the grandchild
// pid. The grandchild pid is read from disk once the helper publishes it.
func startCodexTreeWithTermIgnoringGrandchild(t *testing.T) (*exec.Cmd, int, int) {
	t.Helper()
	dir := t.TempDir()
	pidFile := filepath.Join(dir, "grandchild.pid")

	// The leader exits on a plain SIGTERM (it does NOT trap it); the grandchild
	// ignores TERM so it survives the initial SIGTERM and needs SIGKILL. That
	// split is what makes the leak reproducible.
	grandchildScript := "trap '' TERM; while :; do sleep 0.2; done"
	leaderScript := "/bin/sh -c \"$GRANDCHILD\" & echo $! > \"$PIDFILE\"; wait"
	cmd := exec.Command("/bin/sh", "-c", leaderScript)
	cmd.Env = append(os.Environ(),
		"GRANDCHILD="+grandchildScript,
		"PIDFILE="+pidFile,
	)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := cmd.Start(); err != nil {
		t.Fatalf("start helper: %v", err)
	}
	pgid := cmd.Process.Pid
	t.Cleanup(func() { _ = syscall.Kill(-pgid, syscall.SIGKILL) })

	grandchild := waitForPidFile(t, pidFile)
	return cmd, pgid, grandchild
}

// waitForPidFile waits for the helper's grandchild pid file, bounded so a
// failed spawn cannot hang the suite.
func waitForPidFile(t *testing.T, path string) int {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if body, err := os.ReadFile(path); err == nil {
			if pid, convErr := strconv.Atoi(strings.TrimSpace(string(body))); convErr == nil && pid > 0 {
				return pid
			}
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("helper never published grandchild pid to %s", path)
	return 0
}

// waitForCodexProcess runs Wait in the background and returns its channel,
// mirroring the run loop's single-waiter contract (channel closed after send).
func waitForCodexProcess(cmd *exec.Cmd) <-chan error {
	waitDone := make(chan error, 1)
	go func() {
		waitDone <- cmd.Wait()
		close(waitDone)
	}()
	return waitDone
}

// waitCodexProcessExit blocks until the named process is reaped, bounded so a
// broken helper cannot hang the suite.
func waitCodexProcessExit(t *testing.T, cmd *exec.Cmd, name string) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if !processAlive(cmd.Process.Pid) {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("%s pid %d did not exit", name, cmd.Process.Pid)
}

// processAlive reports whether pid is still present, without signalling it.
func processAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	return syscall.Kill(pid, 0) == nil
}

// codexChildTreeAliveForTest probes group liveness through the production
// helper so the test asserts the same predicate cleanup uses.
func codexChildTreeAliveForTest(pgid int) bool {
	return !codexChildTreeGone(pgid, nil)
}
