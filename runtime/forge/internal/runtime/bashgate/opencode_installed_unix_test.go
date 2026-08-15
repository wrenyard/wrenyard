//go:build !windows

package bashgate

import (
	"os/exec"
	"syscall"
)

func setOpenCodeProcessGroup(cmd *exec.Cmd) {
	if cmd != nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	}
}

func sendOpenCodeProcessSignal(pid int, signal string) error {
	switch signal {
	case "TERM":
		return syscall.Kill(-pid, syscall.SIGTERM)
	case "KILL":
		return syscall.Kill(-pid, syscall.SIGKILL)
	default:
		return nil
	}
}
