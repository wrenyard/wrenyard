package catalog

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestClaudeFamilyExternalCapabilityIDsRejectEveryRegisteredBuiltin(t *testing.T) {
	for _, adapter := range []PermissionAdapter{PermissionAdapterClaude, PermissionAdapterCodeBuddy} {
		registry, err := BuiltinRegistry(adapter)
		if err != nil {
			t.Fatal(err)
		}
		for _, builtin := range registry {
			if _, err := EncodeExternalCapabilityToolIDs(adapter, []string{builtin.ID}); err == nil || !strings.Contains(err.Error(), "collides with a client-owned builtin") {
				t.Errorf("%s builtin %q was not rejected: %v", adapter, builtin.ID, err)
			}
		}
		if _, err := EncodeExternalCapabilityToolIDs(adapter, []string{"teamcreate"}); err == nil {
			t.Fatalf("%s case-variant builtin collision was not rejected", adapter)
		}
		encoded, err := EncodeExternalCapabilityToolIDs(adapter, []string{"ExternalReader", "ExternalReader", "vendor.tool:search"})
		if err != nil || len(encoded) != 2 || encoded[0] != "ExternalReader" || encoded[1] != "vendor.tool:search" {
			t.Fatalf("%s safe external ids = %v err=%v", adapter, encoded, err)
		}
	}
}

func TestOpenCodeBashPermissionBecomesBroadOnlyAfterFailClosedBootstrap(t *testing.T) {
	policy := PolicyFor(PermissionReadonly)
	config, err := EncodeOpenCodePermissionConfig(policy)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{`"*":"allow"`, `"pwd":"allow"`, `"find *":"allow"`} {
		if !strings.Contains(config, want) {
			t.Fatalf("active OpenCode Bash permission missing %s: %s", want, config)
		}
	}
	for _, removed := range []string{`"*\u0026\u0026*":"deny"`, `"*;*":"deny"`, `"*|*":"deny"`, `"*\r*":"deny"`, `"*\n*":"deny"`} {
		if strings.Contains(config, removed) {
			t.Fatalf("active OpenCode Bash permission retained blanket separator denial %s: %s", removed, config)
		}
	}
	bootstrap, err := EncodeOpenCodeBootstrapPermissionConfig(policy)
	if err != nil {
		t.Fatal(err)
	}
	if openCodeBashAllows(t, bootstrap, "pwd") || openCodeBashAllows(t, bootstrap, "pwd ; rg forge") {
		t.Fatalf("OpenCode bootstrap permission did not deny Bash: %s", bootstrap)
	}
}

func TestRestrictedNativeEncodersDenyExecutablePowerShellExpressions(t *testing.T) {
	unsafe := []string{
		"Get-ChildItem | where { Remove-Item marker }",
		"Get-ChildItem (Remove-Item marker)",
		"Get-ChildItem | (Remove-Item marker)",
		"Get-ChildItem $(Remove-Item marker)",
		"Get-ChildItem @(Remove-Item marker)",
		"Get-ChildItem | & { Remove-Item marker }",
	}
	safe := []string{
		"Get-ChildItem",
		"Get-ChildItem -Name",
		"Get-Content go.mod",
		"Select-String -Pattern forge go.mod",
		"where.exe go.exe",
	}

	for _, mode := range []PermissionMode{PermissionReadonly, PermissionEdit} {
		policy := PolicyFor(mode)
		for _, adapter := range []PermissionAdapter{PermissionAdapterClaude, PermissionAdapterCodeBuddy} {
			args, err := EncodeClaudeFamilyPermission(adapter, policy)
			if err != nil {
				t.Fatal(err)
			}
			assertEncodedBashBehavior(t, string(adapter)+" "+string(mode), unsafe, safe, func(command string) bool {
				return claudeFamilyBashAllows(args, command)
			})
		}

		grokArgs, err := EncodeGrokPermissionArgs(policy, nil, nil, "windows")
		if err != nil {
			t.Fatal(err)
		}
		assertEncodedBashBehavior(t, "grok "+string(mode), unsafe, safe, func(command string) bool {
			return grokBashAllows(grokArgs, command)
		})

		// OpenCode's active native permission is deliberately broad only after
		// plugin readiness; the same neutral policy used by BashGate owns these
		// complete-command decisions.
		assertEncodedBashBehavior(t, "opencode BashGate "+string(mode), unsafe, safe, func(command string) bool {
			return BashAllowed(policy, command)
		})
	}

	yoloConfig, err := EncodeOpenCodePermissionConfig(PolicyFor(PermissionYolo))
	if err != nil {
		t.Fatal(err)
	}
	if !openCodeBashAllows(t, yoloConfig, unsafe[0]) {
		t.Fatal("OpenCode yolo config must remain unrestricted")
	}
}

