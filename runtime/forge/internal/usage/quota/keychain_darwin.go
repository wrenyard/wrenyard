//go:build darwin

package quota

import (
	"context"
	"os"
	"os/exec"
	"strings"
)

func readClaudeKeychain(ctx context.Context) ([]byte, error) {
	// 1. Try by service name first — more precise, less likely to match unrelated items.
	cmd := exec.CommandContext(ctx, "security", "find-generic-password", "-s", "Claude Code-credentials", "-w")
	out, err := cmd.Output()
	if err == nil && len(strings.TrimSpace(string(out))) > 0 {
		return out, nil
	}

	// 2. Fall back to account-based candidates for legacy keychain entries.
	accounts := []string{}
	for _, candidate := range []string{"oauth.claude", os.Getenv("USER"), os.Getenv("LOGNAME")} {
		if strings.TrimSpace(candidate) != "" {
			accounts = append(accounts, candidate)
		}
	}
	var lastErr error
	for _, account := range accounts {
		cmd := exec.CommandContext(ctx, "security", "find-generic-password", "-a", account, "-w")
		out, err := cmd.Output()
		if err == nil && len(strings.TrimSpace(string(out))) > 0 {
			return out, nil
		}
		lastErr = err
	}
	return nil, lastErr
}

// ReadClaudeKeychain exports the macOS keychain read for use by the
// forge auth import-claude bootstrap command. On macOS this triggers
// exactly one security authorization prompt the user must approve.
func ReadClaudeKeychain(ctx context.Context) ([]byte, error) {
	return readClaudeKeychain(ctx)
}
