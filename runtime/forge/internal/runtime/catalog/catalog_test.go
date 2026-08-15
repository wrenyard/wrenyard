package catalog

import (
	"reflect"
	"sort"
	"strings"
	"testing"
)

func defaultReg() *Registry {
	return DefaultRegistry()
}

func TestRegistryLookupDescriptor(t *testing.T) {
	r := defaultReg()
	d, err := r.LookupDescriptor("claude")
	if err != nil {
		t.Fatal(err)
	}
	if d.Name != "claude" || d.Dialect != DialectClaudeCode {
		t.Fatalf("unexpected claude descriptor: %+v", d)
	}
	if d.DefaultProvider != "anthropic" {
		t.Fatalf("claude default provider = %q, want anthropic", d.DefaultProvider)
	}

	d, err = r.LookupDescriptor("codebuddy")
	if err != nil {
		t.Fatal(err)
	}
	if d.Name != "codebuddy" || d.Dialect != DialectCodeBuddy {
		t.Fatalf("unexpected codebuddy descriptor: %+v", d)
	}
	if d.DefaultProvider != "codebuddy" {
		t.Fatalf("codebuddy default provider = %q, want codebuddy", d.DefaultProvider)
	}
}

func TestRegistryLookupDescriptorUnknown(t *testing.T) {
	r := defaultReg()
	_, err := r.LookupDescriptor("nonexistent")
	if err == nil {
		t.Fatal("expected error for unknown descriptor")
	}
	for _, want := range []string{"unknown client descriptor", "nonexistent", "available: claude, codebuddy"} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("expected error to contain %q, got: %v", want, err)
		}
	}
}

func TestRegistryLookupBindingUnknown(t *testing.T) {
	r := defaultReg()
	_, err := r.LookupBinding("nonexistent")
	if err == nil {
		t.Fatal("expected error for unknown binding")
	}
	for _, want := range []string{"unknown provider binding", "nonexistent"} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("expected error to contain %q, got: %v", want, err)
		}
	}
}

func TestDialectCompatibilityValidation(t *testing.T) {
	r := defaultReg()
	// ResolveBinding with claude + anthropic should succeed (both claude-code).
	_, _, err := r.ResolveBinding("claude", "anthropic")
	if err != nil {
		t.Fatalf("claude + anthropic should be compatible: %v", err)
	}

	_, kimiBinding, err := r.ResolveBinding("claude", "kimi-coding")
	if err != nil {
		t.Fatalf("claude + kimi-coding should be compatible: %v", err)
	}
	if kimiBinding.QuotaProvider != "kimi-coding" {
		t.Fatalf("kimi-coding binding quota provider = %q, want kimi-coding", kimiBinding.QuotaProvider)
	}

	// ResolveBinding with codebuddy + codebuddy should succeed.
	_, _, err = r.ResolveBinding("codebuddy", "codebuddy")
	if err != nil {
		t.Fatalf("codebuddy + codebuddy should be compatible: %v", err)
	}

	// ResolveBinding without explicit binding should use default.
	_, b, err := r.ResolveBinding("claude", "")
	if err != nil {
		t.Fatalf("claude with default binding should resolve: %v", err)
	}
	if b.Name != "anthropic" {
		t.Fatalf("claude default binding = %q, want anthropic", b.Name)
	}

	_, b, err = r.ResolveBinding("codebuddy", "")
	if err != nil {
		t.Fatalf("codebuddy with default binding should resolve: %v", err)
	}
	if b.Name != "codebuddy" {
		t.Fatalf("codebuddy default binding = %q, want codebuddy", b.Name)
	}
}

func TestAPIKeyProvidersUseForgeManagedCredentials(t *testing.T) {
	r := defaultReg()
	for _, id := range []string{"kimi-coding", "zhipu-coding"} {
		provider, err := r.LookupBinding(id)
		if err != nil {
			t.Fatal(err)
		}
		if provider.Inference == nil || provider.Inference.CredentialResolver != CredentialResolverForgeManaged {
			t.Fatalf("provider %s credential resolver = %#v, want forge-managed", id, provider.Inference)
		}
	}
	for _, id := range []string{"codex", "codex-spark"} {
		provider, err := r.LookupBinding(id)
		if err != nil {
			t.Fatal(err)
		}
		if provider.Inference == nil || provider.Inference.CredentialResolver != CredentialResolverCodex {
			t.Fatalf("native provider %s must use codex credential resolver", id)
		}
	}
	// anthropic uses claude resolver.
	anthropic, err := r.LookupBinding("anthropic")
	if err != nil {
		t.Fatal(err)
	}
	if anthropic.Inference == nil || anthropic.Inference.CredentialResolver != CredentialResolverClaude {
		t.Fatalf("anthropic credential resolver = %#v, want claude", anthropic.Inference)
	}
	// codebuddy is a native client: no public inference transport, with the
	// CodeBuddy native auth file as its credential source.
	codebuddy, err := r.LookupBinding("codebuddy")
	if err != nil {
		t.Fatal(err)
	}
	if codebuddy.Inference != nil {
		t.Fatalf("codebuddy must not expose a public inference binding, got %#v", codebuddy.Inference)
	}
	if codebuddy.CredentialSource() != CredentialResolverCodeBuddy {
		t.Fatalf("codebuddy credential source = %q, want codebuddy", codebuddy.CredentialSource())
	}
	if !codebuddy.UsesClientBinary() {
		t.Fatalf("codebuddy must use the native client binary")
	}
}

