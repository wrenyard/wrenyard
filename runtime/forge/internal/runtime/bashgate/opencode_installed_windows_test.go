//go:build windows

package bashgate

import "os/exec"

func setOpenCodeProcessGroup(cmd *exec.Cmd) {}

func sendOpenCodeProcessSignal(pid int, signal string) error {
	return taskkillOpenCodeProcessTree(pid, signal == "KILL")
}
