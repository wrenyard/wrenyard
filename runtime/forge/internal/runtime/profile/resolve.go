package profile

import (
	"fmt"
	"strings"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/grok"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/catalog"
)

type DispatchPlan struct {
	Client   string                  `json:"client"`
	Provider string                  `json:"provider"`
	Model    string                  `json:"model"`
	Mode     string                  `json:"mode"`
	Protocol catalog.GatewayProtocol `json:"protocol,omitempty"`
	// ReasoningEffort mirrors the TS Catalog plan field (camelCase). It is the
	// model's product-owned upstream reasoning effort. Codex and the registered
	// Cursor GPT-5.6 models materialize it using their native parameter syntax.
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
	provider.DefaultModel = plan.Model
	provider.AllowedModels = []string{plan.Model}
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
	model := plan.Model
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

func applyDispatchModel(env map[string]string, plan DispatchPlan) {
	switch plan.Client {
	case "claude":
		env["ANTHROPIC_MODEL"] = plan.Model
	case "codebuddy":
		if plan.Mode == "gateway" {
			env["ANTHROPIC_MODEL"] = plan.Provider + "/" + plan.Model
		}
	case "codex":
		env["CODEX_MODEL"] = plan.Model
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
		env["GROK_MODEL"] = grok.ModelID(plan.Provider, plan.Model)
	case "cursor":
		env[catalog.EnvCursorModel] = plan.Model
		// Cursor's bare GPT-5.6 IDs default to medium. Preserve the Catalog's
		// declared effort rather than silently running a different variant.
		switch plan.Model {
		case "gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol":
			switch plan.ReasoningEffort {
			case "none", "low", "medium", "high", "xhigh", "max":
				env[catalog.EnvCursorModel] = plan.Model + "[context=272k,reasoning=" + plan.ReasoningEffort + ",fast=false]"
			}
		}
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
