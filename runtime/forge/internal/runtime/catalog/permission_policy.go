package catalog

import "strings"

// PermissionAdapter selects how a client consumes the neutral Forge policy.
type PermissionAdapter string

const (
	PermissionAdapterNone      PermissionAdapter = "none"
	PermissionAdapterClaude    PermissionAdapter = "claude"
	PermissionAdapterCodeBuddy PermissionAdapter = "codebuddy"
	PermissionAdapterCodex     PermissionAdapter = "codex"
	PermissionAdapterOpenCode  PermissionAdapter = "opencode"
	PermissionAdapterGrok      PermissionAdapter = "grok"
	PermissionAdapterDSH       PermissionAdapter = "dsh"
)

// EnvDSHPermissionMode is the environment variable carrying the DSH
// permission value.
const EnvDSHPermissionMode = "DSH_PERMISSION_MODE"

// Tools is the orthogonal neutral tool result. Builtin is expressed only in
// AccessKind values; Cap and MCP are capability-pack contributions.
type Tools struct {
	Builtin []AccessKind
	Cap     []string
	MCP     []string
}

// BashGate keeps source-owned builtin rules separate from capability rules.
type BashGate struct {
	Builtin []BashRule
	Cap     []BashRule
}

// PermissionPolicy is the adapter-independent source of truth for a Forge
// permission mode.
type PermissionPolicy struct {
	Mode             PermissionMode
	Tools            Tools
	BashGate         BashGate
	BashEnabled      bool
	BashUnrestricted bool
	CodexSandbox     string
	ApprovalPolicy   string
	CodexBypass      bool
}

const defaultCodexApprovalPolicy = "never"

func readonlyPolicy() PermissionPolicy {
	return PermissionPolicy{
		Mode:           PermissionReadonly,
		Tools:          Tools{Builtin: []AccessKind{AccessRead, AccessWebSearch}},
		BashGate:       BashGate{Builtin: cloneBashRules(readonlyBashRules)},
		BashEnabled:    true,
		CodexSandbox:   "read-only",
		ApprovalPolicy: defaultCodexApprovalPolicy,
	}
}

func editPolicy() PermissionPolicy {
	readonly := readonlyPolicy()
	return PermissionPolicy{
		Mode: PermissionEdit,
		Tools: Tools{Builtin: []AccessKind{
			AccessRead, AccessWebSearch, AccessEdit,
		}},
		BashGate:       BashGate{Builtin: append(cloneBashRules(readonly.BashGate.Builtin), editOnlyBashRules...)},
		BashEnabled:    true,
		CodexSandbox:   "workspace-write",
		ApprovalPolicy: readonly.ApprovalPolicy,
	}
}

func yoloPolicy() PermissionPolicy {
	return PermissionPolicy{
		Mode: PermissionYolo,
		Tools: Tools{Builtin: []AccessKind{
			AccessRead, AccessWebSearch, AccessEdit, AccessAgent,
		}},
		BashEnabled:      true,
		BashUnrestricted: true,
		CodexSandbox:     "danger-full-access",
		ApprovalPolicy:   defaultCodexApprovalPolicy,
		CodexBypass:      true,
	}
}

// PolicyFor returns a defensive copy. Unknown modes return an empty policy.
func PolicyFor(mode PermissionMode) PermissionPolicy {
	var policy PermissionPolicy
	switch mode {
	case PermissionReadonly:
		policy = readonlyPolicy()
	case PermissionEdit:
		policy = editPolicy()
	case PermissionYolo:
		policy = yoloPolicy()
	default:
		return PermissionPolicy{Mode: mode}
	}
	policy.Tools.Builtin = append([]AccessKind(nil), policy.Tools.Builtin...)
	policy.Tools.Cap = cloneStrings(policy.Tools.Cap)
	policy.Tools.MCP = cloneStrings(policy.Tools.MCP)
	policy.BashGate.Builtin = cloneBashRules(policy.BashGate.Builtin)
	policy.BashGate.Cap = cloneBashRules(policy.BashGate.Cap)
	return policy
}

// DSHPermissionMode maps a neutral Forge permission mode to the DSH
// DSH_PERMISSION_MODE value: read-only, workspace-write, danger-full-access.
// It reuses the existing per-mode sandbox policy values. Unknown modes return
// an empty string.
func DSHPermissionMode(mode PermissionMode) string {
	return PolicyFor(mode).CodexSandbox
}

// DSHPermissionEnv returns the DSH_PERMISSION_MODE KEY=VALUE pair for mode.
func DSHPermissionEnv(mode PermissionMode) string {
	return EnvDSHPermissionMode + "=" + DSHPermissionMode(mode)
}