func TestPermissionAdaptersCoverThreeModes(t *testing.T) {
	r := defaultReg()
	clients := []struct {
		name    string
		adapter PermissionAdapter
		yolo    []string
	}{
		{name: "claude", adapter: PermissionAdapterClaude, yolo: []string{"--dangerously-skip-permissions"}},
		{name: "codebuddy", adapter: PermissionAdapterCodeBuddy, yolo: []string{"-y"}},
		{name: "codex", adapter: PermissionAdapterCodex},
		{name: "opencode", adapter: PermissionAdapterOpenCode},
		{name: "grok", adapter: PermissionAdapterGrok},
	}
	modes := []PermissionMode{PermissionReadonly, PermissionEdit, PermissionYolo}

	for _, tc := range clients {
		t.Run(tc.name, func(t *testing.T) {
			d, err := r.LookupDescriptor(tc.name)
			if err != nil {
				t.Fatal(err)
			}
			if d.PermissionAdapter != tc.adapter {
				t.Fatalf("permission adapter = %q, want %q", d.PermissionAdapter, tc.adapter)
			}
			for _, mode := range modes {
				got := d.BuildPermissionArgs(mode)
				want := EncodePermissionArgs(tc.adapter, mode)
				if !reflect.DeepEqual(got, want) {
					t.Fatalf("BuildPermissionArgs(%s) = %#v, want %#v", mode, got, want)
				}
				if tc.name == "codex" && containsString(got, "--allowedTools") {
					t.Fatalf("codex must not emit allowedTools: %#v", got)
				}
			}
			if tc.yolo != nil && !reflect.DeepEqual(d.BuildPermissionArgs(PermissionYolo), tc.yolo) {
				t.Fatalf("yolo args = %#v, want %#v", d.BuildPermissionArgs(PermissionYolo), tc.yolo)
			}
		})
	}

	claude, _ := r.LookupDescriptor("claude")
	codebuddy, _ := r.LookupDescriptor("codebuddy")
	for _, mode := range []PermissionMode{PermissionReadonly, PermissionEdit} {
		if !reflect.DeepEqual(claude.BuildPermissionArgs(mode), codebuddy.BuildPermissionArgs(mode)) {
			t.Fatalf("Claude and CodeBuddy %s policies differ", mode)
		}
	}
}

func TestPermissionPolicyEditIsMonotonicSuperset(t *testing.T) {
	readonly := PolicyFor(PermissionReadonly)
	edit := PolicyFor(PermissionEdit)

	for _, kind := range readonly.Tools.Builtin {
		if !containsAccessKind(edit.Tools.Builtin, kind) {
			t.Fatalf("edit tools missing readonly kind %q: %#v", kind, edit.Tools.Builtin)
		}
	}
	for _, rule := range readonly.BashGate.Builtin {
		if !containsBashRule(edit.BashGate.Builtin, rule.Pattern) {
			t.Fatalf("edit allow rules missing readonly rule %q", rule.Pattern)
		}
	}
	if !containsAccessKind(edit.Tools.Builtin, AccessEdit) || containsAccessKind(readonly.Tools.Builtin, AccessEdit) {
		t.Fatalf("Edit kind must be edit-only: readonly=%v edit=%v", readonly.Tools.Builtin, edit.Tools.Builtin)
	}
	for _, policy := range []PermissionPolicy{readonly, edit, PolicyFor(PermissionYolo)} {
		if !policy.BashEnabled {
			t.Fatalf("Bash slot must be available in mode %s", policy.Mode)
		}
	}
}

func TestBashPolicyEvaluatesEveryCommandSegment(t *testing.T) {
	readonly := PolicyFor(PermissionReadonly)
	edit := PolicyFor(PermissionEdit)
	for _, command := range []string{
		"pwd && rg forge | head -n 2",
		"Get-ChildItem; Get-Content go.mod",
		"dir || git --no-optional-locks status",
	} {
		if !BashAllowed(readonly, command) {
			t.Fatalf("readonly command should be allowed segment-by-segment: %q", command)
		}
	}
	for _, command := range []string{
		"pwd && rm file",
		"rg forge | npm install",
		"Get-ChildItem; Remove-Item file",
		"cat $(whoami)",
		"dir & del file",
	} {
		if BashAllowed(readonly, command) {
			t.Fatalf("readonly command must reject any unsafe/disallowed segment: %q", command)
		}
	}
	if !BashAllowed(edit, "Get-ChildItem | Select-String forge; New-Item marker") {
		t.Fatal("edit should allow a chain when every segment is in its allowlist")
	}
	if BashAllowed(edit, "New-Item marker && npm install") {
		t.Fatal("npm must remain denied in edit")
	}
	if !BashAllowed(PolicyFor(PermissionYolo), "echo $HOME > result && cmd /c echo %PATH% `hostname`") {
		t.Fatal("yolo Bash should be genuinely unrestricted")
	}
}

func TestGitRmDeletionPolicyIsSingleOperandAndFailClosed(t *testing.T) {
	edit := PolicyFor(PermissionEdit)
	readonly := PolicyFor(PermissionReadonly)
	for _, command := range []string{
		"git rm -- notes.md",
		"git rm -- src/notes.md",
		"git rm -- ./notes.md",
	} {
		if !BashAllowed(edit, command) {
			t.Errorf("edit policy rejected valid single-path deletion %q", command)
		}
		if BashAllowed(readonly, command) {
			t.Errorf("readonly policy allowed deletion %q", command)
		}
	}
	for _, command := range []string{
		"git rm -- *",
		"git rm -- '*.md'",
		`git rm -- "*.md"`,
		"git rm -- src/[ab].md",
		"git rm -- a.md b.md",
		`git rm -- "notes file.md"`,
		`git rm -- notes\ file.md`,
		"git rm -- /abs/notes.md",
		"git rm -- ~/notes.md",
		"git rm -- C:/notes.md",
		`git rm -- \\server\share\notes.md`,
		"git rm -- .",
		"git rm -- ..",
		"git rm -- ../notes.md",
		"git rm -- notes/../x.md",
		"git rm -- notes.md/",
		"git rm -- src/",
		"git rm -- -f notes.md",
		"git rm -- -notes.md",
		"git rm --force notes.md",
		"git rm",
		"git rm --",
		"git rm -- notes.md && git rm -- other.md",
		"git rm -- notes.md ; git rm -- other.md",
		"git rm -- notes.md | cat",
		"git rm -- notes.md & sleep 1",
		"git rm -- $(echo notes.md)",
		"git rm -- notes.md > out.txt",
		"rm notes.md",
		"rm *",
		"del notes.md",
		"erase notes.md",
		"rmdir notes.md",
		"rd notes.md",
	} {
		if BashAllowed(edit, command) {
			t.Errorf("edit policy allowed unsafe deletion %q", command)
		}
	}
}

