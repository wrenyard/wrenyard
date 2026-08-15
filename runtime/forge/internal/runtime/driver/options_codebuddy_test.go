package driver

import (
	"strings"
	"testing"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/catalog"
)

func TestDevelopmentChannelsFlagInjection(t *testing.T) {
	// Both CC-family descriptors must get --dangerously-load-development-channels
	// server:foreman injected by appendClaudeCodeOptions.
	for _, tc := range []struct {
		name string
		desc catalog.Client
	}{
		{
			name: "claude",
			desc: catalog.Client{
				DialectFlags: catalog.DialectFlags{
					SupportsDevelopmentChannels: true,
				},
			},
		},
		{
			name: "codebuddy",
			desc: catalog.Client{
				DialectFlags: catalog.DialectFlags{
					SupportsVerbose:             false,
					SupportsBare:                false,
					SupportsReplayUserMessages:  true,
					SupportsDevelopmentChannels: true,
				},
			},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			args := appendClaudeCodeOptions([]string{tc.name}, PlanRequest{}, tc.desc)
			found := false
			for i, arg := range args {
				if arg == "--dangerously-load-development-channels" &&
					i+1 < len(args) && args[i+1] == "server:foreman" {
					found = true
					break
				}
			}
			if !found {
				t.Fatalf("%q args should contain --dangerously-load-development-channels server:foreman, got: %v", tc.name, args)
			}
		})
	}

	// Non-CC-family client (SupportsDevelopmentChannels=false) must NOT receive
	// the flag.
	t.Run("unsupported", func(t *testing.T) {
		desc := catalog.Client{
			DialectFlags: catalog.DialectFlags{
				SupportsDevelopmentChannels: false,
			},
		}
		args := appendClaudeCodeOptions([]string{"other"}, PlanRequest{}, desc)
		for _, arg := range args {
			if arg == "--dangerously-load-development-channels" {
				t.Fatalf("unsupported client should NOT get development channels flag, got: %v", args)
			}
		}
	})
}

func TestDevelopmentChannelsMerge(t *testing.T) {
	// 1. No existing flag → appended fresh (two-token form).
	t.Run("absent", func(t *testing.T) {
		args := mergeDevelopmentChannels([]string{"some", "args"})
		want := []string{"some", "args", "--dangerously-load-development-channels", "server:foreman"}
		if !sliceEq(args, want) {
			t.Fatalf("absent: got %v, want %v", args, want)
		}
	})

	// 2. Existing two-token form with other value → merged comma-joined.
	t.Run("two-token-merge", func(t *testing.T) {
		args := mergeDevelopmentChannels([]string{"cmd", "--dangerously-load-development-channels", "server:foo"})
		want := []string{"cmd", "--dangerously-load-development-channels", "server:foo,server:foreman"}
		if !sliceEq(args, want) {
			t.Fatalf("two-token-merge: got %v, want %v", args, want)
		}
	})

	// 3. Existing = form → merged preserving = form.
	t.Run("equals-merge", func(t *testing.T) {
		args := mergeDevelopmentChannels([]string{"cmd", "--dangerously-load-development-channels=server:foo"})
		want := []string{"cmd", "--dangerously-load-development-channels=server:foo,server:foreman"}
		if !sliceEq(args, want) {
			t.Fatalf("equals-merge: got %v, want %v", args, want)
		}
	})

	// 4. Already contains server:foreman → unchanged, no duplicate.
	t.Run("already-present", func(t *testing.T) {
		tests := []struct {
			name string
			in   []string
		}{
			{
				name: "two-token sole channel",
				in:   []string{"cmd", "--dangerously-load-development-channels", "server:foreman"},
			},
			{
				name: "equals sole channel",
				in:   []string{"cmd", "--dangerously-load-development-channels=server:foreman"},
			},
			{
				name: "two-token comma list",
				in:   []string{"cmd", "--dangerously-load-development-channels", "server:foo,server:foreman"},
			},
			{
				name: "equals comma list",
				in:   []string{"cmd", "--dangerously-load-development-channels=server:foo,server:foreman"},
			},
		}
		for _, tt := range tests {
			t.Run(tt.name, func(t *testing.T) {
				args := mergeDevelopmentChannels(append([]string(nil), tt.in...))
				if !sliceEq(args, tt.in) {
					t.Fatalf("expected unchanged args, got %v", args)
				}
			})
		}
	})
}

