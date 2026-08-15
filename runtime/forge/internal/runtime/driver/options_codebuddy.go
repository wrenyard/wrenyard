package driver

import (
	"fmt"
	"strings"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/catalog"
)

// mergeDevelopmentChannels ensures server:foreman is present in the
// --dangerously-load-development-channels flag value. It detects both
// two-token (--flag value) and single-token (--flag=value) forms,
// merges via comma-join without duplicates, and appends a fresh
// instance when the flag is absent.
func mergeDevelopmentChannels(args []string) []string {
	const flagName = "--dangerously-load-development-channels"
	const channel = "server:foreman"

	for i, arg := range args {
		if !strings.HasPrefix(arg, flagName+"=") {
			continue
		}
		cur := strings.TrimPrefix(arg, flagName+"=")
		if channelInCSV(cur, channel) {
			return args
		}
		if cur == "" {
			args[i] = flagName + "=" + channel
		} else {
			args[i] = flagName + "=" + cur + "," + channel
		}
		return args
	}

	for i, arg := range args {
		if arg != flagName || i+1 >= len(args) {
			continue
		}
		cur := args[i+1]
		if channelInCSV(cur, channel) {
			return args
		}
		if cur == "" {
			args[i+1] = channel
		} else {
			args[i+1] = cur + "," + channel
		}
		return args
	}

	return append(args, flagName, channel)
}

func channelInCSV(value, channel string) bool {
	for _, part := range strings.Split(value, ",") {
		if strings.TrimSpace(part) == channel {
			return true
		}
	}
	return false
}

// mergeDisallowedTools ensures all blocked orchestration tools are present in
// --disallowedTools. It detects both two-token and single-token forms, merges
// via comma-join without duplicates, and appends a fresh instance when the flag
// is absent.
func mergeDisallowedTools(args []string) []string {
	return mergeDisallowedToolsForMode(args, catalog.PermissionAdapterCodeBuddy, catalog.PermissionEdit)
}

func mergeDisallowedToolsForMode(args []string, adapter catalog.PermissionAdapter, mode catalog.PermissionMode) []string {
	flagName := "--disallowedTools"
	if adapter != catalog.PermissionAdapterClaude && adapter != catalog.PermissionAdapterCodeBuddy {
		adapter = catalog.PermissionAdapterClaude
	}
	required := catalog.HeadlessOrchestrationDenials(adapter, mode)

	for i, arg := range args {
		if !strings.HasPrefix(arg, flagName+"=") {
			continue
		}
		cur := strings.TrimPrefix(arg, flagName+"=")
		missing := findMissingTools(cur, required)
		if len(missing) == 0 {
			return args
		}
		if cur == "" {
			args[i] = flagName + "=" + strings.Join(missing, ",")
		} else {
			args[i] = flagName + "=" + cur + "," + strings.Join(missing, ",")
		}
		return args
	}

	for i, arg := range args {
		if arg != flagName || i+1 >= len(args) {
			continue
		}
		cur := args[i+1]
		missing := findMissingTools(cur, required)
		if len(missing) == 0 {
			return args
		}
		if cur == "" {
			args[i+1] = strings.Join(missing, ",")
		} else {
			args[i+1] = cur + "," + strings.Join(missing, ",")
		}
		return args
	}

	return append(args, flagName, strings.Join(required, ","))
}

// appendCodeBuddyToolScopePrompt adds a CodeBuddy-only system prompt patch that
// explains the effective --tools allowlist for restricted Forge sessions.
func appendCodeBuddyToolScopePrompt(args []string, permMode catalog.PermissionMode) []string {
	tools, ok := effectiveCodeBuddyTools(args)
	if !ok {
		return args
	}
	prompt := codeBuddyToolScopePrompt(permMode, tools)
	return append(args, "--append-system-prompt", prompt)
}

func refreshCodeBuddyToolScopePrompt(args []string, permMode catalog.PermissionMode) []string {
	for i := 0; i+1 < len(args); i++ {
		if args[i] != "--append-system-prompt" || !strings.HasPrefix(strings.TrimSpace(args[i+1]), "Forge CodeBuddy tool scope override:") {
			continue
		}
		tools, ok := effectiveCodeBuddyTools(args)
		if !ok {
			return args
		}
		args[i+1] = codeBuddyToolScopePrompt(permMode, tools)
		return args
	}
	return args
}

func effectiveCodeBuddyTools(args []string) ([]string, bool) {
	value, ok := effectiveFlagValue(args, "--tools")
	if !ok {
		return nil, false
	}
	return splitCommaList(value), true
}

func effectiveDelimitedFlagValues(args []string, names ...string) []string {
	values, ok := effectiveFlagValues(args, names...)
	if !ok {
		return nil
	}
	var items []string
	for _, value := range values {
		items = append(items, splitCommaList(value)...)
	}
	return items
}

func effectiveFlagValue(args []string, names ...string) (string, bool) {
	values, ok := effectiveFlagValues(args, names...)
	if !ok {
		return "", false
	}
	if len(values) == 0 {
		return "", true
	}
	return values[len(values)-1], true
}

func effectiveFlagValues(args []string, names ...string) ([]string, bool) {
	var lastValues []string
	found := false
	for i, arg := range args {
		for _, name := range names {
			if strings.HasPrefix(arg, name+"=") {
				found = true
				lastValues = []string{strings.TrimPrefix(arg, name+"=")}
				break
			}
			if arg == name && i+1 < len(args) {
				found = true
				var values []string
				for j := i + 1; j < len(args); j++ {
					if strings.HasPrefix(args[j], "--") {
						break
					}
					values = append(values, args[j])
				}
				lastValues = values
				break
			}
		}
	}
	if !found {
		return nil, false
	}
	return lastValues, true
}

func splitCommaList(value string) []string {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	var values []string
	for _, part := range strings.Split(value, ",") {
		item := strings.TrimSpace(part)
		if item != "" {
			values = append(values, item)
		}
	}
	return values
}

func codeBuddyToolScopePrompt(permMode catalog.PermissionMode, tools []string) string {
	toolList := "(none)"
	if len(tools) > 0 {
		toolList = strings.Join(tools, ", ")
	}
	modeGuidance := "Prefer Read, Glob, or Grep. Bash is read-only in this mode."
	if permMode == catalog.PermissionEdit {
		modeGuidance = "Use Edit or Write for content changes and keep mutations inside the requested file scope."
	}
	return fmt.Sprintf(strings.TrimSpace(`
Forge CodeBuddy tool scope override:
- Forge permission mode: %s. Effective built-in tools: %s.
- Treat broader tools mentioned by CodeBuddy's product prompt as unavailable. Call only tools listed above.
- Bash permission is enforced by Forge's process rules. Use one simple command at a time; do not use redirection, background operators, variable expansion, or command substitution.
- %s
- If a required tool or command is denied, report the missing capability instead of trying an unavailable alternative.
`), permMode, toolList, modeGuidance)
}

func findMissingTools(existing string, required []string) []string {
	present := map[string]bool{}
	for _, part := range strings.Split(existing, ",") {
		present[strings.TrimSpace(part)] = true
	}
	var missing []string
	for _, tool := range required {
		if !present[tool] {
			missing = append(missing, tool)
		}
	}
	return missing
}