func TestBashPolicyBackslashSeparatorSemanticsArePlatformExplicit(t *testing.T) {
	readonly := PolicyFor(PermissionReadonly)
	windowsDenied := []string{
		`type harmless\| del victim`,
		`Get-Content harmless\; Remove-Item victim`,
		"type harmless\\\r\ndel victim",
		"Get-Content harmless\\\nRemove-Item victim",
	}
	for _, command := range windowsDenied {
		if BashAllowedForPlatform(readonly, command, "windows") {
			t.Errorf("Windows policy allowed backslash-prefixed separator: %q", command)
		}
	}
	for _, command := range []string{
		`Get-Content C:\workspace\harmless.txt`,
		`Get-Content "harmless|name"; Get-Content 'harmless-name'`,
	} {
		if !BashAllowedForPlatform(readonly, command, "windows") {
			t.Errorf("Windows policy rejected safe path or quoted separator: %q", command)
		}
	}
	if BashAllowedForPlatform(readonly, `Get-Content 'harmless;name'`, "windows") {
		t.Fatal("ambiguous Windows shell accepted a single-quoted separator")
	}
	if !BashAllowedForShell(readonly, `Get-Content 'harmless;name'`, BashShellPowerShell) {
		t.Fatal("explicit PowerShell policy rejected its single-quoted literal")
	}
	if BashAllowedForShell(readonly, `type 'harmless|name'`, BashShellCmd) {
		t.Fatal("explicit cmd policy treated single quotes as separator quoting")
	}

	posixAllowed := []string{
		`cat harmless\|name`,
		`cat harmless\;name`,
		`cat harmless\&name`,
		"cat harmless\\\nname",
	}
	for _, command := range posixAllowed {
		if !BashAllowedForPlatform(readonly, command, "linux") {
			t.Errorf("POSIX policy rejected valid backslash escaping: %q", command)
		}
	}
	if BashAllowedForPlatform(readonly, "pwd", "ambiguous-client-shell") {
		t.Fatal("restricted policy allowed a command for an ambiguous client shell")
	}
	if !BashAllowedForPlatform(PolicyFor(PermissionYolo), `anything\| still-trusted`, "ambiguous-client-shell") {
		t.Fatal("yolo lost its explicit unrestricted trust boundary")
	}
}

func TestRestrictedBashRejectsExecutablePowerShellExpressions(t *testing.T) {
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
		for _, command := range unsafe {
			if BashAllowed(policy, command) {
				t.Errorf("%s allowed executable PowerShell expression %q", mode, command)
			}
		}
		for _, command := range safe {
			if !BashAllowed(policy, command) {
				t.Errorf("%s rejected safe PowerShell read command %q", mode, command)
			}
		}
		if BashAllowed(policy, "where go.exe") {
			t.Errorf("%s allowed ambiguous PowerShell where alias", mode)
		}
	}
	if !BashAllowed(PolicyFor(PermissionYolo), unsafe[0]) {
		t.Fatal("yolo must remain unrestricted for executable PowerShell syntax")
	}
}

func TestRestrictedBashRejectsUnsafeReadCommandOptions(t *testing.T) {
	unsafe := []string{
		"find . -delete",
		`find . -exec echo {} \;`,
		`find . -execdir echo {} \;`,
		`find . -ok echo {} \;`,
		`find . -okdir echo {} \;`,
		"find . -fprint report.txt",
		"find . -fprint0 report.bin",
		`find . -fprintf report.txt "%p\\n"`,
		"find . -fls report.txt",
		"rg --pre cat forge .",
		"rg --pre=cat forge .",
		"rg --pre-glob '*.pdf' forge .",
		"rg --hostname-bin=hostname forge .",
		"rg -z forge archive.gz",
		"rg --search-zip forge archive.gz",
		"git --no-optional-locks diff --output=patch.txt",
		"git --no-optional-locks log --output history.txt",
		"git --no-optional-locks show HEAD --ext-diff",
		"git --no-optional-locks diff --textconv",
		"git --no-optional-locks log --show-signature",
		"git --no-optional-locks grep --open-files-in-pager forge",
		"git --no-optional-locks grep -Oless forge",
		"git --no-optional-locks grep -nOsh forge",
		"git --no-optional-locks grep --ext-grep forge",
		"git --no-optional-locks grep --recurse-submodules forge",
		"git --no-optional-locks diff --stat",
		"git --no-optional-locks log -n 3",
		"git --no-optional-locks show HEAD",
		"tree -o listing.txt",
		"tree -ao listing.txt",
		"tree -aolisting.txt",
		"file --compile",
		"file -C",
		"file -bCm ./magic",
		"file -bm./magic go.mod",
		"file --magic-file=./magic go.mod",
	}
	safe := []string{
		"find . -name '*.go' -print",
		"rg --no-pre forge internal",
		"rg forge internal",
		"git --no-optional-locks status --short",
		"git --no-optional-locks grep forge",
		"git --no-optional-locks grep -nH forge",
		"git --no-optional-locks grep -- --open-files-in-pager",
		"tree -L 2",
		"tree -aL 2 .",
		"tree --sort=name .",
		"tree -- -o-harmless-name",
		"file go.mod",
		"file -bi go.mod",
		"file --brief go.mod",
		"file -- --compile-harmless-name",
		"find . -name '*.go' -print | rg 'catalog' | head -n 2",
	}
	unsafeChains := []string{
		"git --no-optional-locks status && find . -delete",
		"rg forge internal | git --no-optional-locks diff --output=patch.txt",
		"find . -name '*.go' -print | rg --pre cat forge",
	}
	for _, mode := range []PermissionMode{PermissionReadonly, PermissionEdit} {
		policy := PolicyFor(mode)
		for _, command := range unsafe {
			if BashAllowed(policy, command) {
				t.Errorf("%s allowed unsafe command %q", mode, command)
			}
		}
		for _, command := range safe {
			if !BashAllowed(policy, command) {
				t.Errorf("%s rejected safe command %q", mode, command)
			}
		}
		for _, command := range unsafeChains {
			if BashAllowed(policy, command) {
				t.Errorf("%s allowed chain with unsafe segment %q", mode, command)
			}
		}
	}
}

func TestExecutableCaseFollowsVerifiedShellDialect(t *testing.T) {
	readonly := PolicyFor(PermissionReadonly)
	command := "cat harmless && CAT sentinel"
	if BashAllowedForShell(readonly, command, BashShellPOSIX) {
		t.Fatal("POSIX policy authorized a distinct executable differing only by case")
	}
	for _, dialect := range []BashShellDialect{BashShellCmd, BashShellPowerShell, BashShellWindowsAmbiguous} {
		if !BashAllowedForShell(readonly, command, dialect) {
			t.Errorf("verified case-insensitive Windows dialect %s rejected executable case variant", dialect)
		}
	}
}

