package driver

// ClaudeCleanArgs returns the clean-mode args for the Claude CLI: a fresh
// slice with exactly --bare and --strict-mcp-config.
func ClaudeCleanArgs() []string {
	return []string{"--bare", "--strict-mcp-config"}
}
