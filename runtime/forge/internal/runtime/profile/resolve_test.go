package profile

import (
	"reflect"
	"testing"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/providers/schema"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/catalog"
)

func TestCursorGPT56EffortMatchesDeclaredPlan(t *testing.T) {
	for _, model := range []string{"gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol"} {
		env := map[string]string{}
		applyDispatchModel(env, DispatchPlan{Client: "cursor", Model: model, ReasoningEffort: "xhigh"})
		if got, want := env[catalog.EnvCursorModel], model+"[context=272k,reasoning=xhigh,fast=false]"; got != want {
			t.Fatalf("Cursor model = %q, want %q", got, want)
		}
		applyDispatchModel(env, DispatchPlan{Client: "cursor", Model: model})
		if env[catalog.EnvCursorModel] != model {
			t.Fatal("unspecified effort should retain the bare model")
		}
	}
}

func TestResolveDispatchConsumesGatewayPlanWithoutProviderCredential(t *testing.T) {
	resolved, err := ResolveDispatch(
		InputProfile{Name: "cc-kimi", Client: "legacy", Provider: "legacy", Env: map[string]string{}},
		DispatchPlan{Client: "claude", Provider: "kimi-coding", Model: "k3", Mode: "gateway", Protocol: catalog.GatewayProtocolAnthropic},
		catalog.Client{Name: "claude", Dialect: catalog.DialectClaudeCode},
		schema.Provider{Name: "kimi-coding", CredentialResolver: schema.CredentialResolverForgeManaged},
		Callbacks{Credential: CredentialCallbacks{
			ResolveSecret: func(*string) (*string, bool, error) { return nil, false, nil },
			ResolveProviderCredential: func(string) (string, bool) {
				t.Fatal("gateway dispatch must not resolve the upstream credential in Forge")
				return "", false
			},
			IsManagedProvider: func(string) bool { return true },
		}},
	)
	if err != nil {
		t.Fatal(err)
	}
	if !resolved.Provider.GatewayRouted || resolved.Provider.DefaultModel != "k3" {
		t.Fatalf("unexpected provider plan: %+v", resolved.Provider)
	}
	// cc-kimi plan materialization maps the active Claude Code model to k3[1m]
	// for the Kimi Coding k3 target.
	if got := resolved.Env["ANTHROPIC_MODEL"]; got != "k3[1m]" {
		t.Fatalf("ANTHROPIC_MODEL = %q, want k3[1m]", got)
	}
}

func TestResolveDispatchResolvesNativeCredential(t *testing.T) {
	resolved, err := ResolveDispatch(
		InputProfile{Name: "codex-sol", Env: map[string]string{}},
		DispatchPlan{Client: "codex", Provider: "codex", Model: "gpt-5.6-sol", Mode: "native"},
		catalog.Client{Name: "codex", Dialect: catalog.DialectCodex},
		schema.Provider{Name: "codex", CredentialResolver: schema.CredentialResolverCodex},
		Callbacks{Credential: CredentialCallbacks{
			ResolveSecret: func(*string) (*string, bool, error) { return nil, false, nil },
			ResolveProviderCredential: func(provider string) (string, bool) {
				if provider != "codex" {
					t.Fatalf("provider = %q", provider)
				}
				return "native-token", true
			},
			IsManagedProvider: func(string) bool { return false },
		}},
	)
	if err != nil {
		t.Fatal(err)
	}
	if resolved.Provider.GatewayRouted || resolved.Credential.Value != "native-token" {
		t.Fatalf("unexpected native resolution: %+v", resolved)
	}
}

func TestResolveDispatchUsesDaemonResolvedCodeBuddyUpstreamModel(t *testing.T) {
	resolved, err := ResolveDispatch(
		InputProfile{
			Name: "cb-hy", Client: "codebuddy", Provider: "codebuddy",
			Launcher: map[string]interface{}{"default_args": []interface{}{"--model", "hy4-preview"}},
		},
		DispatchPlan{Client: "codebuddy", Provider: "codebuddy", Model: "hy4-preview-ioa", Mode: "native"},
		catalog.Client{Name: "codebuddy", Dialect: catalog.DialectCodeBuddy},
		schema.Provider{Name: "codebuddy", CredentialResolver: schema.CredentialResolverCodeBuddy},
		Callbacks{Credential: CredentialCallbacks{
			ResolveSecret:             func(*string) (*string, bool, error) { return nil, false, nil },
			ResolveProviderCredential: func(string) (string, bool) { return "native-token", true },
			IsManagedProvider:         func(string) bool { return false },
		}},
	)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"--model", "hy4-preview-ioa"}
	if len(resolved.Launcher.DefaultArgs) != len(want) {
		t.Fatalf("default args = %#v, want %#v", resolved.Launcher.DefaultArgs, want)
	}
	for i := range want {
		if resolved.Launcher.DefaultArgs[i] != want[i] {
			t.Fatalf("default args = %#v, want %#v", resolved.Launcher.DefaultArgs, want)
		}
	}
	if resolved.Provider.DefaultModel != "hy4-preview-ioa" {
		t.Fatalf("provider model = %q, want final upstream model", resolved.Provider.DefaultModel)
	}
}

