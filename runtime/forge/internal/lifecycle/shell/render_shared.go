package shell

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/driver"
)

// --- shared string/model/settings helpers ---

func sortedStringKeys(m map[string]string) []string {
	keys := make([]string, 0, len(m))
	for key := range m {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func stringField(m map[string]interface{}, key, fallback string) string {
	if value, ok := m[key].(string); ok && value != "" {
		return value
	}
	return fallback
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

func nonEmpty(value, fallback string) string {
	if value == "" {
		return fallback
	}
	return value
}

func defaultCommand(p Profile) string {
	if p.Client == "opencode" {
		return "opencode"
	}
	return "claude"
}

func splitCommand(raw string) []string {
	parts := []string{}
	var current strings.Builder
	inSingle, inDouble, escape := false, false, false
	for _, r := range raw {
		switch {
		case escape:
			current.WriteRune(r)
			escape = false
		case r == '\\' && !inSingle:
			escape = true
		case r == '\'' && !inDouble:
			inSingle = !inSingle
		case r == '"' && !inSingle:
			inDouble = !inDouble
		case (r == ' ' || r == '\t') && !inSingle && !inDouble:
			if current.Len() > 0 {
				parts = append(parts, expandHome(current.String()))
				current.Reset()
			}
		default:
			current.WriteRune(r)
		}
	}
	if current.Len() > 0 {
		parts = append(parts, expandHome(current.String()))
	}
	return parts
}

func expandHome(value string) string {
	if value == "~" {
		return userHome()
	}
	if strings.HasPrefix(value, "~/") {
		return filepath.Join(userHome(), value[2:])
	}
	return value
}

func userHome() string {
	for _, key := range []string{"HOME", "USERPROFILE"} {
		if home := strings.TrimSpace(os.Getenv(key)); home != "" {
			return home
		}
	}
	home, _ := os.UserHomeDir()
	return home
}

func claudeShortcutCommand(p Profile) []string {
	command := splitCommand(stringField(p.Launcher, "command", defaultCommand(p)))
	if len(command) == 0 {
		command = []string{defaultCommand(p)}
	}
	return append(command, stringSliceField(p.Launcher, "interactive_args", nil)...)
}

func claudeDefaultModel(p Profile) string {
	defaultArgs := stringSliceField(p.Launcher, "default_args", nil)
	for i, arg := range defaultArgs {
		if arg == "--model" && i+1 < len(defaultArgs) {
			return defaultArgs[i+1]
		}
		if strings.HasPrefix(arg, "--model=") {
			return strings.TrimPrefix(arg, "--model=")
		}
	}
	if p.Supports1M {
		return "opus[1m]"
	}
	return "opus"
}

func claudeAvailableModels(p Profile) []string {
	if p.Supports1M {
		return []string{"opus", "opus[1m]", "sonnet", "sonnet[1m]", "haiku"}
	}
	return []string{"opus", "sonnet", "haiku"}
}

func ModelOverrides(p Profile) map[string]string {
	return claudeModelOverrides(p)
}

func claudeModelOverrides(p Profile) map[string]string {
	raw, ok := p.Settings["modelOverrides"].(map[string]interface{})
	if !ok || len(raw) == 0 {
		return nil
	}
	out := map[string]string{}
	for key, value := range raw {
		if stringValue, ok := value.(string); ok && key != "" && stringValue != "" {
			out[key] = stringValue
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

func claudeSettingsJSON(p Profile, env map[string]string) string {
	if env == nil {
		env = map[string]string{}
	}
	modelOverrides := claudeModelOverrides(p)
	if modelOverrides == nil {
		modelOverrides = map[string]string{}
	}
	settings := struct {
		Env             map[string]string `json:"env"`
		Model           string            `json:"model,omitempty"`
		AvailableModels []string          `json:"availableModels,omitempty"`
		ModelOverrides  map[string]string `json:"modelOverrides"`
		StatusLine      struct {
			Type    string `json:"type"`
			Command string `json:"command"`
		} `json:"statusLine"`
		SkipDangerousModePermissionPrompt bool `json:"skipDangerousModePermissionPrompt,omitempty"`
		IncludeCoAuthoredBy               bool `json:"includeCoAuthoredBy"`
	}{
		Env:                               env,
		Model:                             claudeDefaultModel(p),
		AvailableModels:                   claudeAvailableModels(p),
		ModelOverrides:                    modelOverrides,
		SkipDangerousModePermissionPrompt: true,
		IncludeCoAuthoredBy:               false,
	}
	settings.StatusLine.Type = "command"
	settings.StatusLine.Command = "wrenyard runtime statusline --claude-code"
	content, err := json.Marshal(settings)
	if err != nil {
		return `{"env":{},"model":"opus","statusLine":{"type":"command","command":"wrenyard runtime statusline --claude-code"}}`
	}
	return string(content)
}

func claudeSettingsMergeScript() string {
	return strings.Join([]string{
		`const fs=require("fs");`,
		`const path=process.env.FORGE_SETTINGS_PATH;`,
		`const patch=JSON.parse(process.env.FORGE_SETTINGS_PATCH||"{}");`,
		`let current={};`,
		`try{current=JSON.parse(fs.readFileSync(path,"utf8"));}catch{}`,
		`if(!current||typeof current!=="object"||Array.isArray(current))current={};`,
		`const next={...current,...patch};`,
		`fs.writeFileSync(path,JSON.stringify(next,null,2)+"\n");`,
	}, "")
}

func directClaudeEnv(p Profile, apiKey string) map[string]string {
	env := map[string]string{}
	env["FORGE_PROFILE"] = p.Name
	return env
}

func directClaudeSettingsEnv(p Profile, apiKey string) map[string]string {
	env := map[string]string{}
	for key, value := range p.Env {
		if driver.IsClaudeDefaultModelEnv(key) {
			continue
		}
		if key == "ANTHROPIC_AUTH_TOKEN" || key == "ANTHROPIC_API_KEY" {
			continue
		}
		env[key] = value
	}
	env["FORGE_PROFILE"] = p.Name
	return env
}
