package forge

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/driver"
)

func shellCommand(args []string) int {
	if len(args) > 0 && args[0] == "grok" {
		return shellGrokCommand(args[1:])
	}
	if len(args) > 0 && args[0] == "dsh" {
		return shellDSHCommand(args[1:])
	}
	if len(args) < 4 || args[0] != "exec" || args[2] != "--" {
		fmt.Fprintln(os.Stderr, "forge shell: internal command; run forge setup to install shell shortcuts")
		return 2
	}
	profileName := args[1]
	manifest, err := loadManifest()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	p, ok := manifest.Profiles[profileName]
	if !ok {
		fmt.Fprintf(os.Stderr, "forge shell exec: unknown profile %s\n", profileName)
		return 2
	}
	if p.Client != "claude" {
		fmt.Fprintf(os.Stderr, "forge shell exec: profile %s is for client %s, expected claude\n", profileName, p.Client)
		return 2
	}
	reg, regErr := loadCatalogRegistry()
	if regErr != nil {
		fmt.Fprintln(os.Stderr, regErr)
		return 1
	}
	_, provider, err := reg.ResolveBinding(p.Client, p.Provider)
	if err != nil || provider.Inference == nil || provider.Inference.Protocol != "anthropic-messages" {
		fmt.Fprintf(os.Stderr, "forge shell exec: profile %s provider %s does not support anthropic-messages\n", profileName, p.Provider)
		return 2
	}
	credential, ok := ResolveCredential(p.Provider)
	if !ok || strings.TrimSpace(credential) == "" {
		fmt.Fprintf(os.Stderr, "forge shell exec: no credential for provider %s; run forge providers auth login %s\n", p.Provider, p.Provider)
		return 1
	}

	cmd := exec.Command(args[3], args[4:]...)
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	childEnv := map[string]string{
		"ANTHROPIC_API_KEY": credential,
		"FORGE_PROFILE":     profileName,
	}
	for _, key := range []string{"CLAUDE_CONFIG_DIR", "CLAUDE_JOB_DIR"} {
		if value := strings.TrimSpace(os.Getenv(key)); value != "" {
			childEnv[key] = value
		}
	}
	env := driver.BuildChildEnv(childEnv)
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