func TestRestrictedAdaptersLeaveUnencodableOptionDecisionsToSharedGuard(t *testing.T) {
	ambiguousNativeDenies := []string{
		"Bash(find *-exec*)",
		"Bash(rg *--pre*)",
		"Bash(git *--output=*)",
		"Bash(tree *-o*)",
		"Bash(file *-C*)",
	}
	for _, adapter := range []PermissionAdapter{PermissionAdapterClaude, PermissionAdapterCodeBuddy} {
		for _, mode := range []PermissionMode{PermissionReadonly, PermissionEdit} {
			args, err := EncodeClaudeFamilyPermission(adapter, PolicyFor(mode))
			if err != nil {
				t.Fatal(err)
			}
			for _, deny := range ambiguousNativeDenies {
				if containsAfter(args, "--disallowedTools", deny) {
					t.Errorf("%s %s retained contradictory native deny %q: %v", adapter, mode, deny, args)
				}
			}
		}
	}
	for _, mode := range []PermissionMode{PermissionReadonly, PermissionEdit} {
		args, err := EncodeGrokPermissionArgs(PolicyFor(mode), nil, nil, "windows")
		if err != nil {
			t.Fatal(err)
		}
		for _, deny := range ambiguousNativeDenies {
			if hasFlagValue(args, "--deny", deny) {
				t.Errorf("Grok %s retained contradictory native deny %q: %v", mode, deny, args)
			}
		}
	}
	for _, safe := range []string{"tree harmless-o-name", "file harmless-C-name", "git --no-optional-locks grep harmless-O-pattern"} {
		if !BashAllowed(PolicyFor(PermissionReadonly), safe) {
			t.Errorf("shared guard rejected ordinary positional operand %q", safe)
		}
	}
}

func TestBuiltinRegistryExpansionAndFailClosedIDs(t *testing.T) {
	cases := []struct {
		adapter     PermissionAdapter
		unencodable string
	}{
		{PermissionAdapterClaude, "TeamCreate"},
		{PermissionAdapterCodeBuddy, "TeamCreate"},
		{PermissionAdapterCodex, "read_file"},
		{PermissionAdapterGrok, "write_file"},
	}
	for _, tc := range cases {
		t.Run(string(tc.adapter), func(t *testing.T) {
			registry, err := BuiltinRegistry(tc.adapter)
			if err != nil || len(registry) == 0 {
				t.Fatalf("registry missing: entries=%v err=%v", registry, err)
			}
			if _, err := EncodeRegisteredToolIDs(tc.adapter, []string{"forge-unknown-tool"}); err == nil {
				t.Fatal("unknown downstream id must fail closed")
			}
			if _, err := EncodeRegisteredToolIDs(tc.adapter, []string{tc.unencodable}); err == nil {
				t.Fatalf("known unsafe id %q must fail closed", tc.unencodable)
			}
			if _, err := ExpandBuiltinTools(tc.adapter, []AccessKind{"Unknown"}, true); err == nil {
				t.Fatal("unknown neutral access kind must fail closed")
			}
		})
	}
	for _, adapter := range []PermissionAdapter{PermissionAdapterClaude, PermissionAdapterCodeBuddy, PermissionAdapterOpenCode, PermissionAdapterGrok} {
		ids, err := ExpandBuiltinTools(adapter, []AccessKind{AccessRead, AccessWebSearch, AccessEdit, AccessAgent}, true)
		if err != nil || len(ids) == 0 {
			t.Fatalf("%s verified registry did not expand: ids=%v err=%v", adapter, ids, err)
		}
	}
}

func TestGrokPermissionArgvModesAndOrdering(t *testing.T) {
	cases := []struct {
		mode          PermissionMode
		wantMode      string
		wantTools     []string
		disallowAgent bool
	}{
		{PermissionReadonly, "dontAsk", []string{"read_file", "list_dir", "grep", "run_terminal_cmd", "web_search", "web_fetch"}, true},
		{PermissionEdit, "acceptEdits", []string{"read_file", "list_dir", "grep", "run_terminal_cmd", "search_replace", "web_search", "web_fetch"}, true},
		{PermissionYolo, "bypassPermissions", []string{"read_file", "list_dir", "grep", "run_terminal_cmd", "search_replace", "web_search", "web_fetch", "spawn_subagent"}, false},
	}
	for _, tc := range cases {
		t.Run(string(tc.mode), func(t *testing.T) {
			args, err := EncodeGrokPermissionArgs(PolicyFor(tc.mode), nil, nil, "windows")
			if err != nil {
				t.Fatal(err)
			}
			if len(args) < 4 || args[0] != "--permission-mode" || args[1] != tc.wantMode {
				t.Fatalf("permission prefix = %v, want --permission-mode %s", args, tc.wantMode)
			}
			toolValue := flagValue(args, "--tools")
			if !reflect.DeepEqual(strings.Split(toolValue, ","), tc.wantTools) {
				t.Fatalf("tools = %q, want %v", toolValue, tc.wantTools)
			}
			for _, unresolved := range []string{"write_file", "delete_file", "apply_patch"} {
				if containsString(strings.Split(toolValue, ","), unresolved) {
					t.Fatalf("unsafe unresolved id %q reached --tools: %v", unresolved, args)
				}
			}
			disallowed := strings.Split(flagValue(args, "--disallowed-tools"), ",")
			if containsString(disallowed, "spawn_subagent") != tc.disallowAgent {
				t.Fatalf("Agent complement mismatch: disallowed=%v", disallowed)
			}
			for i, arg := range args {
				if arg == "--deny" && i+1 < len(args) && args[i+1] == "Bash(*)" {
					t.Fatal("Grok must never receive --deny Bash(*)")
				}
			}
			if tc.mode == PermissionYolo {
				if containsString(args, "--allow") || containsString(args, "--deny") {
					t.Fatalf("yolo must not emit any Bash allow/deny rules: %v", args)
				}
			} else if !containsString(args, "--allow") || !containsString(args, "--deny") {
				t.Fatalf("restricted mode must retain complete Bash allow/deny encoding: %v", args)
			}
			if hasFlagValue(args, "--deny", "Bash(*&*)") {
				t.Fatalf("Grok restricted argv contains the overbroad ampersand deny: %v", args)
			}
			if tc.mode != PermissionYolo {
				policy := PolicyFor(tc.mode)
				if !BashAllowed(policy, "pwd && rg forge") {
					t.Fatal("Grok guard policy rejected a safe allowlisted && chain")
				}
				if BashAllowed(policy, "pwd & rg forge") {
					t.Fatal("Grok guard policy allowed a background single ampersand")
				}
			}
			if tc.mode == PermissionEdit && !containsString(args, "Bash(npm *)") {
				t.Fatalf("edit must explicitly deny npm: %v", args)
			}
			if tc.mode == PermissionEdit && flagValue(args, "--sandbox") != "workspace" {
				t.Fatalf("edit must use the Grok workspace sandbox profile: %v", args)
			}
		})
	}
}