func TestResolveDispatchRejectsIncompletePlan(t *testing.T) {
	_, err := ResolveDispatch(InputProfile{Name: "broken"}, DispatchPlan{}, catalog.Client{}, schema.Provider{}, Callbacks{})
	if err == nil {
		t.Fatal("expected incomplete dispatch plan error")
	}
}

func codexCallbacks() Callbacks {
	return Callbacks{Credential: CredentialCallbacks{
		ResolveSecret: func(*string) (*string, bool, error) { return nil, false, nil },
		ResolveProviderCredential: func(provider string) (string, bool) {
			if provider != "codex" {
				return "", false
			}
			return "native-token", true
		},
		IsManagedProvider: func(string) bool { return false },
	}}
}

func gatewayCallbacks(t *testing.T) Callbacks {
	return Callbacks{Credential: CredentialCallbacks{
		ResolveSecret: func(*string) (*string, bool, error) { return nil, false, nil },
		ResolveProviderCredential: func(string) (string, bool) {
			t.Fatal("gateway dispatch must not resolve the upstream credential in Forge")
			return "", false
		},
		IsManagedProvider: func(string) bool { return true },
	}}
}

func TestResolveDispatchMaterializesCodexPlanReasoningEffort(t *testing.T) {
	resolved, err := ResolveDispatch(
		InputProfile{Name: "codex-astra", Env: map[string]string{}},
		DispatchPlan{Client: "codex", Provider: "codex", Model: "gpt-6-astra", Mode: "native", ReasoningEffort: "xhigh"},
		catalog.Client{Name: "codex", Dialect: catalog.DialectCodex},
		schema.Provider{Name: "codex", CredentialResolver: schema.CredentialResolverCodex},
		codexCallbacks(),
	)
	if err != nil {
		t.Fatal(err)
	}
	if got := resolved.Env["CODEX_REASONING_EFFORT"]; got != "xhigh" {
		t.Fatalf("CODEX_REASONING_EFFORT = %q, want xhigh", got)
	}
	if got := resolved.Env["CODEX_MODEL"]; got != "gpt-6-astra" {
		t.Fatalf("CODEX_MODEL = %q, want gpt-6-astra", got)
	}
}

func TestResolveDispatchPreservesCallerEffortWhenPlanOmitsIt(t *testing.T) {
	// A plan without reasoningEffort must not clobber a caller-provided value…
	resolved, err := ResolveDispatch(
		InputProfile{Name: "codex-sol", Env: map[string]string{"CODEX_REASONING_EFFORT": "high"}},
		DispatchPlan{Client: "codex", Provider: "codex", Model: "gpt-5.6-sol", Mode: "native"},
		catalog.Client{Name: "codex", Dialect: catalog.DialectCodex},
		schema.Provider{Name: "codex", CredentialResolver: schema.CredentialResolverCodex},
		codexCallbacks(),
	)
	if err != nil {
		t.Fatal(err)
	}
	if got := resolved.Env["CODEX_REASONING_EFFORT"]; got != "high" {
		t.Fatalf("CODEX_REASONING_EFFORT = %q, want preserved caller high", got)
	}
	// …and an absent caller value stays absent when the plan omits the field.
	resolved, err = ResolveDispatch(
		InputProfile{Name: "codex-sol", Env: map[string]string{}},
		DispatchPlan{Client: "codex", Provider: "codex", Model: "gpt-5.6-sol", Mode: "native"},
		catalog.Client{Name: "codex", Dialect: catalog.DialectCodex},
		schema.Provider{Name: "codex", CredentialResolver: schema.CredentialResolverCodex},
		codexCallbacks(),
	)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := resolved.Env["CODEX_REASONING_EFFORT"]; ok {
		t.Fatalf("CODEX_REASONING_EFFORT set to %q without a plan value", resolved.Env["CODEX_REASONING_EFFORT"])
	}
}

