package catalog

import (
	"fmt"
	"strings"
)

// AccessKind is the client-neutral classification of a Forge-managed builtin
// tool. Bash is deliberately not an AccessKind: it is a separately marked
// builtin slot whose command content is governed by BashGate.
type AccessKind string

const (
	AccessRead      AccessKind = "Read"
	AccessEdit      AccessKind = "Edit"
	AccessWebSearch AccessKind = "WebSearch"
	AccessAgent     AccessKind = "Agent"
)

// BuiltinTool is one source-anchored entry in a client family's builtin tool
// registry. ID is the downstream CLI identifier. Exactly one of Kind or Bash
// is set. Encodable is false when the tool is known but that client's CLI has
// no safe explicit allowlist encoding for it.
type BuiltinTool struct {
	ID            string
	Kind          AccessKind
	Bash          bool
	Encodable     bool
	Orchestration bool
	Source        string
}

var builtinToolRegistries = map[PermissionAdapter][]BuiltinTool{
	PermissionAdapterClaude: {
		{ID: "Read", Kind: AccessRead, Encodable: true, Source: "Claude Code --tools contract, Forge 0.7.12 characterization"},
		{ID: "Bash", Bash: true, Encodable: true, Source: "Claude Code --tools contract, Forge 0.7.12 characterization"},
		{ID: "Edit", Kind: AccessEdit, Encodable: true, Source: "Claude Code --tools contract, Forge 0.7.12 characterization"},
		{ID: "Write", Kind: AccessEdit, Encodable: true, Source: "Claude Code --tools contract, Forge 0.7.12 characterization"},
		{ID: "Glob", Kind: AccessRead, Encodable: true, Source: "Claude Code --tools contract, Forge 0.7.12 characterization"},
		{ID: "Grep", Kind: AccessRead, Encodable: true, Source: "Claude Code --tools contract, Forge 0.7.12 characterization"},
		{ID: "WebSearch", Kind: AccessWebSearch, Encodable: true, Source: "Claude Code builtin tool contract, 2026-07"},
		{ID: "EnterPlanMode", Kind: AccessAgent, Encodable: false, Orchestration: true, Source: "Claude Code orchestration tool; intentionally outside neutral Agent encoding, 2026-07"},
		{ID: "Agent", Kind: AccessAgent, Encodable: true, Orchestration: true, Source: "Claude Code builtin tool contract, 2026-07"},
		{ID: "TeamCreate", Kind: AccessAgent, Encodable: false, Orchestration: true, Source: "Claude Code orchestration tool; intentionally outside neutral Agent encoding, 2026-07"},
		{ID: "TeamDelete", Kind: AccessAgent, Encodable: false, Orchestration: true, Source: "Claude Code orchestration tool; intentionally outside neutral Agent encoding, 2026-07"},
		{ID: "SendMessage", Kind: AccessAgent, Encodable: false, Orchestration: true, Source: "Claude Code orchestration tool; intentionally outside neutral Agent encoding, 2026-07"},
	},
	PermissionAdapterCodeBuddy: {
		{ID: "Read", Kind: AccessRead, Encodable: true, Source: "CodeBuddy Code --tools contract, Forge 0.7.12 characterization"},
		{ID: "Bash", Bash: true, Encodable: true, Source: "CodeBuddy Code --tools contract, Forge 0.7.12 characterization"},
		{ID: "Edit", Kind: AccessEdit, Encodable: true, Source: "CodeBuddy Code --tools contract, Forge 0.7.12 characterization"},
		{ID: "Write", Kind: AccessEdit, Encodable: true, Source: "CodeBuddy Code --tools contract, Forge 0.7.12 characterization"},
		{ID: "Glob", Kind: AccessRead, Encodable: true, Source: "CodeBuddy Code --tools contract, Forge 0.7.12 characterization"},
		{ID: "Grep", Kind: AccessRead, Encodable: true, Source: "CodeBuddy Code --tools contract, Forge 0.7.12 characterization"},
		{ID: "WebSearch", Kind: AccessWebSearch, Encodable: true, Source: "CodeBuddy Code builtin tool contract, 2026-07"},
		{ID: "EnterPlanMode", Kind: AccessAgent, Encodable: false, Orchestration: true, Source: "CodeBuddy orchestration tool; intentionally outside neutral Agent encoding, 2026-07"},
		{ID: "Agent", Kind: AccessAgent, Encodable: true, Orchestration: true, Source: "CodeBuddy Code builtin tool contract, 2026-07"},
		{ID: "TeamCreate", Kind: AccessAgent, Encodable: false, Orchestration: true, Source: "CodeBuddy orchestration tool; intentionally outside neutral Agent encoding, 2026-07"},
		{ID: "TeamDelete", Kind: AccessAgent, Encodable: false, Orchestration: true, Source: "CodeBuddy orchestration tool; intentionally outside neutral Agent encoding, 2026-07"},
		{ID: "SendMessage", Kind: AccessAgent, Encodable: false, Orchestration: true, Source: "CodeBuddy orchestration tool; intentionally outside neutral Agent encoding, 2026-07"},
	},
	PermissionAdapterCodex: {
		{ID: "read_file", Kind: AccessRead, Encodable: false, Source: "Codex native sandbox/tool contract, Forge 0.7.12 characterization"},
		{ID: "shell", Bash: true, Encodable: false, Source: "Codex native sandbox/tool contract, Forge 0.7.12 characterization"},
		{ID: "apply_patch", Kind: AccessEdit, Encodable: false, Source: "Codex native sandbox/tool contract, Forge 0.7.12 characterization"},
		{ID: "web_search", Kind: AccessWebSearch, Encodable: false, Source: "Codex native --search contract, Forge 0.7.12 characterization"},
		{ID: "spawn_agent", Kind: AccessAgent, Encodable: false, Source: "Codex native collaboration contract, 2026-07"},
	},
	PermissionAdapterOpenCode: {
		{ID: "read", Kind: AccessRead, Encodable: true, Source: "OpenCode 1.17.11 per-run permission config and builtin probe, 2026-07-21"},
		{ID: "glob", Kind: AccessRead, Encodable: true, Source: "OpenCode 1.17.11 per-run permission config and builtin probe, 2026-07-21"},
		{ID: "grep", Kind: AccessRead, Encodable: true, Source: "OpenCode 1.17.11 per-run permission config and builtin probe, 2026-07-21"},
		{ID: "bash", Bash: true, Encodable: true, Source: "OpenCode 1.17.11 per-run permission config and builtin probe, 2026-07-21"},
		{ID: "edit", Kind: AccessEdit, Encodable: true, Source: "OpenCode 1.17.11 per-run permission schema, 2026-07-21"},
		{ID: "write", Kind: AccessEdit, Encodable: true, Source: "OpenCode 1.17.11 per-run permission schema, 2026-07-21"},
		{ID: "webfetch", Kind: AccessWebSearch, Encodable: true, Source: "OpenCode 1.17.11 per-run permission config and builtin probe, 2026-07-21"},
		{ID: "websearch", Kind: AccessWebSearch, Encodable: true, Source: "OpenCode 1.17.11 per-run permission schema, 2026-07-21"},
		{ID: "task", Kind: AccessAgent, Encodable: true, Source: "OpenCode 1.17.11 per-run permission config and builtin probe, 2026-07-21"},
	},
	PermissionAdapterGrok: {
		{ID: "read_file", Kind: AccessRead, Encodable: true, Source: "Grok Build 0.2.106 (bde89716f6) builtin probe, 2026-07-21"},
		{ID: "list_dir", Kind: AccessRead, Encodable: true, Source: "Grok Build 0.2.106 (bde89716f6) headless tool table, 2026-07-21"},
		{ID: "grep", Kind: AccessRead, Encodable: true, Source: "Grok Build 0.2.106 (bde89716f6) headless tool table, 2026-07-21"},
		{ID: "run_terminal_cmd", Bash: true, Encodable: true, Source: "Grok Build 0.2.106 (bde89716f6) headless tool table and live allowlist probe, 2026-07-21"},
		{ID: "search_replace", Kind: AccessEdit, Encodable: true, Source: "Grok Build 0.2.106 (bde89716f6) builtin probe, 2026-07-21"},
		{ID: "web_search", Kind: AccessWebSearch, Encodable: true, Source: "Grok Build 0.2.106 (bde89716f6) builtin probe, 2026-07-21"},
		{ID: "web_fetch", Kind: AccessWebSearch, Encodable: true, Source: "Grok Build 0.2.106 (bde89716f6) builtin probe, 2026-07-21"},
		{ID: "spawn_subagent", Kind: AccessAgent, Encodable: true, Orchestration: true, Source: "Grok Build 0.2.106 (bde89716f6) installed user guide and hook alias contract, 2026-07-22"},
		{ID: "write_file", Kind: AccessEdit, Encodable: false, Source: "Grok Build 0.2.106 unresolved --tools probe; excluded fail-closed, 2026-07-21"},
		{ID: "delete_file", Kind: AccessEdit, Encodable: false, Source: "Grok Build 0.2.106 unresolved --tools probe; excluded fail-closed, 2026-07-21"},
		{ID: "apply_patch", Kind: AccessEdit, Encodable: false, Source: "Grok Build 0.2.106 unresolved --tools probe; excluded fail-closed, 2026-07-21"},
	},
}

