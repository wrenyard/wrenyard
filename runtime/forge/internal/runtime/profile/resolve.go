package profile

import (
	"fmt"
	"strings"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/grok"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/catalog"
)

// reasoningEffortEnv is the profile-private env var that carries the mapped
// wire reasoning effort from plan materialization to the Grok plan builder.
const reasoningEffortEnv = "WRENYARD_REASONING_EFFORT"

type DispatchPlan struct {
	Client   string `json:"client"`
	Provider string `json:"provider"`
	// Model is the canonical provider/model identity. It stays canonical
	// in the plan; native adapter restrictions materialize the wire form.
	Model    string                  `json:"model"`
	Mode     string                  `json:"mode"`
	Protocol catalog.GatewayProtocol `json:"protocol,omitempty"`
	// Thinking mirrors the TS Catalog public thinking plan (camelCase). It is
	// the product-owned thinking selection, but Go never infers an effort level
	// from it or from the model name.
	Thinking string `json:"thinking,omitempty"`
	// UpstreamModel is the explicit native wire model for the client binary.
	// When set it is used for the actual native client model argv/env, while
	// Model stays canonical in the source plan and Gateway lookups.
	UpstreamModel string `json:"upstreamModel,omitempty"`
	// ReasoningEffort is the already-mapped wire reasoning-effort string. Go
	// materializes it verbatim in the consuming client's native parameter
	// syntax and never derives a level itself.
	ReasoningEffort string `json:"reasoningEffort,omitempty"`
}

// Callbacks bundles the injected root-side dependencies so the profile package
// performs no filesystem I/O itself. Adapter lookup stays in catalog; Grok wire
// model identity stays in the grok package.
type Callbacks struct {
	Credential CredentialCallbacks
}

// ResolveDispatch consumes the exact plan selected by the daemon. It performs
// no provider/model/protocol lookup and never decides between native and
// Gateway dispatch; Forge only materializes native adapter data for the plan.
func ResolveDispatch(input InputProfile, plan DispatchPlan, client catalog.Client, provider catalog.Provider, cb Callbacks) (ResolvedProfile, error) {
	out := ResolvedProfile{
		Name:     input.Name,
		Launcher: launcherFromInput(input.Launcher),
		Env:      cloneEnv(input.Env),
		Settings: cloneSettings(input.Settings),
	}
	if strings.TrimSpace(plan.Client) == "" || strings.TrimSpace(plan.Provider) == "" || strings.TrimSpace(plan.Model) == "" {
		return out, fmt.Errorf("dispatch plan for profile %q is incomplete", input.Name)
	}
	if client.Name != plan.Client || provider.Name != plan.Provider {
		return out, fmt.Errorf("dispatch plan for profile %q does not match its native adapters", input.Name)
	}
	if plan.Mode != "native" && plan.Mode != "gateway" {
		return out, fmt.Errorf("dispatch plan for profile %q has invalid mode %q", input.Name, plan.Mode)
	}
	if plan.Mode == "gateway" && plan.Protocol == "" {
		return out, fmt.Errorf("dispatch plan for profile %q is missing its Gateway protocol", input.Name)
	}
	// Gateway lookup uses canonical ids; native adapter validation uses the
	// exact materialized wire model. The dispatch plan identity stays canonical.
	provider.DefaultModel = plan.Model
	provider.AllowedModels = []string{plan.Model}
	if plan.Mode == "native" {
		provider.DefaultModel = dispatchNativeModel(plan)
		provider.AllowedModels = []string{provider.DefaultModel}
	}
	provider.GatewayRouted = plan.Mode == "gateway"
	provider.GatewayProtocol = plan.Protocol
	if plan.Client == "codebuddy" {
		provider.UseClientBinary = true
	}
	out.Client = client
	out.Provider = provider
	out.Compatibility = CompatibilityNone
	applyDispatchModel(out.Env, plan)
	applyDispatchLauncherModel(&out.Launcher, plan)
	applyDispatchEffortArgs(&out.Launcher, plan)
	applyCCKimiMaterialization(&out, plan)
	if plan.Mode == "gateway" {
		out.Credential.Value = ""
		out.Credential.Source = "gateway"
		return out, nil
	}
	credentialInput := input
	credentialInput.Provider = plan.Provider
	credential, err := PlanCredential(credentialInput, cb.Credential)
	if err != nil {
		return out, err
	}
	out.Credential = credential
	return out, nil
}

func applyDispatchLauncherModel(launcher *Launcher, plan DispatchPlan) {
	if plan.Client != "codebuddy" {
		return
	}
	// A Gateway route must present the canonical provider/model public id so
	// the local Gateway can look it up. A native route uses the explicit
	// upstream wire model when the plan supplies one.
	model := dispatchNativeModel(plan)
	if plan.Mode == "gateway" {
		model = plan.Provider + "/" + plan.Model
	}
	for i, arg := range launcher.DefaultArgs {
		if arg == "--model" && i+1 < len(launcher.DefaultArgs) {
			launcher.DefaultArgs[i+1] = model
			return
		}
		if strings.HasPrefix(arg, "--model=") {
			launcher.DefaultArgs[i] = "--model=" + model
			return
		}
	}
	launcher.DefaultArgs = append(launcher.DefaultArgs, "--model", model)
}