func TestGrokCapabilityToolsFailClosedBeforeArgvConstruction(t *testing.T) {
	cases := []struct {
		name   string
		mode   PermissionMode
		toolID string
		want   string
	}{
		{name: "unknown external id", mode: PermissionReadonly, toolID: "external_reader", want: "unknown"},
		{name: "unencodable builtin", mode: PermissionEdit, toolID: "write_file", want: "not safely encodable"},
		{name: "enabled builtin collision", mode: PermissionReadonly, toolID: "read_file", want: "client-owned builtin"},
		{name: "edit elevation", mode: PermissionReadonly, toolID: "search_replace", want: "elevate"},
		{name: "agent elevation", mode: PermissionEdit, toolID: "spawn_subagent", want: "elevate"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			args, err := EncodeGrokPermissionArgs(PolicyFor(tc.mode), []string{tc.toolID}, nil, "windows")
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("tool %q error = %v, want text %q", tc.toolID, err, tc.want)
			}
			if len(args) != 0 {
				t.Fatalf("unsafe capability tool produced partial Grok argv: %v", args)
			}
		})
	}
}

func TestGrokLinuxSandboxProfilesUseInstalledCLIContract(t *testing.T) {
	cases := []struct {
		mode PermissionMode
		want string
	}{
		{PermissionReadonly, "read-only"},
		{PermissionEdit, "workspace"},
		{PermissionYolo, "off"},
	}
	for _, tc := range cases {
		args, err := EncodeGrokPermissionArgs(PolicyFor(tc.mode), nil, nil, "linux")
		if err != nil {
			t.Fatal(err)
		}
		if got := flagValue(args, "--sandbox"); got != tc.want {
			t.Fatalf("%s sandbox = %q, want %q: %v", tc.mode, got, tc.want, args)
		}
	}
}

func flagValue(args []string, flag string) string {
	for i, arg := range args {
		if arg == flag && i+1 < len(args) {
			return args[i+1]
		}
	}
	return ""
}

func containsBashRule(rules []BashRule, pattern string) bool {
	for _, rule := range rules {
		if rule.Pattern == pattern {
			return true
		}
	}
	return false
}

func containsAfter(args []string, boundary, want string) bool {
	seen := false
	for _, arg := range args {
		if arg == boundary {
			seen = true
			continue
		}
		if seen && arg == want {
			return true
		}
	}
	return false
}

func hasFlagValue(args []string, flag, want string) bool {
	for i := 0; i+1 < len(args); i++ {
		if args[i] == flag && args[i+1] == want {
			return true
		}
	}
	return false
}

func TestModelWhitelistAccept(t *testing.T) {
	b, err := defaultReg().LookupBinding("codebuddy")
	if err != nil {
		t.Fatal(err)
	}
	for _, model := range []string{"hunyuan-chat", "deepseek-v4-pro", "deepseek-v4-flash", "kimi-k2.6"} {
		if err := b.ValidateModel(model); err != nil {
			t.Fatalf("expected model %q to be allowed: %v", model, err)
		}
	}
}

func TestModelWhitelistReject(t *testing.T) {
	b, err := defaultReg().LookupBinding("codebuddy")
	if err != nil {
		t.Fatal(err)
	}
	for _, model := range []string{"claude-sonnet-4.6", "gpt-5.5", "gemini-3.5-flash", "glm-5.2"} {
		if err := b.ValidateModel(model); err == nil {
			t.Fatalf("expected model %q to be rejected", model)
		}
	}
}

func TestModelWhitelistEmptyAllowsAny(t *testing.T) {
	b, err := defaultReg().LookupBinding("anthropic")
	if err != nil {
		t.Fatal(err)
	}
	if err := b.ValidateModel("claude-opus-4.8"); err != nil {
		t.Fatalf("anthropic should allow any model: %v", err)
	}
	if err := b.ValidateModel("any-random-model"); err != nil {
		t.Fatalf("anthropic should allow any model: %v", err)
	}
}

func TestDialectFlagsFiltering(t *testing.T) {
	claudeD, err := defaultReg().LookupDescriptor("claude")
	if err != nil {
		t.Fatal(err)
	}
	claudeFlags := claudeD.FilterFlags([]string{"--verbose", "--bare", "--replay-user-messages"})
	if !reflect.DeepEqual(claudeFlags, []string{"--verbose", "--bare", "--replay-user-messages"}) {
		t.Fatalf("claude flags should keep all: %v", claudeFlags)
	}

	cbD, err := defaultReg().LookupDescriptor("codebuddy")
	if err != nil {
		t.Fatal(err)
	}
	cbFlags := cbD.FilterFlags([]string{"--verbose", "--bare", "--replay-user-messages"})
	if !reflect.DeepEqual(cbFlags, []string{"--replay-user-messages"}) {
		t.Fatalf("codebuddy flags should keep only --replay-user-messages: %v", cbFlags)
	}

	cbFlags2 := cbD.FilterFlags([]string{"--verbose", "--input-format", "stream-json", "--replay-user-messages"})
	if !reflect.DeepEqual(cbFlags2, []string{"--input-format", "stream-json", "--replay-user-messages"}) {
		t.Fatalf("non-dialect flags should pass through: %v", cbFlags2)
	}

	if got := cbD.FilterFlags(nil); got != nil {
		t.Fatalf("nil input should return nil: %v", got)
	}
}

func TestCodebuddyBinarySpec(t *testing.T) {
	d, err := defaultReg().LookupDescriptor("codebuddy")
	if err != nil {
		t.Fatal(err)
	}
	if d.Binary.Name != "codebuddy" {
		t.Fatalf("codebuddy binary name = %q", d.Binary.Name)
	}
	if d.Binary.WindowsCmd != "codebuddy.cmd" {
		t.Fatalf("codebuddy Windows cmd = %q, want codebuddy.cmd", d.Binary.WindowsCmd)
	}
}

