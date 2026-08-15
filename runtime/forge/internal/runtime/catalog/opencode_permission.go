package catalog

import (
	"bytes"
	"encoding/json"
	"fmt"
)

// EncodeOpenCodePermissionConfig emits the active verified OpenCode per-run
// permission config. Restricted Bash becomes natively runnable only after the
// isolated plugin has proven BashGate ready; BashGate remains authoritative for
// the complete command. Unknown non-Bash native or plugin tools fail closed.
func EncodeOpenCodePermissionConfig(policy PermissionPolicy) (string, error) {
	return encodeOpenCodePermissionConfig(policy, false)
}

// EncodeOpenCodeBootstrapPermissionConfig emits the configuration loaded before
// external plugins. Restricted Bash is an unconditional native deny so a plugin
// load or config-hook failure cannot fall through to command execution.
func EncodeOpenCodeBootstrapPermissionConfig(policy PermissionPolicy) (string, error) {
	return encodeOpenCodePermissionConfig(policy, true)
}

// EncodeOpenCodeBashPermission returns the exact Bash permission object that a
// successfully initialized per-run plugin installs after its readiness check.
func EncodeOpenCodeBashPermission(policy PermissionPolicy) (string, error) {
	entries, err := openCodeBashPermissionEntries(policy, false)
	if err != nil {
		return "", err
	}
	var out bytes.Buffer
	writeOpenCodeJSONObject(&out, entries)
	return out.String(), nil
}

func encodeOpenCodePermissionConfig(policy PermissionPolicy, bootstrap bool) (string, error) {
	if err := ValidateCapabilityBashRules(policy.BashGate.Cap); err != nil {
		return "", err
	}
	switch policy.Mode {
	case PermissionReadonly, PermissionEdit, PermissionYolo:
	default:
		return "", fmt.Errorf("unsupported OpenCode permission mode %q", policy.Mode)
	}
	if len(policy.Tools.Cap) > 0 {
		return "", fmt.Errorf("OpenCode cannot safely encode external capability tool ids")
	}

	tools, err := ExpandBuiltinTools(PermissionAdapterOpenCode, policy.Tools.Builtin, policy.BashEnabled)
	if err != nil {
		return "", err
	}
	registry, err := BuiltinRegistry(PermissionAdapterOpenCode)
	if err != nil {
		return "", err
	}
	bashID := ""
	for _, entry := range registry {
		if entry.Bash {
			bashID = entry.ID
			break
		}
	}
	if policy.BashEnabled && bashID == "" {
		return "", fmt.Errorf("OpenCode builtin Bash permission is not registered")
	}

	permissionEntries := []openCodeJSONEntry{{Key: "*", Value: "deny"}}
	for _, tool := range tools {
		if tool == bashID {
			continue
		}
		permissionEntries = append(permissionEntries, openCodeJSONEntry{Key: tool, Value: "allow"})
	}
	if policy.BashEnabled {
		bashEntries, bashErr := openCodeBashPermissionEntries(policy, bootstrap)
		if bashErr != nil {
			return "", bashErr
		}
		permissionEntries = append(permissionEntries, openCodeJSONEntry{Key: bashID, Object: bashEntries})
	}

	var out bytes.Buffer
	out.WriteString(`{"permission":`)
	writeOpenCodeJSONObject(&out, permissionEntries)
	out.WriteByte('}')
	return out.String(), nil
}

func openCodeBashPermissionEntries(policy PermissionPolicy, bootstrap bool) ([]openCodeJSONEntry, error) {
	if err := ValidateCapabilityBashRules(policy.BashGate.Cap); err != nil {
		return nil, err
	}
	if bootstrap && !policy.BashUnrestricted {
		return []openCodeJSONEntry{{Key: "*", Value: "deny"}}, nil
	}
	// Once BashGate has passed its readiness check, OpenCode must not reduce a
	// complete safe chain merely because its native glob engine sees one string.
	// Keep the neutral grants in the active map for exact policy observability;
	// the leading wildcard lets BashGate decide every complete command.
	entries := []openCodeJSONEntry{{Key: "*", Value: "allow"}}
	for _, rule := range append(cloneBashRules(policy.BashGate.Builtin), policy.BashGate.Cap...) {
		entries = appendUniqueOpenCodeEntry(entries, rule.Pattern, "allow")
	}
	return entries, nil
}

type openCodeJSONEntry struct {
	Key    string
	Value  string
	Object []openCodeJSONEntry
}

func appendUniqueOpenCodeEntry(entries []openCodeJSONEntry, key, value string) []openCodeJSONEntry {
	for i := range entries {
		if entries[i].Key == key {
			entries[i].Value = value
			return entries
		}
	}
	return append(entries, openCodeJSONEntry{Key: key, Value: value})
}

func writeOpenCodeJSONObject(out *bytes.Buffer, entries []openCodeJSONEntry) {
	out.WriteByte('{')
	for i, entry := range entries {
		if i > 0 {
			out.WriteByte(',')
		}
		key, _ := json.Marshal(entry.Key)
		out.Write(key)
		out.WriteByte(':')
		if entry.Object != nil {
			writeOpenCodeJSONObject(out, entry.Object)
			continue
		}
		value, _ := json.Marshal(entry.Value)
		out.Write(value)
	}
	out.WriteByte('}')
}
