package forge

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"strings"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/lifecycle/change"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/lifecycle/shell"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/profiles/config"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/profiles/manifest"
)

// --- Core type aliases (from manifest package) ---

type profileManifest = manifest.Manifest
type profile = manifest.Profile
type statuslineConfig = manifest.StatuslineConfig

// --- Type aliases ---

type fileWrite = change.FileWrite
type commandAction = change.CommandAction
type planAction = change.Action
type changePlan = change.Plan
type applyResult = change.Result

type shellConflict = shell.Conflict
type shellInstallPlan = shell.InstallPlan

type ClientEnabledReason = config.ClientEnabledReason

const (
	ClientOK                 = config.ClientOK
	ClientDisabledByConfig   = config.ClientDisabledByConfig
	ClientBinaryMissing      = config.ClientBinaryMissing
	ClientCredentialsMissing = config.ClientCredentialsMissing
)

type ForgeConfig = config.Config
type ClientConfig = config.Client
type ProviderOverride = config.ProviderOverride
type ProfileRecipe = config.ProfileRecipe
type QuotaConfig = config.Quota

// --- CLI helpers ---

type stringSliceFlag []string

func (f *stringSliceFlag) String() string {
	return strings.Join(*f, ",")
}

func (f *stringSliceFlag) Set(value string) error {
	value = strings.TrimSpace(value)
	if value == "" {
		return fmt.Errorf("value must not be empty")
	}
	*f = append(*f, value)
	return nil
}

// --- Collection helpers ---

func hasFlag(args []string, flag string) bool {
	for _, arg := range args {
		if arg == flag || strings.HasPrefix(arg, flag+"=") {
			return true
		}
	}
	return false
}

func stringSliceField(m map[string]interface{}, key string, fallback []string) []string {
	raw, ok := m[key].([]interface{})
	if !ok {
		return fallback
	}
	out := []string{}
	for _, item := range raw {
		out = append(out, fmt.Sprint(item))
	}
	return out
}

// --- Process helpers ---

func lookPath(name string) bool { _, err := exec.LookPath(name); return err == nil }

// --- JSON helpers ---

func printJSON(value interface{}) int {
	content, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	fmt.Println(string(content))
	return 0
}