func TestCapabilityBashGrammarRejectsBroadOrParsedPatternsBeforeEncoding(t *testing.T) {
	invalid := []string{
		"*", "foo*", "foo * bar", "foo * *", "foo **",
		"foo | bar", "foo && bar", "foo > out", "foo < in", "foo;bar",
		"foo $(bar)", "foo `bar`", "foo %PATH%", "foo (bar)", "foo {bar}",
		"foo \"bar\"", "foo 'bar'", "foo\\ bar", "foo ?", "foo [ab]",
		"foo\tbar", "foo\nbar", " foo", "foo ", "foo  bar", ".", "-foo arg",
	}
	for _, pattern := range invalid {
		t.Run(pattern, func(t *testing.T) {
			rule := BashRule{Pattern: pattern}
			if err := ValidateCapabilityBashRule(rule); err == nil || !strings.Contains(err.Error(), "unsafe capability Bash rule") {
				t.Fatalf("grammar accepted %q: %v", pattern, err)
			}
			for _, mode := range []PermissionMode{PermissionReadonly, PermissionEdit, PermissionYolo} {
				policy := PolicyFor(mode)
				policy.BashGate.Cap = []BashRule{rule}
				for _, adapter := range []PermissionAdapter{PermissionAdapterClaude, PermissionAdapterCodeBuddy} {
					if args, err := EncodeClaudeFamilyPermission(adapter, policy); err == nil || len(args) != 0 {
						t.Errorf("%s %s encoded invalid rule %q: args=%v err=%v", adapter, mode, pattern, args, err)
					}
				}
				if args, err := EncodeGrokPermissionArgs(policy, nil, []BashRule{rule}, "windows"); err == nil || len(args) != 0 {
					t.Errorf("Grok %s encoded invalid rule %q: args=%v err=%v", mode, pattern, args, err)
				}
				if config, err := EncodeOpenCodePermissionConfig(policy); err == nil || config != "" {
					t.Errorf("OpenCode %s encoded invalid rule %q: config=%q err=%v", mode, pattern, config, err)
				}
			}
		})
	}
}

func TestCapabilityBashGrammarSafeRulesAuthorizeOnlyTheirDeclaredScope(t *testing.T) {
	cases := []struct {
		pattern string
		allow   string
		deny    string
	}{
		{pattern: "notesmd-cli *", allow: "notesmd-cli list", deny: "other-cli list"},
		{pattern: "notesmd-cli list", allow: "notesmd-cli list", deny: "notesmd-cli delete"},
		{pattern: "tool --format=json /safe/path", allow: "tool --format=json /safe/path", deny: "tool --format=json /other/path"},
	}
	for _, tc := range cases {
		t.Run(tc.pattern, func(t *testing.T) {
			rule := BashRule{Pattern: tc.pattern}
			if err := ValidateCapabilityBashRule(rule); err != nil {
				t.Fatal(err)
			}
			policy := PolicyFor(PermissionReadonly)
			policy.BashGate.Cap = []BashRule{rule}
			if !BashAllowed(policy, tc.allow) || BashAllowed(policy, tc.deny) {
				t.Fatalf("rule %q decisions: allow(%q)=%v deny(%q)=%v", tc.pattern, tc.allow, BashAllowed(policy, tc.allow), tc.deny, BashAllowed(policy, tc.deny))
			}
		})
	}
}

