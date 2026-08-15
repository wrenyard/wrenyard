//go:build windows

package execution

import (
	"fmt"
	"os"
	"os/exec"
	"syscall"
	"time"
)

const windowsCreateNoWindow = 0x08000000

var (
	windowsKillTree            = killTree
	windowsKillProcess         = func(process *os.Process) error { return process.Kill() }
	windowsGracefulWaitTimeout = 10 * time.Second
	windowsForcedWaitTimeout   = 5 * time.Second
)

// hideCommandWindow configures the child command to launch without a visible
// console window on Windows. It is the execution-package equivalent of the
// root hideCommandWindow helper and stays private to execution.
func hideCommandWindow(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{
		HideWindow:    true,
		CreationFlags: windowsCreateNoWindow,
	}
}

// terminateWorkerTree synchronously terminates the full worker process tree on
// Windows. It issues a graceful termination to the worker and its descendants,
// waits up to 10 seconds for the worker to exit, then force-kills the tree and
// waits again. Already-exited workers are treated as success.
//
// waitDone is the channel fed by cmd.Wait(); terminateWorkerTree waits on it so
// the caller does not return before the worker has fully exited.
func terminateWorkerTree(cmd *exec.Cmd, waitDone <-chan error) error {
	if cmd == nil || cmd.Process == nil {
		return nil
	}
	pid := cmd.Process.Pid
	// Graceful termination of the whole tree (no /F).
	graceErr := windowsKillTree(pid, false)
	if graceErr == nil && waitForWindowsWorker(waitDone, windowsGracefulWaitTimeout) {
		return nil
	}
	return forceTerminateWindowsWorker(cmd, waitDone, graceErr)
}

func terminateWorkerTreeNow(cmd *exec.Cmd, waitDone <-chan error) error {
	if cmd == nil || cmd.Process == nil {
		return nil
	}
	return forceTerminateWindowsWorker(cmd, waitDone, nil)
}

func forceTerminateWindowsWorker(cmd *exec.Cmd, waitDone <-chan error, priorErr error) error {
	treeErr := windowsKillTree(cmd.Process.Pid, true)
	if treeErr == nil && waitForWindowsWorker(waitDone, windowsForcedWaitTimeout) {
		return nil
	}
	if workerAlreadyExited(waitDone) {
		return nil
	}
	fallbackErr := windowsKillProcess(cmd.Process)
	if fallbackErr != nil {
		if waitForWindowsWorker(waitDone, windowsForcedWaitTimeout) {
			return nil
		}
		if priorErr != nil && treeErr != nil {
			return fmt.Errorf("terminate Windows worker tree after graceful taskkill failed (%v): forced taskkill failed (%v); Process.Kill fallback failed: %w", priorErr, treeErr, fallbackErr)
		}
		if priorErr != nil {
			return fmt.Errorf("terminate Windows worker tree after graceful taskkill failed (%v): forced taskkill reported success but the child remained alive; Process.Kill fallback failed: %w", priorErr, fallbackErr)
		}
		if treeErr == nil {
			return fmt.Errorf("terminate Windows worker tree: taskkill reported success but the child remained alive; Process.Kill fallback failed: %w", fallbackErr)
		}
		return fmt.Errorf("terminate Windows worker tree: taskkill failed (%v); Process.Kill fallback failed: %w", treeErr, fallbackErr)
	}
	if waitForWindowsWorker(waitDone, windowsForcedWaitTimeout) {
		return nil
	}
	if treeErr != nil {
		return fmt.Errorf("terminate Windows worker tree: taskkill failed (%v); Process.Kill succeeded but the child did not exit within %s", treeErr, windowsForcedWaitTimeout)
	}
	return fmt.Errorf("terminate Windows worker tree: taskkill reported success and Process.Kill succeeded, but the child did not exit within %s", windowsForcedWaitTimeout)
}

func workerAlreadyExited(waitDone <-chan error) bool {
	select {
	case <-waitDone:
		return true
	default:
		return false
	}
}

func waitForWindowsWorker(waitDone <-chan error, timeout time.Duration) bool {
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case <-waitDone:
		return true
	case <-timer.C:
		return false
	}
}

// killTree terminates the process tree rooted at pid. When force is true it
// uses taskkill /F to forcibly kill the tree; otherwise it requests a graceful
// exit of the tree. Errors are ignored because an already-exited target is
// treated as success by the caller.
func killTree(pid int, force bool) error {
	args := []string{"/T", "/PID", fmt.Sprintf("%d", pid)}
	if force {
		args = append(args, "/F")
	}
	kill := exec.Command("taskkill", args...)
	kill.Stdout = nil
	kill.Stderr = nil
	return kill.Run()
}
