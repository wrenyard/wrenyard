//go:build windows

package driver

import (
	"context"
	"fmt"
	"os/exec"
	"syscall"
	"time"
)

const (
	codexWindowsCreateNoWindow      = 0x08000000
	codexWindowsCreateNewProcessGrp = 0x00000200
	codexForcedKillTimeout          = 2 * time.Second
)

// configureCodexChildProcess hides the app-server console window and gives the
// child its own process group so a console interrupt is never inherited.
func configureCodexChildProcess(cmd *exec.Cmd) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.HideWindow = true
	cmd.SysProcAttr.CreationFlags |= codexWindowsCreateNoWindow | codexWindowsCreateNewProcessGrp
}

// killCodexChildTree force-kills the whole app-server process tree with
// taskkill /F /T, falling back to killing the direct child if taskkill cannot
// be run at all. taskkill is bounded by a context timeout and runs hidden so
// cleanup can neither block forever nor flash a console window. taskkill /T is
// given the tree root PID even when the leader has already been reaped: the
// tree, not the leader, is what must die, and taskkill is bounded so it can
// never block on a PID that has gone away.
func killCodexChildTree(proc codexAppServerProcess, waitDone <-chan error) {
	if proc.cmd == nil || proc.cmd.Process == nil {
		return
	}
	pid := proc.cmd.Process.Pid
	ctx, cancel := context.WithTimeout(context.Background(), codexForcedKillTimeout)
	defer cancel()
	kill := exec.CommandContext(ctx, "taskkill", "/T", "/F", "/PID", fmt.Sprintf("%d", pid))
	kill.Stdout = nil
	kill.Stderr = nil
	kill.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	if err := kill.Run(); err != nil {
		// The direct-child kill is only safe while the leader has NOT been
		// reaped: the PID could otherwise be reused by an unrelated process.
		select {
		case <-waitDone:
		default:
			_ = proc.cmd.Process.Kill()
		}
	}
	select {
	case <-waitDone:
	case <-time.After(codexForcedKillTimeout):
		// A reaped leader means the PID may be reused, so the last-resort kill
		// is applied only when the Wait result has not been observed at all.
		select {
		case <-waitDone:
		default:
			_ = proc.cmd.Process.Kill()
		}
	}
}

// codexChildTreeGone reports whether the child tree is already gone. Windows
// offers no signal-0 group probe, so the reaped leader's Wait result is the
// only cheap evidence available: once it is observed there is nothing left to
// taskkill, and signalling the PID again could hit a reused process.
func codexChildTreeGone(_ int, waitDone <-chan error) bool {
	if waitDone == nil {
		return false
	}
	select {
	case <-waitDone:
		return true
	default:
		return false
	}
}
