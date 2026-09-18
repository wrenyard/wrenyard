package driver

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/bashgate"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/catalog"
)

// buildOpenCodePlan plans an OpenCode-family invocation from a PlanRequest.
// Family selection is owned by BuildPlan. Resume is unsupported and returns the
// exact legacy error text.
func buildOpenCodePlan(req PlanRequest) (CommandPlan, error) {
	spec := req.Spec
	command := splitCommand(stringField(spec.Launcher, "command", defaultCommand(spec)))
	if len(command) == 0 {
		command = []string{defaultCommand(spec)}
	}
	command = append(command, "run")
	command = append(command, stringSliceField(spec.Launcher, "default_args", nil)...)
	if resumeID := strings.TrimSpace(req.ResumeSessionID); resumeID != "" && !hasFlag(command, "-s") && !hasFlag(command, "--session") {
		command = append(command, "--session", resumeID)
	}
	if model := openCodeCommandModel(spec, strings.TrimSpace(spec.Env["OPENCODE_MODEL"])); model != "" && !hasFlag(command, "-m") && !hasFlag(command, "--model") {
		command = append(command, "-m", model)
	}
	if !spec.Provider.GatewayRouted && !hasFlag(command, "--title") {
		command = append(command, "--title", "Wrenyard task")
	}
	if !hasFlag(command, "--format") {
		command = append(command, "--format", "json")
	}
	if req.Permission == catalog.PermissionYolo && !hasFlag(command, "--pure") {
		command = append(command, "--pure")
	}
	command = append(command, req.Prompt)

	env := map[string]string{}
	for key, value := range spec.Env {
		env[key] = value
	}
	env["FORGE_PROFILE"] = spec.Name
	applyCredentialPlan(env, spec)
	for key, value := range spec.Runtime.Env {
		env[key] = value
	}

	plan := CommandPlan{
		ProfileName: spec.Name,
		Dialect:     catalog.DialectOpenCode,
		Command:     command,
		Env:         env,
		WorkDir:     req.WorkDir,
		Permission:  req.Permission,
	}
	policy := catalog.PolicyFor(req.Permission)

	// Resolve requested capability packs at the same late planning stage.
	// OpenCode can encode Bash-only
	// contributions, but external tool ids and MCP servers remain unsupported.
	if len(req.Capabilities) > 0 {
		result, resErr := resolveCapabilityResult(req.Capabilities, req.ResolveCapabilities)
		if resErr != nil {
			return plan, resErr
		}
		if len(result.Tools.MCP) > 0 || len(result.Tools.Cap) > 0 {
			return plan, fmt.Errorf("profile %q uses client family %q, which cannot safely encode capability tool or MCP contributions", spec.Name, "opencode")
		}
		policy.BashGate.Cap = append(append([]catalog.BashRule(nil), policy.BashGate.Cap...), result.BashGate.Cap...)
	}

	permissionConfig, err := catalog.EncodeOpenCodePermissionConfig(policy)
	if err != nil {
		return plan, err
	}
	bootstrapConfig := permissionConfig
	var pluginConfig string
	preparedFiles := []PreparedFile{}
	if !policy.BashUnrestricted {
		bootstrapConfig, err = catalog.EncodeOpenCodeBootstrapPermissionConfig(policy)
		if err != nil {
			return plan, err
		}
		activeBashPermission, permissionErr := catalog.EncodeOpenCodeBashPermission(policy)
		if permissionErr != nil {
			return plan, permissionErr
		}
		allow, allowErr := catalog.EffectiveBashAllow(policy, policy.BashGate.Cap)
		if allowErr != nil {
			return plan, allowErr
		}
		encodedPolicy, policyErr := bashgate.EncodePolicyForPlatform(bashgate.ClientOpenCode, allow, nil, nil, runtime.GOOS)
		if policyErr != nil {
			return plan, policyErr
		}
		executable, executableErr := os.Executable()
		if executableErr != nil {
			return plan, fmt.Errorf("resolve Forge executable for OpenCode BashGate: %w", executableErr)
		}
		plan.Env[bashgate.ModeEnv] = string(bashgate.ClientOpenCode)
		plan.Env[bashgate.PolicyEnv] = encodedPolicy
		plan.Env[bashgate.OpenCodeExecutableEnv] = executable
		plan.Env[bashgate.OpenCodeBashPermissionEnv] = activeBashPermission
		preparedFiles = append(preparedFiles, PreparedFile{
			RelativePath: "forge-bashgate.js",
			Data:         bashgate.OpenCodePluginBytes(),
			Mode:         0o600,
		})
	}
	if spec.Provider.GatewayRouted {
		// Stable per-invocation session id, reused for every LLM turn of this
		// invocation. A resume reuses the supplied id; otherwise an opaque
		// random id is generated once. This never derives from credentials,
		// prompts, hashes, or provider account ids.
		session := strings.TrimSpace(req.ResumeSessionID)
		if session == "" {
			buf := make([]byte, 16)
			if _, err := rand.Read(buf); err != nil {
				return plan, fmt.Errorf("generate OpenCode session id: %w", err)
			}
			session = hex.EncodeToString(buf)
		}
		gatewayConfig, marshalErr := json.Marshal(map[string]any{
			"provider": map[string]any{
				"wrenyard": map[string]any{
					"npm":     "@ai-sdk/openai-compatible",
					"name":    "Wrenyard",
					"options": map[string]any{"baseURL": spec.Runtime.Env["WRENYARD_GATEWAY_OPENAI_CHAT_URL"], "apiKey": "{env:WRENYARD_GATEWAY_TOKEN}", "headers": map[string]any{"x-opencode-session": session}},
				},
			},
		})
		if marshalErr != nil {
			return plan, marshalErr
		}
		bootstrapConfig = mergeJSONObjects(bootstrapConfig, string(gatewayConfig))
	} else {
		// Genuine OpenCode native route: the selected model is served through an
		// OpenCode provider entry keyed by the canonical provider id, using the
		// Forge-managed credential for that provider. Free Zen models are only
		// reachable this way; no fake OpenCode headers are forwarded elsewhere.
		nativeConfig, marshalErr := openCodeNativeProviderConfig(spec, strings.TrimSpace(spec.Env["OPENCODE_MODEL"]))
		if marshalErr != nil {
			return plan, marshalErr
		}
		if nativeConfig != "" {
			bootstrapConfig = mergeJSONObjects(bootstrapConfig, nativeConfig)
			if credential := strings.TrimSpace(spec.CredentialValue); credential != "" {
				plan.Env[openCodeNativeCredentialEnv] = credential
			}
		}
	}
	configParent := filepath.Join(spec.ForgeDataDir, "opencode", "direct-runs")
	preparedFiles = append([]PreparedFile{{
		RelativePath: "opencode.json",
		Data:         append([]byte(bootstrapConfig), '\n'),
		Mode:         0o600,
	}}, preparedFiles...)
	configHome, err := materializeRuntimePreparation(RuntimePreparation{
		HomeParent: configParent,
		Files:      preparedFiles,
	})
	if err != nil {
		return plan, err
	}
	if !policy.BashUnrestricted {
		pluginURL, pluginErr := openCodeFileURL(filepath.Join(configHome, "forge-bashgate.js"))
		if pluginErr != nil {
			return plan, pluginErr
		}
		content, marshalErr := json.Marshal(struct {
			Plugin []string `json:"plugin"`
		}{Plugin: []string{pluginURL}})
		if marshalErr != nil {
			return plan, fmt.Errorf("encode OpenCode plugin registration: %w", marshalErr)
		}
		pluginConfig = string(content)
	} else {
		pluginConfig = "{}"
	}
	resource := ExecutionResource{
		Path:            configHome,
		OwnershipRoot:   configParent,
		RemoveOnSuccess: true,
	}
	plan.ConfigDir = configHome
	plan.Resources = []ExecutionResource{resource}
	delete(plan.Env, "OPENCODE_PERMISSION")
	plan.Env["XDG_CONFIG_HOME"] = configHome
	plan.Env["OPENCODE_CONFIG_DIR"] = configHome
	plan.Env["OPENCODE_CONFIG"] = filepath.Join(configHome, "opencode.json")
	plan.Env["OPENCODE_CONFIG_CONTENT"] = pluginConfig
	plan.Env["OPENCODE_DISABLE_PROJECT_CONFIG"] = "true"
	plan.Env["OPENCODE_DISABLE_CLAUDE_CODE"] = "true"
	return plan, nil
}

