package profile

import (
	"fmt"
	"strings"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/catalog"
)

type DispatchPlan struct {
	Client   string                  `json:"client"`
	Provider string                  `json:"provider"`
	Model    string                  `json:"model"`
	Mode     string                  `json:"mode"`
	Protocol catalog.GatewayProtocol `json:"protocol,omitempty"`
}

// Callbacks bundles the injected root-side dependencies so the profile package
// performs no filesystem I/O and imports nothing outside catalog.
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
	case "opencode":
		env["OPENCODE_MODEL"] = plan.Provider + "/" + plan.Model
	case "dsh":
		env[catalog.EnvDSHModel] = plan.Provider + "/" + plan.Model
	case "cursor":
		env[catalog.EnvCursorModel] = plan.Model
	}
}