// dispatchNativeModel returns the explicit upstream wire model when the plan
// declares one, otherwise the canonical plan model. It never derives a wire
// form from the canonical model name.
func dispatchNativeModel(plan DispatchPlan) string {
	if wire := strings.TrimSpace(plan.UpstreamModel); wire != "" {
		return wire
	}
	return plan.Model
}

// applyDispatchEffortArgs materializes the already-mapped wire reasoning effort
// as --effort <value> on the Claude-family launchers (Claude and CodeBuddy). It
// replaces any stale --effort value and preserves every unrelated flag. When
// the plan omits an effort, no arg is fabricated and any caller-provided value
// is left untouched.
func applyDispatchEffortArgs(launcher *Launcher, plan DispatchPlan) {
	if plan.Client != "claude" && plan.Client != "codebuddy" {
		return
	}
	effort := strings.TrimSpace(plan.ReasoningEffort)
	if effort == "" {
		return
	}
	args := launcher.DefaultArgs
	for i := 0; i < len(args); i++ {
		switch {
		case args[i] == "--effort" && i+1 < len(args):
			args[i+1] = effort
			launcher.DefaultArgs = args
			return
		case strings.HasPrefix(args[i], "--effort="):
			args[i] = "--effort=" + effort
			launcher.DefaultArgs = args
			return
		}
	}
	launcher.DefaultArgs = append(args, "--effort", effort)
}

func applyDispatchModel(env map[string]string, plan DispatchPlan) {
	switch plan.Client {
	case "claude":
		if plan.Mode == "gateway" {
			// Gateway lookup consumes the canonical provider/model identity.
			env["ANTHROPIC_MODEL"] = plan.Model
		} else {
			env["ANTHROPIC_MODEL"] = dispatchNativeModel(plan)
		}
	case "codebuddy":
		if plan.Mode == "gateway" {
			env["ANTHROPIC_MODEL"] = plan.Provider + "/" + plan.Model
		}
	case "codex":
		env["CODEX_MODEL"] = dispatchNativeModel(plan)
		// Reasoning effort is declared on the TS-resolved plan; materialize it
		// only for the codex client and only when the plan names a level, so a
		// caller-provided value is preserved when the plan omits the field.
		if strings.TrimSpace(plan.ReasoningEffort) != "" {
			env["CODEX_REASONING_EFFORT"] = plan.ReasoningEffort
		}
	case "opencode":
		env["OPENCODE_MODEL"] = plan.Provider + "/" + plan.Model
	case "dsh":
		env[catalog.EnvDSHModel] = plan.Provider + "/" + plan.Model
	case "grok":
		env["GROK_MODEL"] = grok.ModelID(plan.Provider, dispatchNativeModel(plan))
		// The Grok plan builder consumes the mapped wire effort from this
		// profile-private env var and emits --reasoning-effort. Nothing is
		// fabricated when the plan omits the effort.
		if effort := strings.TrimSpace(plan.ReasoningEffort); effort != "" {
			env[reasoningEffortEnv] = effort
		}
	case "cursor":
		// Cursor's wire model is sent explicitly by the plan (for example
		// cursor-grok-4.6-high or gpt-5.6-sol[context=272k,reasoning=max,fast=false]).
		// Go never constructs a reasoning variant from the canonical model.
		env[catalog.EnvCursorModel] = dispatchNativeModel(plan)
	}
}

// applyCCKimiMaterialization moves the Claude Code + kimi-coding/k3 compatibility
// into plan materialization: any plan that targets Claude Code over Kimi Coding
// k3 — whether it is the legacy cc-kimi alias profile or an anonymous canonical
// target — receives the same active-model, subagent, 1M compact/context, tool
// search, and Claude modelOverrides values. It never synthesizes interactive
// args, permission bypass, task budgets/timeouts, or shell behavior.
func applyCCKimiMaterialization(out *ResolvedProfile, plan DispatchPlan) {
	if plan.Client != "claude" || plan.Provider != "kimi-coding" || plan.Model != "k3" {
		return
	}
	out.Env["ANTHROPIC_MODEL"] = "k3[1m]"
	out.Env["CLAUDE_CODE_SUBAGENT_MODEL"] = "k3[1m]"
	out.Env["CLAUDE_CODE_AUTO_COMPACT_WINDOW"] = "1048576"
	out.Env["CLAUDE_CODE_MAX_CONTEXT_TOKENS"] = "1048576"
	out.Env["ENABLE_TOOL_SEARCH"] = "false"
	overrides := map[string]interface{}{
		"claude-opus-4-8":   "k3[1m]",
		"claude-sonnet-4-6": "k3[1m]",
		"claude-haiku-4-5":  "k3[1m]",
	}
	if existing, ok := out.Settings["modelOverrides"].(map[string]interface{}); ok {
		for model, active := range overrides {
			existing[model] = active
		}
		return
	}
	out.Settings["modelOverrides"] = overrides
}