// BuiltinRegistry returns a defensive copy of the explicit registry for an
// active headless client family.
func BuiltinRegistry(adapter PermissionAdapter) ([]BuiltinTool, error) {
	entries, ok := builtinToolRegistries[adapter]
	if !ok {
		return nil, fmt.Errorf("no builtin tool registry for permission adapter %q", adapter)
	}
	return append([]BuiltinTool(nil), entries...), nil
}

// ExpandBuiltinTools expands neutral access kinds and the independent Bash
// slot in registry order. Unknown kinds and known-but-unencodable entries fail
// closed; no caller needs to scatter downstream tool identifiers.
func ExpandBuiltinTools(adapter PermissionAdapter, kinds []AccessKind, bash bool) ([]string, error) {
	registry, err := BuiltinRegistry(adapter)
	if err != nil {
		return nil, err
	}
	wanted := make(map[AccessKind]bool, len(kinds))
	for _, kind := range kinds {
		switch kind {
		case AccessRead, AccessEdit, AccessWebSearch, AccessAgent:
			wanted[kind] = true
		default:
			return nil, fmt.Errorf("unknown builtin access kind %q", kind)
		}
	}
	seenKinds := map[AccessKind]bool{}
	bashSeen := false
	var ids []string
	for _, entry := range registry {
		selected := entry.Bash && bash || entry.Kind != "" && wanted[entry.Kind]
		if !selected {
			continue
		}
		if !entry.Encodable {
			continue
		}
		if strings.TrimSpace(entry.ID) == "" {
			return nil, fmt.Errorf("builtin tool for permission adapter %q has an empty downstream id", adapter)
		}
		ids = append(ids, entry.ID)
		if entry.Bash {
			bashSeen = true
		} else {
			seenKinds[entry.Kind] = true
		}
	}
	for kind := range wanted {
		if !seenKinds[kind] {
			return nil, fmt.Errorf("permission adapter %q has no builtin tool for access kind %q", adapter, kind)
		}
	}
	if bash && !bashSeen {
		return nil, fmt.Errorf("permission adapter %q has no builtin Bash tool slot", adapter)
	}
	return ids, nil
}