func sliceEq(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func TestCleanModeRespectsSupportsBare(t *testing.T) {
	// CodeBuddy descriptor: SupportsBare = false.
	codebuddyDesc := catalog.Client{
		DialectFlags: catalog.DialectFlags{
			SupportsVerbose:            false,
			SupportsBare:               false,
			SupportsReplayUserMessages: true,
		},
	}
	// Claude descriptor: SupportsBare = true.
	claudeDesc := catalog.Client{
		DialectFlags: catalog.DialectFlags{
			SupportsVerbose:            true,
			SupportsBare:               true,
			SupportsReplayUserMessages: true,
		},
	}

	opts := PlanRequest{Clean: true}

	// With codebuddy descriptor: argv must NOT contain --bare.
	codebuddyArgs := []string{"codebuddy"}
	codebuddyArgs = appendClaudeCodeOptions(codebuddyArgs, opts, codebuddyDesc)
	for _, arg := range codebuddyArgs {
		if arg == "--bare" {
			t.Fatalf("codebuddy argv should NOT contain --bare, got: %v", codebuddyArgs)
		}
	}

	// With claude descriptor: argv MUST contain --bare.
	claudeArgs := []string{"claude"}
	claudeArgs = appendClaudeCodeOptions(claudeArgs, opts, claudeDesc)
	foundBare := false
	for _, arg := range claudeArgs {
		if arg == "--bare" {
			foundBare = true
			break
		}
	}
	if !foundBare {
		t.Fatalf("claude argv should contain --bare, got: %v", claudeArgs)
	}
}

// --- Disallowed tools merge tests ---

func TestMergeDisallowedToolsAddsAll(t *testing.T) {
	args := []string{"codebuddy", "--model", "test", "-p"}
	result := mergeDisallowedTools(args)

	// Verify --disallowedTools exists in result
	hasFlag := false
	for i, a := range result {
		if a == "--disallowedTools" && i+1 < len(result) {
			value := result[i+1]
			if strings.Contains(value, "EnterPlanMode") &&
				strings.Contains(value, "Agent") &&
				strings.Contains(value, "TeamCreate") &&
				strings.Contains(value, "TeamDelete") &&
				strings.Contains(value, "SendMessage") {
				hasFlag = true
				break
			}
		}
	}
	if !hasFlag {
		t.Fatalf("expected --disallowedTools with all orchestration tools, got %v", result)
	}
}

func TestMergeDisallowedToolsMergesExistingTwoToken(t *testing.T) {
	args := []string{"codebuddy", "--disallowedTools", "SomeTool", "-p"}
	result := mergeDisallowedTools(args)

	value := ""
	for i, a := range result {
		if a == "--disallowedTools" && i+1 < len(result) {
			value = result[i+1]
			break
		}
	}
	if !strings.Contains(value, "SomeTool") {
		t.Fatalf("expected SomeTool preserved in --disallowedTools, got %q", value)
	}
	if !strings.Contains(value, "Agent") {
		t.Fatalf("expected Agent added to --disallowedTools, got %q", value)
	}
}

func TestMergeDisallowedToolsMergesExistingEqualsForm(t *testing.T) {
	args := []string{"codebuddy", "--disallowedTools=SomeTool,OtherTool", "-p"}
	result := mergeDisallowedTools(args)

	found := false
	for _, a := range result {
		if strings.HasPrefix(a, "--disallowedTools=") {
			value := strings.TrimPrefix(a, "--disallowedTools=")
			if strings.Contains(value, "SomeTool") &&
				strings.Contains(value, "OtherTool") &&
				strings.Contains(value, "Agent") {
				found = true
			}
			break
		}
	}
	if !found {
		t.Fatalf("expected --disallowedTools= with merged tools, got %v", result)
	}
}

func TestMergeDisallowedToolsNoDuplicate(t *testing.T) {
	// When EnterPlanMode is already in --disallowedTools, it should NOT be duplicated.
	args := []string{"codebuddy", "--disallowedTools=EnterPlanMode", "-p"}
	result := mergeDisallowedTools(args)

	found := false
	for _, a := range result {
		if strings.HasPrefix(a, "--disallowedTools=") {
			value := strings.TrimPrefix(a, "--disallowedTools=")
			parts := strings.Split(value, ",")
			counts := map[string]int{}
			for _, p := range parts {
				counts[strings.TrimSpace(p)]++
			}
			if counts["EnterPlanMode"] > 1 {
				t.Errorf("EnterPlanMode duplicated in --disallowedTools: %q", value)
			}
			if counts["Agent"] != 1 {
				t.Errorf("expected Agent once, got %d in: %q", counts["Agent"], value)
			}
			found = true
			break
		}
	}
	if !found {
		t.Fatal("expected --disallowedTools flag in result")
	}
}

func TestMergeDisallowedToolsEmptyValue(t *testing.T) {
	// Empty --disallowedTools should still get all orchestration tools.
	args := []string{"codebuddy", "--disallowedTools", "", "-p"}
	result := mergeDisallowedTools(args)

	value := ""
	for i, a := range result {
		if a == "--disallowedTools" && i+1 < len(result) {
			value = result[i+1]
			break
		}
	}
	if !strings.Contains(value, "Agent") {
		t.Fatalf("expected Agent in empty --disallowedTools, got %q", value)
	}
}

// --- D1 regression: verify disallowed tools on all dispatch paths ---

func assertDisallowedTools(t *testing.T, cmd []string) {
	t.Helper()
	required := []string{"EnterPlanMode", "Agent", "TeamCreate", "TeamDelete", "SendMessage"}
	hasFlag := false
	for i, arg := range cmd {
		if strings.HasPrefix(arg, "--disallowedTools=") {
			value := strings.TrimPrefix(arg, "--disallowedTools=")
			hasFlag = true
			assertAllToolsPresent(t, value, required)
			return
		}
		if arg == "--disallowedTools" && i+1 < len(cmd) {
			value := cmd[i+1]
			hasFlag = true
			assertAllToolsPresent(t, value, required)
			return
		}
	}
	if !hasFlag {
		t.Fatalf("--disallowedTools flag not found in command: %v", cmd)
	}
}

func assertAllToolsPresent(t *testing.T, value string, required []string) {
	t.Helper()
	present := map[string]bool{}
	for _, part := range strings.Split(value, ",") {
		present[strings.TrimSpace(part)] = true
	}
	for _, tool := range required {
		if !present[tool] {
			t.Errorf("tool %q missing from --disallowedTools=%q", tool, value)
		}
	}
}

// --- Removed MCP gateway tools tests ---

func codebuddyDescMCPGateway() catalog.Client {
	return catalog.Client{
		Name:              "codebuddy",
		Dialect:           catalog.DialectClaudeCode,
		PermissionAdapter: catalog.PermissionAdapterCodeBuddy,
		DialectFlags: catalog.DialectFlags{
			SupportsDevelopmentChannels: true,
		},
	}
}

func hasTool(args []string, tool string) bool {
	for i, arg := range args {
		val := ""
		if strings.HasPrefix(arg, "--tools=") {
			val = strings.TrimPrefix(arg, "--tools=")
		} else if arg == "--tools" && i+1 < len(args) {
			val = args[i+1]
		} else {
			continue
		}
		for _, t := range strings.Split(val, ",") {
			if strings.TrimSpace(t) == tool {
				return true
			}
		}
	}
	return false
}

func codeBuddyToolScopePromptValue(args []string) (string, bool) {
	for i, arg := range args {
		if strings.HasPrefix(arg, "--append-system-prompt=") {
			return strings.TrimPrefix(arg, "--append-system-prompt="), true
		}
		if arg == "--append-system-prompt" && i+1 < len(args) {
			return args[i+1], true
		}
	}
	return "", false
}

func argsContain(args []string, v string) bool {
	for _, a := range args {
		if a == v {
			return true
		}
	}
	return false
}

func hasBashRule(args []string, rule string) bool {
	for _, arg := range args {
		for _, item := range strings.Split(arg, ",") {
			if strings.TrimSpace(item) == rule {
				return true
			}
		}
	}
	return false
}

func TestAppendClaudeAgentOptionsDoesNotAppendMCPGatewayTools(t *testing.T) {
	desc := codebuddyDescMCPGateway()
	for _, tc := range []struct {
		name       string
		permission catalog.PermissionMode
	}{
		{"edit", catalog.PermissionEdit},
		{"readonly", catalog.PermissionReadonly},
		{"yolo", catalog.PermissionYolo},
	} {
		t.Run(tc.name, func(t *testing.T) {
			opts := PlanRequest{Permission: tc.permission}

			args := appendClaudeCodeOptions(nil, opts, desc)

			if hasTool(args, "ToolSearch") {
				t.Errorf("expected no ToolSearch after Forge MCP removal, got %v", args)
			}
			if hasTool(args, "DeferExecuteTool") {
				t.Errorf("expected no DeferExecuteTool after Forge MCP removal, got %v", args)
			}
		})
	}
}

func TestAppendClaudeAgentOptionsKeepsDescriptorToolsWithoutAddingMCPGateway(t *testing.T) {
	desc := codebuddyDescMCPGateway()
	desc.PermissionAdapter = catalog.PermissionAdapterNone
	opts := PlanRequest{Permission: catalog.PermissionEdit}

	args := appendClaudeCodeOptions([]string{
		"--permission-mode", "bypassPermissions",
		"--tools=" + strings.Join([]string{"Read", "Edit", "Write", "Bash", "Glob", "Grep", "ToolSearch"}, ","),
	}, opts, desc)

	if !hasTool(args, "ToolSearch") {
		t.Fatalf("descriptor-provided ToolSearch should remain: %v", args)
	}
	if hasTool(args, "DeferExecuteTool") {
		t.Fatalf("Forge should not append DeferExecuteTool as an MCP gateway: %v", args)
	}
}

func TestAppendClaudeAgentOptionsClaudeDoesNotAppendMCPGatewayTools(t *testing.T) {
	claudeDesc := catalog.Client{
		Name:              "claude",
		Dialect:           catalog.DialectClaudeCode,
		PermissionAdapter: catalog.PermissionAdapterNone,
		DialectFlags: catalog.DialectFlags{
			SupportsDevelopmentChannels: true,
		},
	}
	opts := PlanRequest{Permission: catalog.PermissionEdit}

	args := appendClaudeCodeOptions(nil, opts, claudeDesc)

	if hasTool(args, "ToolSearch") {
		t.Error("expected no ToolSearch for claude edit (not codebuddy)")
	}
	if hasTool(args, "DeferExecuteTool") {
		t.Error("expected no DeferExecuteTool for claude edit (not codebuddy)")
	}
}

func TestAppendCodeBuddyToolScopePrompt_Readonly(t *testing.T) {
	desc := codebuddyDescMCPGateway()
	opts := PlanRequest{
		Permission: catalog.PermissionReadonly,
	}

	args := appendClaudeCodeOptions([]string{"codebuddy"}, opts, desc)

	prompt, ok := codeBuddyToolScopePromptValue(args)
	if !ok {
		t.Fatal("expected codebuddy --append-system-prompt for restricted permission")
	}
	for _, want := range []string{
		"permission mode: readonly",
		"Effective built-in tools: Read, Bash, Glob, Grep, WebSearch.",
		"product prompt as unavailable",
		"Bash permission is enforced by Forge's process rules",
		"Use one simple command at a time",
		"Bash is read-only in this mode",
		"report the missing capability",
	} {
		if !strings.Contains(prompt, want) {
			t.Fatalf("prompt missing %q:\n%s", want, prompt)
		}
	}
	if len(prompt) > 900 {
		t.Fatalf("tool scope prompt should stay compact, got %d bytes", len(prompt))
	}
}

func TestAppendCodeBuddyToolScopePrompt_EditWithRemovedMCPDoesNotReflectGatewayTools(t *testing.T) {
	desc := codebuddyDescMCPGateway()
	opts := PlanRequest{Permission: catalog.PermissionEdit}

	args := appendClaudeCodeOptions([]string{"codebuddy"}, opts, desc)

	prompt, ok := codeBuddyToolScopePromptValue(args)
	if !ok {
		t.Fatal("expected codebuddy --append-system-prompt for edit permission")
	}
	for _, want := range []string{
		"Effective built-in tools: Read, Bash, Edit, Write, Glob, Grep, WebSearch.",
		"Call only tools listed above.",
		"Use Edit or Write for content changes",
		"inside the requested file scope",
	} {
		if !strings.Contains(prompt, want) {
			t.Fatalf("prompt missing %q:\n%s", want, prompt)
		}
	}
	for _, notWant := range []string{
		"ToolSearch, DeferExecuteTool",
		"MCP gateway",
	} {
		if strings.Contains(prompt, notWant) {
			t.Fatalf("prompt should not contain %q after Forge MCP removal:\n%s", notWant, prompt)
		}
	}
}

func TestAppendCodeBuddyEditCommandExposesFilesystemBashRules(t *testing.T) {
	desc := codebuddyDescMCPGateway()
	opts := PlanRequest{Permission: catalog.PermissionEdit}

	args := appendClaudeCodeOptions([]string{"codebuddy"}, opts, desc)

	// dontAsk controlled edit, not yolo.
	if !argsContain(args, "--permission-mode") || !argsContain(args, "dontAsk") {
		t.Fatalf("expected dontAsk edit mode, got %v", args)
	}
	if argsContain(args, "-y") || argsContain(args, "--dangerously-skip-permissions") {
		t.Fatalf("edit must not be yolo: %v", args)
	}

	// Shared edit tools include Bash plus Edit and Write.
	for _, tool := range []string{"Read", "Bash", "Edit", "Write", "Glob", "Grep"} {
		if !hasTool(args, tool) {
			t.Fatalf("edit command missing tool %q: %v", tool, args)
		}
	}

	// Controlled filesystem Bash allow rules expose only the gated
	// single-path deletion surface; the old broad rm-family rules are gone.
	for _, rule := range []string{
		"Bash(git rm -- *)", "Bash(mkdir *)", "Bash(cp *)", "Bash(mv *)",
		"Bash(touch *)", "Bash(chmod *)", "Bash(ln *)",
	} {
		if !hasBashRule(args, rule) {
			t.Fatalf("edit command missing Bash allow rule %q: %v", rule, args)
		}
	}
	for _, rule := range []string{
		"Bash(rm *)", "Bash(del *)", "Bash(erase *)", "Bash(rmdir *)", "Bash(rd *)",
	} {
		if hasBashRule(args, rule) {
			t.Fatalf("edit command must not expose broad deletion rule %q: %v", rule, args)
		}
	}

	// Shell-metacharacter deny rules must be present.
	for _, rule := range []string{"Bash(*$*)"} {
		if !hasBashRule(args, rule) {
			t.Fatalf("edit command missing Bash deny rule %q: %v", rule, args)
		}
	}

	// No arbitrary orchestration or MCP gateway tools.
	if hasTool(args, "ToolSearch") || hasTool(args, "DeferExecuteTool") {
		t.Fatalf("edit command must not expose MCP gateway tools: %v", args)
	}
}

func TestAppendCodeBuddyToolScopePrompt_YoloNoAppend(t *testing.T) {
	desc := codebuddyDescMCPGateway()
	opts := PlanRequest{Permission: catalog.PermissionYolo}

	args := appendClaudeCodeOptions([]string{"codebuddy"}, opts, desc)

	if _, ok := codeBuddyToolScopePromptValue(args); ok {
		t.Fatalf("expected no codebuddy tool scope prompt for yolo, got %v", args)
	}
}

func TestAppendCodeBuddyToolScopePrompt_YoloWithExplicitToolsAppends(t *testing.T) {
	desc := codebuddyDescMCPGateway()
	opts := PlanRequest{
		Permission: catalog.PermissionYolo,
	}

	args := appendClaudeCodeOptions([]string{"codebuddy", "--tools=Read,Glob"}, opts, desc)

	prompt, ok := codeBuddyToolScopePromptValue(args)
	if !ok {
		t.Fatal("expected codebuddy tool scope prompt when yolo command still has explicit --tools")
	}
	if !strings.Contains(prompt, "Effective built-in tools: Read, Glob.") {
		t.Fatalf("prompt did not reflect explicit tools:\n%s", prompt)
	}
}

func TestAppendCodeBuddyToolScopePrompt_ClaudeNoAppend(t *testing.T) {
	claudeDesc := catalog.Client{
		Name:              "claude",
		Dialect:           catalog.DialectClaudeCode,
		PermissionAdapter: catalog.PermissionAdapterNone,
		DialectFlags: catalog.DialectFlags{
			SupportsDevelopmentChannels: true,
		},
	}
	opts := PlanRequest{
		Permission: catalog.PermissionReadonly,
	}

	args := appendClaudeCodeOptions([]string{"claude"}, opts, claudeDesc)

	if _, ok := codeBuddyToolScopePromptValue(args); ok {
		t.Fatalf("expected no codebuddy tool scope prompt for claude, got %v", args)
	}
}

func TestEffectiveCodeBuddyToolsUsesLastToolsFlag(t *testing.T) {
	tools, ok := effectiveCodeBuddyTools([]string{
		"--tools=Read,Edit",
		"--model", "test",
		"--tools", "Bash,Glob",
	})
	if !ok {
		t.Fatal("expected tools flag")
	}
	got := strings.Join(tools, ",")
	if got != "Bash,Glob" {
		t.Fatalf("effective tools = %q, want Bash,Glob", got)
	}
}