func TestCodebuddyHygiene(t *testing.T) {
	d, err := defaultReg().LookupDescriptor("codebuddy")
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"DISABLE_AUTOUPDATER=1", "DISABLE_TELEMETRY=1", "DISABLE_ERROR_REPORTING=1"}
	if !reflect.DeepEqual(d.Hygiene, want) {
		t.Fatalf("codebuddy hygiene = %v, want %v", d.Hygiene, want)
	}
}

func TestCodebuddyConfigIsolation(t *testing.T) {
	d, err := defaultReg().LookupDescriptor("codebuddy")
	if err != nil {
		t.Fatal(err)
	}
	if d.ConfigIsolation.EnvVar != "CODEBUDDY_CONFIG_DIR" {
		t.Fatalf("codebuddy config env = %q", d.ConfigIsolation.EnvVar)
	}
	if d.ConfigIsolation.PersistentDir != "codebuddy/agent-config" {
		t.Fatalf("codebuddy persistent dir = %q", d.ConfigIsolation.PersistentDir)
	}
}

func TestCodebuddyDefaultProvider(t *testing.T) {
	d, err := defaultReg().LookupDescriptor("codebuddy")
	if err != nil {
		t.Fatal(err)
	}
	if d.DefaultProvider != "codebuddy" {
		t.Fatalf("codebuddy default provider = %q, want codebuddy", d.DefaultProvider)
	}
}

func TestClaudeClientDefaultProvider(t *testing.T) {
	d, err := defaultReg().LookupDescriptor("claude")
	if err != nil {
		t.Fatal(err)
	}
	if d.DefaultProvider != "anthropic" {
		t.Fatalf("claude default provider = %q, want anthropic", d.DefaultProvider)
	}
}

func TestDevelopmentChannelsDialectFlag(t *testing.T) {
	claudeD, err := defaultReg().LookupDescriptor("claude")
	if err != nil {
		t.Fatal(err)
	}
	if !claudeD.DialectFlags.SupportsDevelopmentChannels {
		t.Fatal("claude descriptor should support development channels")
	}

	cbD, err := defaultReg().LookupDescriptor("codebuddy")
	if err != nil {
		t.Fatal(err)
	}
	if !cbD.DialectFlags.SupportsDevelopmentChannels {
		t.Fatal("codebuddy descriptor should support development channels")
	}
}

func TestProviderKinds(t *testing.T) {
	r := defaultReg()
	for _, tc := range []struct {
		name string
		kind string
	}{
		{"anthropic", "builtin"},
		{"codebuddy", "builtin"},
	} {
		b, err := r.LookupBinding(tc.name)
		if err != nil {
			t.Fatal(err)
		}
		if b.Kind != tc.kind {
			t.Fatalf("%s kind = %q, want %q", tc.name, b.Kind, tc.kind)
		}
	}
}

func TestCodebuddyResumeFlag(t *testing.T) {
	d, err := defaultReg().LookupDescriptor("codebuddy")
	if err != nil {
		t.Fatal(err)
	}
	if d.ResumeFlag != ResumeFlagLong {
		t.Fatalf("codebuddy resume flag = %s", d.ResumeFlag)
	}
}

func TestClientDescriptorsCodexOpenCode(t *testing.T) {
	r := defaultReg()

	codex, err := r.LookupDescriptor("codex")
	if err != nil {
		t.Fatal(err)
	}
	if codex.Name != "codex" || codex.Dialect != DialectCodex {
		t.Fatalf("codex descriptor = %+v", codex)
	}
	if codex.Binary.Name != "codex" {
		t.Fatalf("codex binary name = %q", codex.Binary.Name)
	}
	if codex.DefaultProvider != "codex" {
		t.Fatalf("codex default provider = %q, want codex", codex.DefaultProvider)
	}

	oc, err := r.LookupDescriptor("opencode")
	if err != nil {
		t.Fatal(err)
	}
	if oc.Name != "opencode" || oc.Dialect != DialectOpenCode {
		t.Fatalf("opencode descriptor = %+v", oc)
	}
	if oc.Binary.Name != "opencode" {
		t.Fatalf("opencode binary name = %q", oc.Binary.Name)
	}
	if oc.DefaultProvider != "opencode-native" {
		t.Fatalf("opencode default provider = %q, want opencode-native", oc.DefaultProvider)
	}
}

func TestDialectCompatibilityNewProviders(t *testing.T) {
	r := defaultReg()

	// anthropic (claude-code) must be compatible with claude client.
	_, anthropic, err := r.ResolveBinding("claude", "anthropic")
	if err != nil {
		t.Fatalf("claude + anthropic should be compatible: %v", err)
	}
	if anthropic.QuotaProvider != "anthropic" {
		t.Fatalf("anthropic binding quota provider = %q, want anthropic", anthropic.QuotaProvider)
	}
	if !anthropic.UsesClientBinary() {
		t.Fatalf("anthropic binding should use client binary")
	}

	// zhipu-coding (claude-code) compatible with claude client.
	_, zhipu, err := r.ResolveBinding("claude", "zhipu-coding")
	if err != nil {
		t.Fatalf("claude + zhipu-coding should be compatible: %v", err)
	}
	if zhipu.QuotaProvider != "zhipu-coding" {
		t.Fatalf("zhipu-coding quota provider = %q, want zhipu-coding", zhipu.QuotaProvider)
	}
	if zhipu.UsesClientBinary() {
		t.Fatalf("zhipu-coding binding should not use client binary")
	}

	// codex (codex dialect) compatible with codex client.
	codexClient, codexProvider, err := r.ResolveBinding("codex", "codex")
	if err != nil {
		t.Fatalf("codex + codex should be compatible: %v", err)
	}
	if codexClient.DefaultProvider != "codex" {
		t.Fatalf("codex client default provider = %q, want codex", codexClient.DefaultProvider)
	}
	if codexProvider.QuotaProvider != "codex" {
		t.Fatalf("codex provider quota provider = %q, want codex", codexProvider.QuotaProvider)
	}

	// codex-spark (codex dialect) distinct pool.
	_, spark, err := r.ResolveBinding("codex", "codex-spark")
	if err != nil {
		t.Fatalf("codex + codex-spark should be compatible: %v", err)
	}
	if spark.QuotaProvider != "codex-spark" {
		t.Fatalf("codex-spark quota provider = %q, want codex-spark", spark.QuotaProvider)
	}
	if len(spark.AllowedModels) != 1 || spark.AllowedModels[0] != "gpt-5.3-codex-spark" {
		t.Fatalf("codex-spark allowed models = %v, want [gpt-5.3-codex-spark]", spark.AllowedModels)
	}

	// opencode-native (opencode dialect) compatible with opencode client.
	_, ocNative, err := r.ResolveBinding("opencode", "opencode-native")
	if err != nil {
		t.Fatalf("opencode + opencode-native should be compatible: %v", err)
	}
	if ocNative.QuotaProvider != "" {
		t.Fatalf("opencode-native quota provider = %q, want empty", ocNative.QuotaProvider)
	}
}