func TestResolveDispatchDoesNotLeakReasoningEffortToNonCodexClients(t *testing.T) {
	resolved, err := ResolveDispatch(
		InputProfile{Name: "cc-kimi", Env: map[string]string{}},
		DispatchPlan{
			Client: "claude", Provider: "kimi-coding", Model: "k3",
			Mode: "gateway", Protocol: catalog.GatewayProtocolAnthropic, ReasoningEffort: "xhigh",
		},
		catalog.Client{Name: "claude", Dialect: catalog.DialectClaudeCode},
		schema.Provider{Name: "kimi-coding", CredentialResolver: schema.CredentialResolverForgeManaged},
		gatewayCallbacks(t),
	)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := resolved.Env["CODEX_REASONING_EFFORT"]; ok {
		t.Fatalf("non-codex plan materialized CODEX_REASONING_EFFORT = %q", resolved.Env["CODEX_REASONING_EFFORT"])
	}
}

func TestCCKimiPlanMaterializationIsIdenticalForAliasAndAnonymousTargets(t *testing.T) {
	wantEnv := map[string]string{
		"ANTHROPIC_MODEL":                 "k3[1m]",
		"CLAUDE_CODE_SUBAGENT_MODEL":      "k3[1m]",
		"CLAUDE_CODE_AUTO_COMPACT_WINDOW": "1048576",
		"CLAUDE_CODE_MAX_CONTEXT_TOKENS":  "1048576",
		"ENABLE_TOOL_SEARCH":              "false",
	}
	wantOverrides := map[string]interface{}{
		"claude-opus-4-8":   "k3[1m]",
		"claude-sonnet-4-6": "k3[1m]",
		"claude-haiku-4-5":  "k3[1m]",
	}
	for _, name := range []string{"cc-kimi", "kimi-coding/k3:cc"} {
		resolved, err := ResolveDispatch(
			InputProfile{Name: name, Env: map[string]string{}},
			DispatchPlan{Client: "claude", Provider: "kimi-coding", Model: "k3", Mode: "gateway", Protocol: catalog.GatewayProtocolAnthropic},
			catalog.Client{Name: "claude", Dialect: catalog.DialectClaudeCode},
			schema.Provider{Name: "kimi-coding", CredentialResolver: schema.CredentialResolverForgeManaged},
			gatewayCallbacks(t),
		)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		for key, want := range wantEnv {
			if got := resolved.Env[key]; got != want {
				t.Fatalf("%s: %s = %q, want %q", name, key, got, want)
			}
		}
		if got := resolved.Settings["modelOverrides"]; !reflect.DeepEqual(got, wantOverrides) {
			t.Fatalf("%s: modelOverrides = %#v, want %#v", name, got, wantOverrides)
		}
	}
}

func TestCCKimiPlanMaterializationSynthesizesNoInteractiveOrPermissionArgs(t *testing.T) {
	resolved, err := ResolveDispatch(
		InputProfile{Name: "cc-kimi", Env: map[string]string{}},
		DispatchPlan{Client: "claude", Provider: "kimi-coding", Model: "k3", Mode: "gateway", Protocol: catalog.GatewayProtocolAnthropic},
		catalog.Client{Name: "claude", Dialect: catalog.DialectClaudeCode},
		schema.Provider{Name: "kimi-coding", CredentialResolver: schema.CredentialResolverForgeManaged},
		gatewayCallbacks(t),
	)
	if err != nil {
		t.Fatal(err)
	}
	if len(resolved.Launcher.Command) != 0 {
		t.Fatalf("launcher command synthesized: %#v", resolved.Launcher.Command)
	}
	for _, arg := range resolved.Launcher.DefaultArgs {
		if arg == "agents" || arg == "bypassPermissions" || arg == "--permission-mode" || arg == "-p" || arg == "--dangerously-skip-permissions" {
			t.Fatalf("interactive/permission arg synthesized: %q", arg)
		}
	}
}

func TestResolveDispatchMaterializesCanonicalGrokWireModelFromPlan(t *testing.T) {
	resolved, err := ResolveDispatch(
		InputProfile{Name: "zhipu-coding/glm-5.3:gk", Env: map[string]string{}},
		DispatchPlan{Client: "grok", Provider: "zhipu-coding", Model: "glm-5.3", Mode: "gateway", Protocol: catalog.GatewayProtocolOpenAIChat},
		catalog.Client{Name: "grok", Dialect: catalog.DialectGrok},
		schema.Provider{Name: "zhipu-coding", CredentialResolver: schema.CredentialResolverForgeManaged},
		gatewayCallbacks(t),
	)
	if err != nil {
		t.Fatal(err)
	}
	// Canonical dynamic Grok plans own the wire model: provider/model normalize to
	// forge-<provider>--<normalized-model> without any source profile table.
	if got := resolved.Env["GROK_MODEL"]; got != "forge-zhipu-coding--glm-5-3" {
		t.Fatalf("GROK_MODEL = %q, want forge-zhipu-coding--glm-5-3", got)
	}
}