func TestGitHistoryBashGateDeniedWithoutPackInReadonly(t *testing.T) {
	policy := PolicyFor(PermissionReadonly)
	for _, command := range []string{
		"git --no-optional-locks log --oneline HEAD",
		"git --no-optional-locks log HEAD",
		"git --no-optional-locks show --name-only HEAD",
		"git --no-optional-locks show --stat HEAD",
		"git --no-optional-locks show HEAD",
	} {
		if BashAllowed(policy, command) {
			t.Errorf("readonly without git-history allowed git history command %q", command)
		}
	}
}

func TestGitHistoryBashGateAuthorizesOnlyDocumentedShapes(t *testing.T) {
	policy := PolicyFor(PermissionReadonly)
	policy.BashGate.Cap = []BashRule{
		{Pattern: "git --no-optional-locks log --oneline *"},
		{Pattern: "git --no-optional-locks show --name-only *"},
		{Pattern: "git --no-optional-locks show --stat *"},
	}

	allowed := []string{
		"git --no-optional-locks log --oneline -5",
		"git --no-optional-locks log --oneline HEAD..HEAD~3",
		"git --no-optional-locks log --oneline --all",
		"git --no-optional-locks log --oneline --author=alice",
		"git --no-optional-locks show --name-only HEAD",
		"git --no-optional-locks show --name-only HEAD -- go.mod",
		"git --no-optional-locks show --stat HEAD~1",
		"git --no-optional-locks show --stat HEAD -- internal/forge/config.go",
	}
	for _, command := range allowed {
		if !BashAllowed(policy, command) {
			t.Errorf("git-history readonly denied documented safe shape %q", command)
		}
	}

	denied := []string{
		// Generic log/show without the documented option shape.
		"git --no-optional-locks log HEAD",
		"git --no-optional-locks log -5",
		"git --no-optional-locks log --oneline",
		"git --no-optional-locks show HEAD",
		"git --no-optional-locks show --patch HEAD",
		"git --no-optional-locks show --name-only",
		"git --no-optional-locks show --stat",
		"git log --oneline HEAD",
		"git show --name-only HEAD",
		// Diff/patch content.
		"git diff",
		"git --no-optional-locks diff --stat",
		"git --no-optional-locks diff HEAD HEAD~1",
		// Unsafe output and external-processing options.
		"git --no-optional-locks log --oneline HEAD --output=history.txt",
		"git --no-optional-locks log --oneline HEAD --output history.txt",
		"git --no-optional-locks show --name-only HEAD --ext-diff",
		"git --no-optional-locks show --name-only HEAD --textconv",
		"git --no-optional-locks show --stat HEAD --show-signature",
		"git --no-optional-locks show --stat HEAD --open-files-in-pager",
		"git --no-optional-locks log --oneline HEAD --recurse-submodules",
		// Repository mutation and arbitrary subcommands.
		"git --no-optional-locks commit -m bump",
		"git --no-optional-locks push",
		"git --no-optional-locks checkout HEAD -- internal/forge/config.go",
		"git --no-optional-locks reset --hard HEAD",
		// Compound commands and redirection that mix in a denied segment.
		"git --no-optional-locks log --oneline HEAD && git --no-optional-locks push",
		"git --no-optional-locks log --oneline HEAD ; rm -rf .",
		"git --no-optional-locks log --oneline HEAD | git push",
		"git --no-optional-locks show --name-only HEAD > list.txt",
	}
	for _, command := range denied {
		if BashAllowed(policy, command) {
			t.Errorf("git-history readonly allowed unsafe command %q", command)
		}
	}
}