func TestProviderUsesClientBinaryPolicy(t *testing.T) {
	r := defaultReg()

	for _, name := range []string{"anthropic", "kimi-coding", "codebuddy"} {
		b, err := r.LookupBinding(name)
		if err != nil {
			t.Fatal(err)
		}
		if !b.UsesClientBinary() {
			t.Fatalf("%s should use client binary", name)
		}
	}

	for _, name := range []string{"zhipu-coding", "codex", "codex-spark", "opencode-native"} {
		b, err := r.LookupBinding(name)
		if err != nil {
			t.Fatal(err)
		}
		if b.UsesClientBinary() {
			t.Fatalf("%s should not use client binary", name)
		}
	}
}

func TestCredentialResolverMapping(t *testing.T) {
	r := defaultReg()
	tests := []struct {
		id   string
		want CredentialResolver
	}{
		{"kimi-coding", CredentialResolverForgeManaged},
		{"zhipu-coding", CredentialResolverForgeManaged},
		{"anthropic", CredentialResolverClaude},
		{"codex", CredentialResolverCodex},
		{"codex-spark", CredentialResolverCodex},
	}
	for _, tc := range tests {
		provider, err := r.LookupBinding(tc.id)
		if err != nil {
			t.Fatalf("lookup %s: %v", tc.id, err)
		}
		if provider.Inference == nil {
			t.Fatalf("%s has nil inference binding", tc.id)
		}
		if provider.Inference.CredentialResolver != tc.want {
			t.Fatalf("%s credential resolver = %q, want %q", tc.id, provider.Inference.CredentialResolver, tc.want)
		}
	}
	// Verify deepseek is NOT mapped to codebuddy in any alias sense.
	if _, err := r.LookupBinding("deepseek"); err == nil {
		t.Fatal("deepseek must not be a registered binding")
	}
}

func TestExistingProviderBindingsUnchanged(t *testing.T) {
	r := defaultReg()

	anthropic, err := r.LookupBinding("anthropic")
	if err != nil {
		t.Fatal(err)
	}
	if anthropic.QuotaProvider != "anthropic" {
		t.Fatalf("anthropic quota = %q, want anthropic", anthropic.QuotaProvider)
	}

	kimi, err := r.LookupBinding("kimi-coding")
	if err != nil {
		t.Fatal(err)
	}
	if kimi.QuotaProvider != "kimi-coding" {
		t.Fatalf("kimi-coding quota = %q, want kimi-coding", kimi.QuotaProvider)
	}

	codebuddy, err := r.LookupBinding("codebuddy")
	if err != nil {
		t.Fatal(err)
	}
	if codebuddy.QuotaProvider != "" {
		t.Fatalf("codebuddy quota = %q, want empty", codebuddy.QuotaProvider)
	}
}

func TestCodexSparkDistinctPool(t *testing.T) {
	r := defaultReg()

	codex, err := r.LookupBinding("codex")
	if err != nil {
		t.Fatal(err)
	}
	if codex.QuotaProvider != "codex" {
		t.Fatalf("codex quota = %q, want codex", codex.QuotaProvider)
	}

	spark, err := r.LookupBinding("codex-spark")
	if err != nil {
		t.Fatal(err)
	}
	if spark.QuotaProvider != "codex-spark" {
		t.Fatalf("codex-spark quota = %q, want codex-spark", spark.QuotaProvider)
	}
	if codex.QuotaProvider == spark.QuotaProvider {
		t.Fatal("codex and codex-spark must use distinct canonical quota pools")
	}
}

func TestCodebuddyNoInferenceBinding(t *testing.T) {
	r := defaultReg()
	codebuddy, err := r.LookupBinding("codebuddy")
	if err != nil {
		t.Fatal(err)
	}
	if codebuddy.Inference != nil {
		t.Fatalf("codebuddy provider must not expose a public inference binding, got %#v", codebuddy.Inference)
	}
	if len(codebuddy.RawLLM) != 0 {
		t.Fatalf("codebuddy provider must not expose raw LLM endpoints, got %#v", codebuddy.RawLLM)
	}
	if codebuddy.CredentialSource() != CredentialResolverCodeBuddy {
		t.Fatalf("codebuddy credential source = %q, want native codebuddy", codebuddy.CredentialSource())
	}
	if !codebuddy.UsesClientBinary() {
		t.Fatal("codebuddy provider must use the native client binary")
	}
}

func TestCodebuddyNativeHasNoRawEndpoints(t *testing.T) {
	r := defaultReg()
	codebuddy, err := r.LookupBinding("codebuddy")
	if err != nil {
		t.Fatal(err)
	}
	if len(codebuddy.RawLLM) != 0 {
		t.Fatalf("codebuddy raw llm count = %d, want 0 (native client)", len(codebuddy.RawLLM))
	}
	// Verify anthropic resolver remains claude.
	anthropic, err := r.LookupBinding("anthropic")
	if err != nil {
		t.Fatal(err)
	}
	if anthropic.Inference == nil || anthropic.Inference.CredentialResolver != CredentialResolverClaude {
		t.Fatal("anthropic credential resolver must remain claude")
	}
}