// openCodeNativeCredentialEnv is the child-only env var that carries the
// Forge-managed credential for the genuine OpenCode native route. The value is
// never written into the on-disk OpenCode config.
const openCodeNativeCredentialEnv = "FORGE_OPENCODE_API_KEY"

// openCodeNativeProviderConfig builds the OpenCode provider configuration for
// the genuine native route. Zen models are addressed through OpenCode's own
// built-in opencode provider, so Forge only supplies the apiKey env reference
// and the selected model definition; the built-in protocol, npm package, and
// endpoint are never overridden. It returns "" when no model was selected. The
// configuration also pins small_model to the same route and enables only that
// provider so a free task can never trigger a paid automatic title through a
// different provider.
func openCodeNativeProviderConfig(spec ProfileSpec, model string) (string, error) {
	providerID := strings.TrimSpace(spec.Provider.Name)
	model = strings.TrimSpace(model)
	if providerID == "" || model == "" {
		return "", nil
	}
	if providerID != "opencode-zen" {
		return "", nil
	}
	if trimmed := strings.TrimPrefix(model, providerID+"/"); trimmed != model {
		model = trimmed
	}
	route := openCodeBuiltinProviderID + "/" + model
	config := map[string]any{
		"model":             route,
		"small_model":       route,
		"enabled_providers": []string{openCodeBuiltinProviderID},
		"provider": map[string]any{
			openCodeBuiltinProviderID: map[string]any{
				"name":    openCodeBuiltinProviderID,
				"options": map[string]any{"apiKey": "{env:" + openCodeNativeCredentialEnv + "}"},
				"models": map[string]any{
					model: openCodeNativeModelDefinition(model),
				},
			},
		},
	}
	data, err := json.Marshal(config)
	if err != nil {
		return "", err
	}
	return string(data), nil
}

