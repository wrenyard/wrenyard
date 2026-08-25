package driver

import (
	"fmt"
	"strings"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/catalog"
)

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

	command := append([]string(nil), binary...)
	command = append(command, catalog.CursorPermissionArgs(req.Permission)...)
	command = append(command, "-p", "--output-format", "stream-json", "--trust", "--model", model)
	if resumeID := strings.TrimSpace(req.ResumeSessionID); resumeID != "" {
		command = append(command, spec.ClientDesc.ResumeFlag, resumeID)
	}
	command = append(command, req.Prompt)

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
		WorkDir:     req.WorkDir,
		Permission:  req.Permission,
	}, nil
}
