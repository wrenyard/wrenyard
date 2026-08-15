package bashgate

import (
	"encoding/json"
	"fmt"
	"runtime"
	"strings"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/catalog"
)

type hookFile struct {
	Hooks map[string][]hookMatcher `json:"hooks"`
}

type hookMatcher struct {
	Matcher string        `json:"matcher"`
	Hooks   []hookHandler `json:"hooks"`
}

type hookHandler struct {
	Type    string            `json:"type"`
	Command string            `json:"command"`
	Timeout int               `json:"timeout"`
	Env     map[string]string `json:"env,omitempty"`
}

const (
	grokGuardMatcher = "Bash|run_terminal_cmd|run_terminal_command|Read|read_file|Grep|grep|Glob|ListDir|list_dir|Edit|Write|MultiEdit|search_replace"

	// ExecutableEnv carries the cmd.exe-quoted Forge path used by the Windows
	// Claude-family hook adapter. Keeping the path out of the MSYS command
	// string avoids a second, incompatible layer of POSIX quoting.
	ExecutableEnv = "FORGE_INTERNAL_BASH_GATE_EXECUTABLE"

	windowsClaudeHookCommand = "MSYS2_ARG_CONV_EXCL='*' cmd.exe /d /s /c call %" + ExecutableEnv + "% || exit 2"
)

// GrokHookBytes builds the trusted global hook installed only in a fresh,
// isolated per-run GROK_HOME.
func GrokHookBytes(executable string, allow []catalog.BashRule, sensitiveEnvKeys []string, sensitivePaths []SensitivePath) ([]byte, error) {
	return GrokHookBytesForPlatform(executable, allow, sensitiveEnvKeys, sensitivePaths, runtime.GOOS)
}

// GrokHookBytesForPlatform binds the policy to the child execution platform.
func GrokHookBytesForPlatform(executable string, allow []catalog.BashRule, sensitiveEnvKeys []string, sensitivePaths []SensitivePath, goos string) ([]byte, error) {
	return GrokHookBytesForPlatformAndMode(executable, allow, sensitiveEnvKeys, sensitivePaths, goos, false)
}

// GrokHookBytesForPlatformAndMode keeps yolo Bash unrestricted while still
// installing the sensitive read/edit path boundary required around copied
// OAuth material.
func GrokHookBytesForPlatformAndMode(executable string, allow []catalog.BashRule, sensitiveEnvKeys []string, sensitivePaths []SensitivePath, goos string, bashUnrestricted bool) ([]byte, error) {
	command, err := hookExecutable(executable, false)
	if err != nil {
		return nil, err
	}
	dialect, ok := catalog.BashShellDialectForPlatform(goos)
	if !ok {
		return nil, policyError{}
	}
	policy, err := encodePolicyForShell(ClientGrok, allow, sensitiveEnvKeys, sensitivePaths, dialect, bashUnrestricted)
	if err != nil {
		return nil, err
	}
	return marshalHook(hookFile{Hooks: map[string][]hookMatcher{
		"PreToolUse": {{
			Matcher: grokGuardMatcher,
			Hooks: []hookHandler{{
				Type: "command", Command: command, Timeout: 30,
				Env: map[string]string{ModeEnv: string(ClientGrok), PolicyEnv: policy},
			}},
		}},
	}})
}

// ClaudeFamilySettingsBytes builds a single inline settings object. The gate
// policy itself remains in the isolated child environment so settings never
// carry credentials or per-capability secret material.
func ClaudeFamilySettingsBytes(executable string) ([]byte, error) {
	command, err := claudeFamilyHookCommand(executable, runtime.GOOS)
	if err != nil {
		return nil, err
	}
	return marshalHook(hookFile{Hooks: map[string][]hookMatcher{
		"PreToolUse": {{
			Matcher: "^Bash$",
			Hooks: []hookHandler{{
				Type: "command", Command: command, Timeout: 30,
			}},
		}},
	}})
}

// ClaudeFamilyHookEnv returns the extra per-run environment required by the
// Windows Claude-family hook adapter. The value is quoted for cmd.exe, not for
// the MSYS shell; non-Windows clients retain their existing direct launch.
func ClaudeFamilyHookEnv(executable string) (map[string]string, error) {
	return claudeFamilyHookEnv(executable, runtime.GOOS)
}

func claudeFamilyHookCommand(executable, goos string) (string, error) {
	executable, err := validateHookExecutable(executable)
	if err != nil {
		return "", err
	}
	if goos == "windows" {
		// Claude 2.1.212 invokes hooks through MSYS2. cmd.exe can launch the
		// native Forge image at this boundary when argument conversion is off.
		// The outer shell maps cmd.exe launch failures to the blocking status;
		// BashGate's only nonzero child status is already the same exact value 2.
		return windowsClaudeHookCommand, nil
	}
	executable = strings.ReplaceAll(executable, `\`, "/")
	return `"` + executable + `" || exit 2`, nil
}

func claudeFamilyHookEnv(executable, goos string) (map[string]string, error) {
	executable, err := validateHookExecutable(executable)
	if err != nil {
		return nil, err
	}
	if goos != "windows" {
		return nil, nil
	}
	return map[string]string{ExecutableEnv: `"` + executable + `"`}, nil
}

func marshalHook(hook hookFile) ([]byte, error) {
	data, err := json.Marshal(hook)
	if err != nil {
		return nil, fmt.Errorf("encode BashGate hook: %w", err)
	}
	return data, nil
}

func hookExecutable(executable string, quote bool) (string, error) {
	var err error
	executable, err = validateHookExecutable(executable)
	if err != nil {
		return "", err
	}
	if quote {
		// Claude-family hook commands are shell commands. Map every executable
		// launch/runtime failure to the documented blocking status 2 so a broken
		// guard cannot turn dontAsk into an allow. The validated quoted path
		// remains a single shell word.
		// Claude Code 2.1.212 and CodeBuddy execute hook commands through a
		// POSIX-compatible shell even on Windows. Forward slashes keep a Windows
		// executable path one quoted shell word while also remaining valid to
		// CreateProcess when a compatible client invokes it directly.
		executable = strings.ReplaceAll(executable, `\`, "/")
		return `"` + executable + `" || exit 2`, nil
	}
	// Grok treats an executable-only command as one path; quotes become part of
	// a relative filename in 0.2.106.
	return executable, nil
}

func validateHookExecutable(executable string) (string, error) {
	executable = strings.TrimSpace(executable)
	if executable == "" || strings.ContainsAny(executable, "\x00\r\n\"") {
		return "", fmt.Errorf("BashGate executable path is invalid")
	}
	return executable, nil
}
