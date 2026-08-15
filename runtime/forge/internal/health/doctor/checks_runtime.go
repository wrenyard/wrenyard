package doctor

import (
	"encoding/json"
	"fmt"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/catalog"
)

// CodebuddyCLIDoctorCheck checks the native codebuddy CLI installation and
// authentication. It uses the auth SSOT if provided, or falls back to legacy
// path-based checking.
func CodebuddyCLIDoctorCheck(deps Dependencies) map[string]interface{} {
	details := map[string]interface{}{}

	binaryPath, err := exec.LookPath("codebuddy")
	if err != nil {
		binaryPath = deps.CodebuddyShimPath()
		if binaryPath != "" && !deps.Exists(binaryPath) {
			binaryPath = ""
		}
	}
	details["binary"] = binaryPath
	if binaryPath == "" {
		details["hint"] = "npm install -g @tencent-ai/codebuddy-code"
		details["login_hint"] = "run codebuddy once interactively to log in"
		return Check("codebuddy-cli", "warning",
			"codebuddy CLI is not installed. Install with: npm install -g @tencent-ai/codebuddy-code, then run codebuddy once interactively to log in.",
			[]string{"codebuddy"}, details)
	}

	// Use the auth SSOT ProviderAuthStatus if available, otherwise fall back
	// to direct path checking (legacy fallback for isolated compatibility tests).
	if deps.ProviderAuthStatus != nil {
		status := deps.ProviderAuthStatus("codebuddy")
		details["credentials_path"] = status.SourcePath
		if !status.OK {
			details["login_hint"] = "run codebuddy once interactively to log in"
			return Check("codebuddy-cli", "warning",
				"codebuddy credentials are missing. Run codebuddy once interactively to log in, or install with: npm install -g @tencent-ai/codebuddy-code.",
				[]string{status.SourcePath}, details)
		}
		details["credentials"] = "present"
		return Check("codebuddy-cli", "ok",
			"codebuddy CLI is installed and has local authentication state.",
			nil, details)
	}

	// Legacy fallback: direct file checking.
	credsPath := codebuddyAuthPath(runtime.GOOS, deps.UserHome(), deps.LocalAppData)
	details["credentials_path"] = credsPath
	if !deps.Exists(credsPath) {
		details["login_hint"] = "run codebuddy once interactively to log in"
		return Check("codebuddy-cli", "warning",
			"codebuddy credentials are missing. Run codebuddy once interactively to log in, or install with: npm install -g @tencent-ai/codebuddy-code.",
			[]string{credsPath}, details)
	}

	rawCredentials, err := deps.ReadFile(credsPath)
	if err != nil {
		details["credentials"] = "invalid"
		details["credentials_error"] = "unreadable"
		details["login_hint"] = "run codebuddy once interactively to log in again"
		return Check("codebuddy-cli", "warning",
			"codebuddy credentials file could not be read. Run codebuddy once interactively to log in again.",
			nil, details)
	}
	var decodedCredentials interface{}
	if err := json.Unmarshal(rawCredentials, &decodedCredentials); err != nil {
		details["credentials"] = "invalid"
		details["credentials_error"] = "invalid_json"
		details["login_hint"] = "run codebuddy once interactively to log in again"
		return Check("codebuddy-cli", "warning",
			"codebuddy credentials file is not a valid JSON object. Run codebuddy once interactively to log in again.",
			nil, details)
	}
	credentials, ok := decodedCredentials.(map[string]interface{})
	if !ok {
		details["credentials"] = "invalid"
		details["credentials_error"] = "invalid_shape"
		details["login_hint"] = "run codebuddy once interactively to log in again"
		return Check("codebuddy-cli", "warning",
			"codebuddy credentials file root must be a JSON object. Run codebuddy once interactively to log in again.",
			nil, details)
	}
	if len(credentials) == 0 {
		details["credentials"] = "invalid"
		details["credentials_error"] = "empty_object"
		details["login_hint"] = "run codebuddy once interactively to log in again"
		return Check("codebuddy-cli", "warning",
			"codebuddy credentials file does not contain authentication data. Run codebuddy once interactively to log in again.",
			nil, details)
	}

	details["credentials"] = "present"
	return Check("codebuddy-cli", "ok",
		"codebuddy CLI is installed and has local authentication state.",
		nil, details)
}

