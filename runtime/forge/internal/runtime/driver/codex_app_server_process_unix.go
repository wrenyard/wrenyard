//go:build !windows

package driver

import (
	"os/exec"
	"syscall"
	"time"
)

const (
	codexForcedKillTimeout = 2 * time.Second
	// codexGroupPollInterval bounds how long cleanup waits between process
	// group liveness checks, so a vanished group is detected immediately
	// instead of stalling for the whole graceful window.
	codexGroupPollInterval = 25 * time.Millisecond
)

// configureCodexChildProcess places the app-server child in its own process
// group on Unix platforms so the whole tree can be signalled at once.
func configureCodexChildProcess(cmd *exec.Cmd) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.Setpgid = true
}

// killCodexChildTree terminates the app-server process group: SIGTERM first,
// then SIGKILL after the bounded graceful window. The group — not the leader —
// gates completion: the leader can exit while grandchildren survive, so a group
// that is already gone is the only success case that returns early.
func killCodexChildTree(proc codexAppServerProcess, waitDone <-chan error) {
	if proc.cmd == nil || proc.cmd.Process == nil {
		return
	}
	pgid := -proc.cmd.Process.Pid
	if err := syscall.Kill(pgid, syscall.SIGTERM); err != nil && err != syscall.ESRCH {
		_ = proc.cmd.Process.Kill()
	}
	if waitCodexProcessGroupGone(pgid, waitDone, codexForcedKillTimeout) {
		return
	}
	if err := syscall.Kill(pgid, syscall.SIGKILL); err != nil && err != syscall.ESRCH {
		_ = proc.cmd.Process.Kill()
	}
	if waitCodexProcessGroupGone(pgid, waitDone, codexForcedKillTimeout) {
		return
	}
	// The group outlived even SIGKILL, which only an uninterruptible task can
	// do. Give the single reaped leader a bounded moment to settle rather than
	// blocking teardown forever.
	select {
	case <-waitDone:
	case <-time.After(codexGroupPollInterval):
	}
}

// waitCodexProcessGroupGone polls pgid until no member remains, the leader has
// been reaped and its group is empty, or the deadline passes. waitDone is
// observed only as a hint: the leader exiting does NOT imply the group is gone.
func waitCodexProcessGroupGone(pgid int, waitDone <-chan error, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for {
		if !codexProcessGroupAlive(pgid) {
			return true
		}
		remaining := time.Until(deadline)
		if remaining <= 0 {
			return false
		}
		wait := codexGroupPollInterval
		if remaining < wait {
			wait = remaining
		}
		select {
		case <-waitDone:
			// The leader is reaped; keep polling at full speed so a surviving
			// grandchild cannot outlive cleanup.
		case <-time.After(wait):
		}
	}
}

// codexProcessGroupAlive reports whether any process still belongs to pgid.
// Signal 0 probes membership without delivering a signal; EPERM means a member
// exists but is not signallable, which still counts as alive.
func codexProcessGroupAlive(pgid int) bool {
	err := syscall.Kill(pgid, 0)
	return err == nil || err == syscall.EPERM
}

// codexChildTreeGone reports whether the leader's whole process group has
// vanished. The leader's Wait completing is deliberately ignored as a
// sufficient condition: grandchildren can outlive the group leader.
func codexChildTreeGone(pid int, _ <-chan error) bool {
	return !codexProcessGroupAlive(-pid)
}
