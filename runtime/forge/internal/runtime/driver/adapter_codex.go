package driver

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"strings"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/catalog"
)

const codexWindowsSandboxElevatedConfig = `windows.sandbox="elevated"`

const (
	CodexMCPSubcommand = "__codex-mcp-bash"
	CodexMCPServerName = "forge_bash"
	CodexMCPToolName   = "bash"
)

// CodexAppServerSubcommand is Forge's hidden per-run Codex app-server bridge.
// Every Codex run and resume is driven through it: the bridge owns the Codex
// app-server JSON-RPC transport and `codex exec` is never an alternative path.
const CodexAppServerSubcommand = "__codex-app-server"

// codexBridgeArgs renders the bridge argv accepted by the hidden
// CodexAppServerSubcommand entrypoint. Bridge flags are limited to --model,
// --sandbox, --resume, --output-last-message, --strict-config, --search,
// `-c key=value` overrides, and a trailing `-` marking a stdin prompt.
func codexBridgeArgs(a *CodexAdapter, resumeID, outputLastMessage string, opts CommandOptions) []string {
	// sandbox is deliberately placed first: plan_codex.go injects capability
	// and gateway `-c` overrides directly before the bridge invocation, so
	// putting the bridge first keeps every override ahead of the bridge flags.
	args := []string{CodexAppServerSubcommand, "--sandbox", a.sandboxForPermission(opts)}
	if strings.TrimSpace(a.Model) != "" {
		args = append(args, "--model", a.Model)
	}
	if effort := strings.TrimSpace(a.ReasoningEffort); effort != "" {
		args = append(args, "-c", "model_reasoning_effort="+tomlString(effort))
	}
	// The bridge speaks only sandbox/approval config: an approval mode with no
	// request surface is already satisfied by the bridge's unattended
	// "never" policy and must never be passed through as a CLI switch.
	if catalog.CodexApprovalPolicy(opts.Permission) != "never" {
		args = append(args, "-c", "approval_policy="+tomlString(catalog.CodexApprovalPolicy(opts.Permission)))
	}
	if resumeID != "" {
		args = append(args, "--resume", resumeID)
	}
	if outputLastMessage != "" {
		args = append(args, "--output-last-message", outputLastMessage)
	}
	// Always strict-config: user config must not interfere with automated runs.
	args = append(args, "--strict-config", "--search")
	args = append(args, codexToolFeatureArgs(opts.Permission)...)
	if windowsSandboxArgs := buildCodexWindowsSandboxArgs(opts, runtime.GOOS); len(windowsSandboxArgs) > 0 {
		args = append(args, windowsSandboxArgs...)
	}
	return append(args, "-")
}

type CodexAdapter struct {
	Model           string
	ReasoningEffort string
	Sandbox         string
}

func (a *CodexAdapter) BuildRunCommand(profile string, prompt string, workDir string, opts CommandOptions) *exec.Cmd {
	return a.BuildRunCommandWithLastMessage(profile, prompt, workDir, "", opts)
}

func (a *CodexAdapter) BuildRunCommandWithLastMessage(profile string, prompt string, workDir string, outputLastMessage string, opts CommandOptions) *exec.Cmd {
	return newCodexBridgeCommand(codexBridgeArgs(a, "", outputLastMessage, opts), prompt, workDir)
}

func (a *CodexAdapter) BuildResumeCommand(profile string, nativeSessionID string, prompt string, workDir string, opts CommandOptions) *exec.Cmd {
	return newCodexBridgeCommand(codexBridgeArgs(a, nativeSessionID, "", opts), prompt, workDir)
}

// newCodexBridgeCommand launches the bridge through the current Forge
// executable, exactly as the MCP bridge is launched. The prompt travels on
// stdin and the working directory is preserved on the child process.
func newCodexBridgeCommand(args []string, prompt string, workDir string) *exec.Cmd {
	executable, err := os.Executable()
	if err != nil {
		executable = "forge"
	}
	cmd := exec.Command(executable, args...)
	cmd.Dir = workDir
	cmd.Stdin = strings.NewReader(prompt)
	return cmd
}

func codexToolFeatureArgs(mode catalog.PermissionMode) []string {
	enabled := mode == catalog.PermissionYolo
	value := "false"
	if enabled {
		value = "true"
	}
	return []string{
		"-c", "features.shell_tool=" + value,
		"-c", "features.multi_agent=" + value,
	}
}

func tomlString(value string) string {
	data, _ := json.Marshal(value)
	return string(data)
}

func tomlStringArray(values []string) string {
	data, _ := json.Marshal(values)
	return string(data)
}

// sandboxForPermission consumes the neutral catalog policy for recognized
// modes. An unset permission retains the adapter's configured sandbox and an
// unknown mode retains the historical workspace-write fallback.
func (a *CodexAdapter) sandboxForPermission(opts CommandOptions) string {
	if opts.Permission == "" {
		if a.Sandbox != "" {
			return a.Sandbox
		}
		return "workspace-write"
	}
	if sandbox := catalog.PolicyFor(opts.Permission).CodexSandbox; sandbox != "" {
		return sandbox
	}
	return "workspace-write"
}

func (a *CodexAdapter) ParseSessionID(logPath string) (string, error) {
	events, err := readJSONLFile(logPath)
	if err != nil {
		return "", err
	}

	for _, event := range events {
		typ, hasType := getString(event, "type")
		if !hasType || typ != "thread.started" {
			continue
		}
		sessionID, hasSessionID := getString(event, "thread_id")
		if hasSessionID {
			return sessionID, nil
		}
	}

	return "", fmt.Errorf("no thread id found in %s", logPath)
}

func (a *CodexAdapter) ParseResult(logPath string) (string, error) {
	events, err := readJSONLFile(logPath)
	if err != nil {
		return "", err
	}

	result := ""
	for _, event := range events {
		typ, hasType := getString(event, "type")
		if !hasType || typ != "item.completed" {
			continue
		}

		item, ok := event["item"].(map[string]any)
		if !ok {
			continue
		}

		itemType, hasItemType := getString(item, "type")
		if !hasItemType || itemType != "agent_message" {
			continue
		}
		if text, ok := getString(item, "text"); ok {
			result = strings.TrimSpace(text)
			continue
		}

		if content, hasContent := getString(item, "content"); hasContent {
			result = strings.TrimSpace(content)
		}
	}

	return result, nil
}

func buildCodexWindowsSandboxArgs(opts CommandOptions, goos string) []string {
	if goos != "windows" || opts.Permission != catalog.PermissionEdit {
		return nil
	}
	return []string{"-c", codexWindowsSandboxElevatedConfig}
}
