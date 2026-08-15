//go:build !windows

package execution

import (
	"fmt"
	"os/exec"
	"syscall"
	"time"
)

var (
	nonWindowsGracefulWaitTimeout = 10 * time.Second
	nonWindowsForcedWaitTimeout   = 5 * time.Second
)

// hideCommandWindow configures the child command to run in its own process
// group on non-Windows platforms. It is the execution-package equivalent of the
// root hideCommandWindow helper and stays private to execution.
func hideCommandWindow(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

// terminateWorkerTree synchronously terminates the worker process group started
// by runProcess. It sends SIGTERM to the worker PGID, waits up to 10 seconds for
// the worker to exit, then escalates to SIGKILL and waits again. Already-exited
// workers (including a kill that returns ESRCH) are treated as success.
//
// waitDone is the channel fed by cmd.Wait(); terminateWorkerTree waits on it so
// the caller does not return before the worker has fully exited. Only cmd.Wait
// ever reaps the child; this helper only signals and joins on waitDone.
func terminateWorkerTree(cmd *exec.Cmd, waitDone <-chan error) error {
	if cmd == nil || cmd.Process == nil {
		return nil
	}
	pgid := -cmd.Process.Pid
	// Best-effort graceful termination of the whole process group. A nil/ESRCH
	// error (already exited) is ignored: we still wait on waitDone below.
	termErr := syscall.Kill(pgid, syscall.SIGTERM)
	select {
	case <-waitDone:
		return nil
	case <-time.After(nonWindowsGracefulWaitTimeout):
		// Graceful termination did not complete; force-kill the group.
		killErr := syscall.Kill(pgid, syscall.SIGKILL)
		if waitForNonWindowsWorker(waitDone, nonWindowsForcedWaitTimeout) {
			return nil
		}
		if termErr != nil && termErr != syscall.ESRCH && killErr != nil && killErr != syscall.ESRCH {
			return fmt.Errorf("terminate worker process group: SIGTERM failed (%v), SIGKILL failed (%v), and the child was not reaped within %s", termErr, killErr, nonWindowsForcedWaitTimeout)
		}
		if killErr != nil && killErr != syscall.ESRCH {
			return fmt.Errorf("terminate worker process group: SIGKILL failed (%v) and the child was not reaped within %s", killErr, nonWindowsForcedWaitTimeout)
		}
		return fmt.Errorf("terminate worker process group: SIGKILL sent but the child was not reaped within %s", nonWindowsForcedWaitTimeout)
	}
}

func terminateWorkerTreeNow(cmd *exec.Cmd, waitDone <-chan error) error {
	if cmd == nil || cmd.Process == nil {
		return nil
	}
	killErr := syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	if waitForNonWindowsWorker(waitDone, nonWindowsForcedWaitTimeout) {
		return nil
	}
	if killErr != nil && killErr != syscall.ESRCH {
		return fmt.Errorf("terminate worker process group immediately: SIGKILL failed (%v) and the child was not reaped within %s", killErr, nonWindowsForcedWaitTimeout)
	}
	return fmt.Errorf("terminate worker process group immediately: SIGKILL sent but the child was not reaped within %s", nonWindowsForcedWaitTimeout)
}

func waitForNonWindowsWorker(waitDone <-chan error, timeout time.Duration) bool {
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case <-waitDone:
		return true
	case <-timer.C:
		return false
	}
}
