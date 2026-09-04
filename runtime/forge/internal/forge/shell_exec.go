package forge

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
)

func shellCommand(args []string) int {
	if len(args) > 0 && args[0] == "dsh" {
		return shellDSHCommand(args[1:])
	}
	fmt.Fprintln(os.Stderr, "forge shell: only the internal dsh launcher remains available")
	return 2
}

// runChild executes a child process with the hardened argv/env produced by the
// caller and returns the child's exit code. It is the shared safe execution
// path used by the DSH/fdsh launcher.
func runChild(path string, args []string, env []string) int {
	cmd := exec.Command(path, args...)
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.Env = env
	if err := cmd.Run(); err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			return exitErr.ExitCode()
		}
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	return 0
}
