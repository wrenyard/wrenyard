package driver

import (
	"fmt"
	"runtime"
	"strings"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/catalog"
)

// cursorPermissionArgs maps the neutral Forge permission boundary onto Cursor
// Agent CLI args for the given platform. Cursor Agent 2026.08.25 on native
// Windows rejects --sandbox enabled before model execution, so read-only keeps
// plan mode but runs unsandboxed, and edit is refused instead of being
// silently downgraded to an unsandboxed workspace write. Non-Windows mappings
// come straight from the catalog and are unchanged.
func cursorPermissionArgs(profile string, mode catalog.PermissionMode, goos string) ([]string, error) {
	if goos != "windows" {
		return catalog.CursorPermissionArgs(mode), nil
	}
	switch mode {
	case catalog.PermissionReadonly:
		return []string{"--mode", "plan", "--force", "--sandbox", "disabled"}, nil
	case catalog.PermissionYolo:
		return []string{"--force", "--sandbox", "disabled"}, nil
	default:
		return nil, fmt.Errorf("profile %q: permission mode %q requires --sandbox enabled, which Cursor Agent on Windows rejects before model execution; use readonly or yolo instead", profile, mode)
	}
}

// buildCursorPlan plans a Cursor agent invocation through the canonical
// cursor-agent executable. The generic "agent" command belongs to Grok on this
// host and is never resolved for Cursor. The plan launches a non-interactive
// stream-json run with the resolved CURSOR_MODEL, applies the neutral Forge
// permission boundary as CLI args, injects the Desktop token only through the
// CURSOR_AUTH_TOKEN child env, and resumes a prior session by native id.
// Capability packs are rejected: Cursor cannot safely encode external tool,
// MCP, or Bash capability contributions.
func buildCursorPlan(req PlanRequest) (CommandPlan, error) {
	spec := req.Spec
	if len(req.Capabilities) > 0 {
		return CommandPlan{}, fmt.Errorf("profile %q uses client family %q, which does not support capability packs", spec.Name, "cursor")
	}

	binary, err := ResolveBinary(spec.ClientDesc.Binary)
	if err != nil {
		return CommandPlan{}, err
	}

	model := strings.TrimSpace(spec.Env[catalog.EnvCursorModel])
	if model == "" {
		return CommandPlan{}, fmt.Errorf("profile %q has no Cursor wire model", spec.Name)
	}

	permissionArgs, err := cursorPermissionArgs(spec.Name, req.Permission, runtime.GOOS)
	if err != nil {
		return CommandPlan{}, err
	}

	command := append([]string(nil), binary...)
	command = append(command, permissionArgs...)
	command = append(command, "-p", "--output-format", "stream-json", "--trust", "--model", model)
	if resumeID := strings.TrimSpace(req.ResumeSessionID); resumeID != "" {
		command = append(command, spec.ClientDesc.ResumeFlag, resumeID)
	}

	env := map[string]string{"FORGE_PROFILE": spec.Name}
	for key, value := range spec.Env {
		env[key] = value
	}
	for key, value := range spec.Runtime.Env {
		env[key] = value
	}
	// Desktop token travels only through the child env, never argv. The value
	// is sensitive and must never be formatted into errors or logs.
	if spec.CredentialValue != "" {
		env["CURSOR_AUTH_TOKEN"] = spec.CredentialValue
	}

	return CommandPlan{
		ProfileName: spec.Name,
		Dialect:     catalog.DialectCursor,
		Command:     command,
		Env:         env,
		Stdin:       strings.NewReader(req.Prompt),
		WorkDir:     req.WorkDir,
		Permission:  req.Permission,
	}, nil
}