// EncodePermissionArgs preserves the established Claude/CodeBuddy shape for
// callers without capability packs. The richer driver encoder merges resolved
// capability contributions at its adapter boundary.
func EncodePermissionArgs(adapter PermissionAdapter, mode PermissionMode) []string {
	if mode == PermissionYolo {
		switch adapter {
		case PermissionAdapterClaude:
			return []string{"--dangerously-skip-permissions"}
		case PermissionAdapterCodeBuddy:
			return []string{"-y"}
		default:
			return nil
		}
	}
	if mode != PermissionReadonly && mode != PermissionEdit {
		return nil
	}
	if adapter != PermissionAdapterClaude && adapter != PermissionAdapterCodeBuddy {
		return nil
	}
	args, err := EncodeClaudeFamilyPermission(adapter, PolicyFor(mode))
	if err != nil {
		return nil
	}
	return args
}

// EncodeClaudeFamilyPermission expands the neutral policy through a concrete
// registry, then emits the established Claude-family flag ordering.
func EncodeClaudeFamilyPermission(adapter PermissionAdapter, policy PermissionPolicy) ([]string, error) {
	if err := ValidateCapabilityBashRules(policy.BashGate.Cap); err != nil {
		return nil, err
	}
	tools, err := ExpandBuiltinTools(adapter, policy.Tools.Builtin, policy.BashEnabled)
	if err != nil {
		return nil, err
	}
	externalTools, err := EncodeExternalCapabilityToolIDs(adapter, policy.Tools.Cap)
	if err != nil {
		return nil, err
	}
	tools = appendUniqueStrings(tools, externalTools...)
	args := []string{"--permission-mode", "dontAsk", "--tools=" + strings.Join(tools, ","), "--allowedTools"}
	editIDs, err := encodableKindIDs(adapter, AccessEdit)
	if err != nil {
		return nil, err
	}
	if containsAccessKind(policy.Tools.Builtin, AccessEdit) {
		args = append(args, editIDs...)
	}
	for _, rule := range append(cloneBashRules(policy.BashGate.Builtin), policy.BashGate.Cap...) {
		args = append(args, EncodeBashRule(rule))
	}
	args = append(args, "--disallowedTools")
	for _, rule := range claudeFamilyRestrictedBashDenies() {
		args = append(args, EncodeBashRule(rule))
	}
	return args, nil
}

// Claude and CodeBuddy receive a fail-closed per-run BashGate hook. Their
// native Bash(*&*) glob also matches safe && chains, so the neutral gate owns
// ampersand parsing and rejects a single background operator while preserving
// chains whose every segment is allowed.
func claudeFamilyRestrictedBashDenies() []BashRule {
	denies := make([]BashRule, 0, len(BashDenyRules))
	for _, rule := range BashDenyRules {
		if rule.Pattern != "*&*" && !sharedGuardOwnsNativeDeny(rule) {
			denies = append(denies, rule)
		}
	}
	return denies
}

func encodableKindIDs(adapter PermissionAdapter, kind AccessKind) ([]string, error) {
	registry, err := BuiltinRegistry(adapter)
	if err != nil {
		return nil, err
	}
	var ids []string
	for _, entry := range registry {
		if entry.Kind != kind {
			continue
		}
		if !entry.Encodable {
			return nil, &unencodableBuiltinError{id: entry.ID, adapter: adapter}
		}
		ids = append(ids, entry.ID)
	}
	return ids, nil
}

type unencodableBuiltinError struct {
	id      string
	adapter PermissionAdapter
}

func (e *unencodableBuiltinError) Error() string {
	return "builtin tool " + e.id + " for permission adapter " + string(e.adapter) + " is not safely encodable"
}

func CodexApprovalPolicy(mode PermissionMode) string {
	if approval := PolicyFor(mode).ApprovalPolicy; approval != "" {
		return approval
	}
	return defaultCodexApprovalPolicy
}

func CodexPermissionArgs(mode PermissionMode) []string {
	policy := PolicyFor(mode)
	if policy.ApprovalPolicy == "" {
		return nil
	}
	args := []string{"-c", "approval_policy=" + policy.ApprovalPolicy}
	if policy.CodexBypass {
		args = append(args, "--dangerously-bypass-approvals-and-sandbox")
	}
	return args
}

func containsAccessKind(values []AccessKind, want AccessKind) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}

func appendUniqueStrings(base []string, values ...string) []string {
	seen := map[string]bool{}
	for _, value := range base {
		seen[value] = true
	}
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value != "" && !seen[value] {
			seen[value] = true
			base = append(base, value)
		}
	}
	return base
}

func cloneStrings(values []string) []string {
	return append([]string(nil), values...)
}

func containsString(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}
