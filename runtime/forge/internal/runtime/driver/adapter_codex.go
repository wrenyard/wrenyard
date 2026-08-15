package driver

import (
	"encoding/json"
	"fmt"
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

type CodexAdapter struct {
	Model           string
	ReasoningEffort string
	Sandbox         string
}

func (a *CodexAdapter) BuildRunCommand(profile string, prompt string, workDir string, opts CommandOptions) *exec.Cmd {
	return a.BuildRunCommandWithLastMessage(profile, prompt, workDir, "", opts)
}

func (a *CodexAdapter) BuildRunCommandWithLastMessage(profile string, prompt string, workDir string, outputLastMessage string, opts CommandOptions) *exec.Cmd {
	effort := a.reasoningEffort()
	sandbox := a.sandboxForPermission(opts)
	args := []string{
		"--search",
		"exec",
		"--strict-config",
		"-c", "approval_policy=\"" + catalog.CodexApprovalPolicy(opts.Permission) + "\"",
		"-c", "model_reasoning_effort=\"" + effort + "\"",
		"--model", a.Model,
		"--json",
		"--sandbox", sandbox,
		"--skip-git-repo-check",
	}
	// Always ignore user config to prevent workspace-level skills from interfering with automated task execution.
	args = append(args, "--ignore-user-config")
	args = append(args, codexToolFeatureArgs(opts.Permission)...)
	if windowsSandboxArgs := buildCodexWindowsSandboxArgs(opts, runtime.GOOS); len(windowsSandboxArgs) > 0 {
		args = append(args, windowsSandboxArgs...)
	}
	if permissionArgs := catalog.CodexPermissionArgs(opts.Permission); len(permissionArgs) > 0 {
		args = append(args, permissionArgs...)
	}
	if outputLastMessage != "" {
		args = append(args, "--output-last-message", outputLastMessage)
	}
	args = append(args, "-")

	cmd := exec.Command("codex", args...)
	cmd.Dir = workDir
	cmd.Stdin = strings.NewReader(prompt)
	return cmd
}

func (a *CodexAdapter) BuildResumeCommand(profile string, nativeSessionID string, prompt string, workDir string, opts CommandOptions) *exec.Cmd {
	effort := a.reasoningEffort()
	sandbox := a.sandboxForPermission(opts)
	args := []string{
		"--search",
		"exec", "resume", nativeSessionID,
		"--strict-config",
		"-c", "approval_policy=\"" + catalog.CodexApprovalPolicy(opts.Permission) + "\"",
		"-c", "model_reasoning_effort=\"" + effort + "\"",
		"-c", fmt.Sprintf("sandbox_mode=\"%s\"", sandbox),
		"--model", a.Model,
		"--json",
		"--skip-git-repo-check",
	}
	// Always ignore user config to prevent workspace-level skills from interfering with automated task execution.
	args = append(args, "--ignore-user-config")
	args = append(args, codexToolFeatureArgs(opts.Permission)...)
	if windowsSandboxArgs := buildCodexWindowsSandboxArgs(opts, runtime.GOOS); len(windowsSandboxArgs) > 0 {
		args = append(args, windowsSandboxArgs...)
	}
	if permissionArgs := catalog.CodexPermissionArgs(opts.Permission); len(permissionArgs) > 0 {
		args = append(args, permissionArgs...)
	}
	args = append(args, "-")
	cmd := exec.Command("codex", args...)
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

func (a *CodexAdapter) reasoningEffort() string {
	effort := strings.TrimSpace(a.ReasoningEffort)
	if effort == "" {
		return "xhigh"
	}
	return effort
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