// openCodeNativeModelDefinition returns the model entry declared for the
// selected Zen model. The registry context/output limits are declared when the
// model is known; an unknown model omits limits rather than guessing.
func openCodeNativeModelDefinition(model string) map[string]any {
	definition := map[string]any{"name": model}
	if entry, ok := openCodeZenModelRegistry[model]; ok && entry.ContextWindow > 0 {
		definition["limit"] = map[string]any{
			"context": entry.ContextWindow,
			"output":  entry.MaxTokens,
		}
	}
	return definition
}

// openCodeZenModelRegistry carries the verified Zen catalogue limits for the
// genuine built-in opencode route. Entries mirror the authoritative TypeScript
// catalogue; a model absent here declares no limits rather than guessing.
var openCodeZenModelRegistry = map[string]struct {
	ContextWindow int
	MaxTokens     int
}{
	"big-pickle":                  {ContextWindow: 200000, MaxTokens: 128000},
	"union-alpha":                 {ContextWindow: 200000, MaxTokens: 64000},
	"mimo-v2.5-free":              {ContextWindow: 1048576, MaxTokens: 32768},
	"ling-3.0-flash-fin-free":     {ContextWindow: 262144, MaxTokens: 32768},
	"nemotron-3-ultra-free":       {ContextWindow: 1000000, MaxTokens: 65536},
	"nemotron-3.5-lightning-free": {ContextWindow: 1000000, MaxTokens: 65536},
}

func openCodeFileURL(path string) (string, error) {
	abs, err := filepath.Abs(strings.TrimSpace(path))
	if err != nil || strings.TrimSpace(path) == "" {
		return "", fmt.Errorf("OpenCode plugin path is invalid")
	}
	slash := filepath.ToSlash(abs)
	if runtime.GOOS == "windows" && !strings.HasPrefix(slash, "/") {
		slash = "/" + slash
	}
	return (&url.URL{Scheme: "file", Path: slash}).String(), nil
}