func TestProviderModelMap(t *testing.T) {
	r := defaultReg()

	// codebuddy provider owns the public Hunyuan and DeepSeek models.
	for _, model := range []string{"hunyuan-chat", "deepseek-v4-pro", "deepseek-v4-flash", "kimi-k2.6"} {
		canonical, ok := r.LookupProviderModel("codebuddy", model)
		if !ok {
			t.Fatalf("codebuddy should own model %q", model)
		}
		if canonical != model {
			t.Fatalf("canonical model = %q, want %q", canonical, model)
		}
	}
	if _, ok := r.LookupProviderModel("codebuddy", "glm-5.2"); ok {
		t.Fatal("codebuddy should no longer own removed cb-glm model glm-5.2")
	}

	canonical, ok := r.LookupProviderModel("zhipu-coding", "glm-5.3")
	if !ok {
		t.Fatal("zhipu-coding should own glm-5.3")
	}
	if canonical != "glm-5.3" {
		t.Fatalf("zhipu-coding glm-5.3 canonical = %q, want glm-5.3", canonical)
	}
	if _, ok := r.LookupProviderModel("zhipu-coding", "glm-5.2"); ok {
		t.Fatal("zhipu-coding should no longer own retired glm-5.2")
	}

	// codex provider owns GPT-5.6 models.
	for _, model := range []string{"gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"} {
		_, ok := r.LookupProviderModel("codex", model)
		if !ok {
			t.Fatalf("codex should own model %q", model)
		}
	}

	// codex-spark owns gpt-5.3-codex-spark.
	_, ok = r.LookupProviderModel("codex-spark", "gpt-5.3-codex-spark")
	if !ok {
		t.Fatal("codex-spark should own gpt-5.3-codex-spark")
	}
}

func TestNoRetiredProviderAliases(t *testing.T) {
	r := defaultReg()
	retired := []string{"codebuddy-native", "deepseek", "anthropic-sub"}
	for _, name := range retired {
		if _, err := r.LookupBinding(name); err == nil {
			t.Fatalf("retired provider %q should not exist", name)
		}
	}
}

func TestDSHClientDescriptor(t *testing.T) {
	r := defaultReg()
	d, err := r.LookupDescriptor("dsh")
	if err != nil {
		t.Fatal(err)
	}
	if d.Name != "dsh" || d.Dialect != DialectDSH {
		t.Fatalf("dsh descriptor = %+v", d)
	}
	if d.Binary.Name != "fdsh" {
		t.Fatalf("dsh binary name = %q, want fdsh", d.Binary.Name)
	}
	if d.TranscriptFamily != TranscriptFamilyDSH {
		t.Fatalf("dsh transcript family = %q, want %q", d.TranscriptFamily, TranscriptFamilyDSH)
	}
	if d.PermissionAdapter != PermissionAdapterDSH {
		t.Fatalf("dsh permission adapter = %q, want %q", d.PermissionAdapter, PermissionAdapterDSH)
	}
	if d.ConfigIsolation.EnvVar != "DSH_HOME" {
		t.Fatalf("dsh config env = %q, want DSH_HOME", d.ConfigIsolation.EnvVar)
	}
	if d.ResumeFlag != "" {
		t.Fatalf("dsh must not claim native resume, got %q", d.ResumeFlag)
	}
	if d.DefaultProvider != "" {
		t.Fatalf("dsh default provider = %q, want empty", d.DefaultProvider)
	}
	if EnvDSHModel != "DSH_MODEL" {
		t.Fatalf("EnvDSHModel = %q, want DSH_MODEL", EnvDSHModel)
	}

	want := map[PermissionMode]string{
		PermissionReadonly: "read-only",
		PermissionEdit:     "workspace-write",
		PermissionYolo:     "danger-full-access",
	}
	for mode, value := range want {
		if got := DSHPermissionMode(mode); got != value {
			t.Fatalf("DSHPermissionMode(%s) = %q, want %q", mode, got, value)
		}
		if got := DSHPermissionEnv(mode); got != "DSH_PERMISSION_MODE="+value {
			t.Fatalf("DSHPermissionEnv(%s) = %q, want DSH_PERMISSION_MODE=%s", mode, got, value)
		}
	}

	// DSH permissions are env-carried, never CLI flags.
	for _, mode := range []PermissionMode{PermissionReadonly, PermissionEdit, PermissionYolo} {
		if got := d.BuildPermissionArgs(mode); got != nil {
			t.Fatalf("dsh must not emit permission flags for %s: %v", mode, got)
		}
	}
}

func TestProviderRawLLMCapabilities(t *testing.T) {
	r := defaultReg()

	prio := map[string]int{"openai": 0, "anthropic": 1}
	sortRaw := func(ps []string) {
		sort.Slice(ps, func(i, j int) bool { return prio[ps[i]] < prio[ps[j]] })
	}

	// Expected native raw protocols per canonical provider.
	want := map[string][]string{
		"codebuddy":       nil,
		"codex":           nil,
		"codex-spark":     nil,
		"kimi-coding":     {"openai", "anthropic"},
		"zhipu-coding":    {"openai", "anthropic"},
		"anthropic":       {"anthropic"},
		"opencode-native": nil,
	}

	for name, wantProtocols := range want {
		b, err := r.LookupBinding(name)
		if err != nil {
			t.Fatalf("lookup %s: %v", name, err)
		}
		var got []string
		for _, c := range b.RawLLM {
			got = append(got, string(c.Protocol))
		}
		sortRaw(got)
		if !reflect.DeepEqual(got, wantProtocols) {
			t.Fatalf("%s raw protocols = %v, want %v", name, got, wantProtocols)
		}
		// Raw capabilities must NOT be derived from Inference.Protocol.
		if b.Inference == nil {
			continue
		}
		var wantInference string
		switch name {
		case "codex", "codex-spark":
			wantInference = "openai-chat-completions"
		case "kimi-coding", "zhipu-coding", "anthropic":
			wantInference = "anthropic-messages"
		}
		if b.Inference.Protocol != wantInference {
			t.Fatalf("%s Inference.Protocol = %q, want unchanged %q", name, b.Inference.Protocol, wantInference)
		}
	}

	// Verify zhipu-coding OpenAI RawLLM endpoint uses the full chat completions URL.
	zhipu, err := r.LookupBinding("zhipu-coding")
	if err != nil {
		t.Fatalf("lookup zhipu-coding: %v", err)
	}
	var gotOpenAIEndpoint string
	for _, c := range zhipu.RawLLM {
		if c.Protocol == RawLLMProtocolOpenAI {
			gotOpenAIEndpoint = c.BaseEndpoint
			break
		}
	}
	wantOpenAIEndpoint := "https://open.bigmodel.cn/api/coding/paas/v4/chat/completions"
	if gotOpenAIEndpoint != wantOpenAIEndpoint {
		t.Fatalf("zhipu-coding OpenAI RawLLM endpoint = %q, want %q", gotOpenAIEndpoint, wantOpenAIEndpoint)
	}
}
