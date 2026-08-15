//go:build !windows

package quota

import (
	"os/exec"
	"syscall"
)

func applyDetached(cmd *exec.Cmd) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	// Setsid creates a new session: the child is detached from the
	// parent's controlling terminal and won't receive SIGHUP when the
	// terminal closes.
	cmd.SysProcAttr.Setsid = true
}