func codebuddyAuthPath(goos, home, localAppData string) string {
	const authFile = "Tencent-Cloud.coding-copilot.info"
	switch goos {
	case "darwin":
		return filepath.Join(home, "Library", "Application Support", "CodeBuddyExtension", "Data", "Public", "auth", authFile)
	case "windows":
		if strings.TrimSpace(localAppData) == "" {
			localAppData = filepath.Join(home, "AppData", "Local")
		}
		return filepath.Join(localAppData, "CodeBuddyExtension", "Data", "Public", "auth", authFile)
	default:
		return filepath.Join(home, ".local", "share", "CodeBuddyExtension", "Data", "Public", "auth", authFile)
	}
}

// CBModelWhitelistCheck verifies codebuddy profile models.
func CBModelWhitelistCheck(deps Dependencies) map[string]interface{} {
	manifest, err := deps.LoadManifest()
	if err != nil {
		return Check("cb-models", "warning",
			"cb model whitelist check could not load profile manifest.",
			nil, map[string]interface{}{"error": err.Error()})
	}

	reg := deps.CatalogRegistry
	if reg == nil {
		reg = catalog.DefaultRegistry()
	}
	defaultBinding, err := reg.LookupBinding("codebuddy")
	if err != nil {
		return Check("cb-models", "error",
			"cb model whitelist check could not resolve codebuddy binding.",
			nil, map[string]interface{}{"error": err.Error()})
	}

	misconfigured := []map[string]interface{}{}
	for name, p := range manifest.Profiles {
		if p.Client != "codebuddy" {
			continue
		}
		// Validate each codebuddy profile against its own provider binding so
		// local recipes (e.g. a custom codebuddy-local provider with its own
		// registered model set) are checked against their declared models.
		providerName := p.Provider
		if providerName == "" {
			providerName = "codebuddy"
		}
		binding, err := reg.LookupBinding(providerName)
		if err != nil {
			misconfigured = append(misconfigured, map[string]interface{}{
				"profile": name,
				"model":   "",
				"issue":   err.Error(),
			})
			continue
		}
		model := CodebuddyProfileModel(p.Launcher, p.Env, deps.GetStringSlice)
		if model == "" {
			misconfigured = append(misconfigured, map[string]interface{}{
				"profile": name,
				"model":   "",
				"issue":   "no model configured in launcher.default_args",
			})
			continue
		}
		if err := binding.ValidateModel(model); err != nil {
			misconfigured = append(misconfigured, map[string]interface{}{
				"profile": name,
				"model":   model,
				"issue":   err.Error(),
			})
		}
	}

	allowedList := strings.Join(defaultBinding.AllowedModels, ", ")
	details := map[string]interface{}{
		"codebuddy_profiles": len(manifest.Profiles),
		"allowed_models":     defaultBinding.AllowedModels,
	}
	if len(misconfigured) > 0 {
		details["misconfigured"] = misconfigured
		return Check("cb-models", "warning",
			fmt.Sprintf("Some codebuddy profiles use models not in the allowed list (%s).", allowedList),
			nil, details)
	}
	return Check("cb-models", "ok",
		fmt.Sprintf("All codebuddy profile models conform to allowed list (%s).", allowedList),
		nil, details)
}

// CodebuddyProfileModel extracts the model from a codebuddy profile: the
// launcher --model/--model= flag wins first, falling back to the
// ANTHROPIC_MODEL env var.
func CodebuddyProfileModel(launcher map[string]interface{}, env map[string]string, getSlice func(map[string]interface{}, string, []string) []string) string {
	defaultArgs := getSlice(launcher, "default_args", nil)
	for i, arg := range defaultArgs {
		if arg == "--model" && i+1 < len(defaultArgs) {
			return defaultArgs[i+1]
		}
		if strings.HasPrefix(arg, "--model=") {
			return strings.TrimPrefix(arg, "--model=")
		}
	}
	return env["ANTHROPIC_MODEL"]
}