func assertEncodedBashBehavior(t *testing.T, adapter string, unsafe, safe []string, allows func(string) bool) {
	t.Helper()
	for _, command := range unsafe {
		if allows(command) {
			t.Errorf("%s encoded policy allowed executable PowerShell expression %q", adapter, command)
		}
	}
	for _, command := range safe {
		if !allows(command) {
			t.Errorf("%s encoded policy rejected safe read command %q", adapter, command)
		}
	}
}

func claudeFamilyBashAllows(args []string, command string) bool {
	var allows, denies []string
	section := ""
	for _, arg := range args {
		switch arg {
		case "--allowedTools":
			section = "allow"
			continue
		case "--disallowedTools":
			section = "deny"
			continue
		}
		pattern, ok := encodedBashPattern(arg)
		if !ok {
			continue
		}
		if section == "allow" {
			allows = append(allows, pattern)
		} else if section == "deny" {
			denies = append(denies, pattern)
		}
	}
	return bashRuleSetAllows(allows, denies, command)
}

func grokBashAllows(args []string, command string) bool {
	var allows, denies []string
	for i := 0; i+1 < len(args); i++ {
		pattern, ok := encodedBashPattern(args[i+1])
		if !ok {
			continue
		}
		switch args[i] {
		case "--allow":
			allows = append(allows, pattern)
		case "--deny":
			denies = append(denies, pattern)
		}
	}
	return bashRuleSetAllows(allows, denies, command)
}

func encodedBashPattern(value string) (string, bool) {
	if !strings.HasPrefix(value, "Bash(") || !strings.HasSuffix(value, ")") {
		return "", false
	}
	return strings.TrimSuffix(strings.TrimPrefix(value, "Bash("), ")"), true
}

func bashRuleSetAllows(allows, denies []string, command string) bool {
	allowed := false
	for _, pattern := range allows {
		if bashWildcardMatch(pattern, command) {
			allowed = true
			break
		}
	}
	if !allowed {
		return false
	}
	for _, pattern := range denies {
		if bashWildcardMatch(pattern, command) {
			return false
		}
	}
	return true
}

func openCodeBashAllows(t *testing.T, config, command string) bool {
	t.Helper()
	var document struct {
		Permission map[string]json.RawMessage `json:"permission"`
	}
	if err := json.Unmarshal([]byte(config), &document); err != nil {
		t.Fatalf("decode OpenCode permission config: %v", err)
	}
	decoder := json.NewDecoder(strings.NewReader(string(document.Permission["bash"])))
	if token, err := decoder.Token(); err != nil || token != json.Delim('{') {
		t.Fatalf("decode OpenCode Bash rules: token=%v err=%v", token, err)
	}
	decision := ""
	for decoder.More() {
		key, err := decoder.Token()
		if err != nil {
			t.Fatalf("decode OpenCode Bash rule key: %v", err)
		}
		var value string
		if err := decoder.Decode(&value); err != nil {
			t.Fatalf("decode OpenCode Bash rule value: %v", err)
		}
		if bashWildcardMatch(key.(string), command) {
			decision = value
		}
	}
	return decision == "allow"
}

func bashWildcardMatch(pattern, value string) bool {
	patternIndex, valueIndex := 0, 0
	starIndex, starValueIndex := -1, -1
	for valueIndex < len(value) {
		switch {
		case patternIndex < len(pattern) && pattern[patternIndex] == value[valueIndex]:
			patternIndex++
			valueIndex++
		case patternIndex < len(pattern) && pattern[patternIndex] == '*':
			starIndex = patternIndex
			starValueIndex = valueIndex
			patternIndex++
		case starIndex >= 0:
			patternIndex = starIndex + 1
			starValueIndex++
			valueIndex = starValueIndex
		default:
			return false
		}
	}
	for patternIndex < len(pattern) && pattern[patternIndex] == '*' {
		patternIndex++
	}
	return patternIndex == len(pattern)
}