// EncodeRegisteredToolIDs validates explicit downstream ids against a client
// registry. It is used for pack-provided ids and tests the same fail-closed
// boundary: unknown and known-but-unencodable ids are errors.
func EncodeRegisteredToolIDs(adapter PermissionAdapter, ids []string) ([]string, error) {
	registry, err := BuiltinRegistry(adapter)
	if err != nil {
		return nil, err
	}
	byID := map[string]BuiltinTool{}
	for _, entry := range registry {
		byID[entry.ID] = entry
	}
	var out []string
	for _, id := range ids {
		entry, ok := byID[id]
		if !ok {
			return nil, fmt.Errorf("unknown builtin tool %q for permission adapter %q", id, adapter)
		}
		if !entry.Encodable {
			return nil, fmt.Errorf("builtin tool %q for permission adapter %q is not safely encodable", id, adapter)
		}
		out = append(out, id)
	}
	return out, nil
}

// EncodeExternalCapabilityToolIDs validates capability tool ids for clients
// whose native allowlist accepts external tool identifiers. Every id owned by
// the builtin registry is rejected, independent of its encodability or whether
// the active permission mode selected it; builtin access is controlled only by
// the neutral policy.
func EncodeExternalCapabilityToolIDs(adapter PermissionAdapter, ids []string) ([]string, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	if adapter != PermissionAdapterClaude && adapter != PermissionAdapterCodeBuddy {
		return nil, fmt.Errorf("permission adapter %q cannot safely encode external capability tool ids", adapter)
	}
	registry, err := BuiltinRegistry(adapter)
	if err != nil {
		return nil, err
	}
	builtin := make(map[string]bool, len(registry))
	for _, entry := range registry {
		builtin[strings.ToLower(entry.ID)] = true
	}
	seen := map[string]bool{}
	out := make([]string, 0, len(ids))
	for _, rawID := range ids {
		id := strings.TrimSpace(rawID)
		if !validNativeToolID(id) {
			return nil, fmt.Errorf("capability tool id %q is not safely encodable for permission adapter %q", rawID, adapter)
		}
		if builtin[strings.ToLower(id)] {
			return nil, fmt.Errorf("capability tool id %q collides with a client-owned builtin for permission adapter %q", id, adapter)
		}
		if !seen[id] {
			seen[id] = true
			out = append(out, id)
		}
	}
	return out, nil
}

func validNativeToolID(id string) bool {
	if id == "" || strings.ContainsAny(id, ",\r\n\t ") {
		return false
	}
	for _, r := range id {
		if !((r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || strings.ContainsRune("_.:-", r)) {
			return false
		}
	}
	return true
}

// HeadlessOrchestrationDenials derives the mode-specific native denial list
// from the builtin registry. Restricted modes deny every orchestration entry;
// yolo permits only safely encodable entries selected by its neutral policy.
func HeadlessOrchestrationDenials(adapter PermissionAdapter, mode PermissionMode) []string {
	registry, ok := builtinToolRegistries[adapter]
	if !ok {
		return nil
	}
	policy := PolicyFor(mode)
	var denied []string
	for _, entry := range registry {
		if !entry.Orchestration {
			continue
		}
		if !entry.Encodable || !containsAccessKind(policy.Tools.Builtin, entry.Kind) {
			denied = append(denied, entry.ID)
		}
	}
	return denied
}
