package catalog

import (
	"fmt"
	"strings"
)

var restrictedBashDeny = []BashRule{
	{Pattern: "npm"}, {Pattern: "npm *"},
	{Pattern: "npx"}, {Pattern: "npx *"},
	{Pattern: "pnpm"}, {Pattern: "pnpm *"},
	{Pattern: "yarn"}, {Pattern: "yarn *"},
	{Pattern: "bun"}, {Pattern: "bun *"},
	{Pattern: "powershell *"}, {Pattern: "pwsh *"}, {Pattern: "cmd *"},
	{Pattern: "bash *"}, {Pattern: "sh *"},
}

// EncodeGrokPermissionArgs expands only verified Grok builtin ids and emits
// the confirmed Grok Build 0.2.106 headless permission contract. The current
// neutral Tools.cap schema has no client-owned external-tool encodability
// metadata, so Grok rejects nonempty capTools rather than passing unresolved ids
// to its fail-open allowlist. capBash remains safely adapter-encoded; MCP is
// handled separately by the driver and fails closed because this CLI exposes no
// per-run MCP config flag.
func EncodeGrokPermissionArgs(policy PermissionPolicy, capTools []string, capBash []BashRule, goos string) ([]string, error) {
	effectiveBashAllow, err := EffectiveBashAllow(policy, capBash)
	if err != nil {
		return nil, err
	}
	tools, err := ExpandBuiltinTools(PermissionAdapterGrok, policy.Tools.Builtin, policy.BashEnabled)
	if err != nil {
		return nil, err
	}
	if err := rejectGrokCapabilityTools(tools, capTools); err != nil {
		return nil, err
	}

	var args []string
	switch policy.Mode {
	case PermissionReadonly:
		args = append(args, "--permission-mode", "dontAsk")
	case PermissionEdit:
		args = append(args, "--permission-mode", "acceptEdits", "--always-approve")
	case PermissionYolo:
		args = append(args, "--permission-mode", "bypassPermissions", "--always-approve")
	default:
		return nil, fmt.Errorf("unsupported Grok permission mode %q", policy.Mode)
	}
	args = append(args, "--tools", strings.Join(tools, ","))

	if !policy.BashUnrestricted {
		for _, rule := range effectiveBashAllow {
			args = append(args, "--allow", EncodeBashRule(rule))
		}

		denies := grokRestrictedBashDenies()
		denies = append(denies, restrictedBashDeny...)
		if policy.Mode == PermissionReadonly {
			denies = append(denies, editOnlyBashRules...)
		}
		for _, rule := range denies {
			if strings.TrimSpace(rule.Pattern) == "*" {
				return nil, fmt.Errorf("refusing unsafe Grok Bash deny-all rule")
			}
			args = append(args, "--deny", EncodeBashRule(rule))
		}
	}

	if complement := grokBuiltinComplement(tools); len(complement) > 0 {
		args = append(args, "--disallowed-tools", strings.Join(complement, ","))
	}
	switch policy.Mode {
	case PermissionReadonly:
		if goos == "linux" {
			args = append(args, "--sandbox", "read-only")
		}
	case PermissionEdit:
		args = append(args, "--sandbox", "workspace")
	case PermissionYolo:
		args = append(args, "--sandbox", "off")
	}
	return args, nil
}

// grokRestrictedBashDenies retains the neutral defense-in-depth rules except
// for the single overbroad native glob that also matches safe && chains. The
// per-run PreToolUse guard parses compound commands segment by segment and
// rejects a background single ampersand before Grok can execute it.
func grokRestrictedBashDenies() []BashRule {
	denies := make([]BashRule, 0, len(BashDenyRules))
	for _, rule := range BashDenyRules {
		if rule.Pattern == "*&*" || sharedGuardOwnsNativeDeny(rule) {
			continue
		}
		denies = append(denies, rule)
	}
	return denies
}

func grokBuiltinComplement(selected []string) []string {
	selectedSet := map[string]bool{}
	for _, id := range selected {
		selectedSet[id] = true
	}
	registry, _ := BuiltinRegistry(PermissionAdapterGrok)
	var complement []string
	for _, entry := range registry {
		if entry.Encodable && !selectedSet[entry.ID] {
			complement = appendUniqueStrings(complement, entry.ID)
		}
	}
	return complement
}

func rejectGrokCapabilityTools(selected, capTools []string) error {
	if len(capTools) == 0 {
		return nil
	}
	registry, err := BuiltinRegistry(PermissionAdapterGrok)
	if err != nil {
		return err
	}
	byID := make(map[string]BuiltinTool, len(registry))
	for _, entry := range registry {
		byID[entry.ID] = entry
	}
	for _, rawID := range capTools {
		id := strings.TrimSpace(rawID)
		if entry, ok := byID[id]; ok {
			if !entry.Encodable {
				return fmt.Errorf("Grok capability tool id %q collides with a builtin that is not safely encodable", rawID)
			}
			if !containsString(selected, id) {
				return fmt.Errorf("Grok capability tool id %q would elevate a builtin disabled by the permission mode", rawID)
			}
			return fmt.Errorf("Grok capability tool id %q collides with a client-owned builtin", rawID)
		}
		if id == "" {
			return fmt.Errorf("Grok capability tool id %q is empty and cannot be safely encoded", rawID)
		}
		return fmt.Errorf("Grok capability tool id %q is unknown; external Tools.cap entries cannot be proven safely encodable by the current capability schema", rawID)
	}
	return nil
}
