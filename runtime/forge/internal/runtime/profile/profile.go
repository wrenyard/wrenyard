// Package profile owns the profile boundary types and resolution from the
// already-dispatch-gated root manifest profile into a self-contained
// ResolvedProfile. It depends only on the catalog package and must not import
// the root forge package, driver, quota, or statusline. Command/env/stdin
// planning, binary resolution, model validation, and filesystem side effects
// remain in the caller.
package profile

import (
	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/catalog"
)

// InputProfile is a minimal, behavior-preserving snapshot of a root manifest
// profile needed for current-catalog resolution and credential planning.
// It preserves the raw explicit client/provider/secret_ref information so
// resolution can classify compatibility and plan credentials without
// importing the root forge package.
type InputProfile struct {
	Name      string
	Client    string
	Provider  string
	SecretRef *string
	// Launcher is the raw launcher map (command/default_args) carried through
	// unchanged for downstream command construction.
	Launcher map[string]interface{}
	// Env and Settings are cloned on resolution so the root and the resolved
	// profile never share mutable state.
	Env      map[string]string
	Settings map[string]interface{}
}

// Launcher is the resolved command launcher for the profile.
type Launcher struct {
	Command     []string
	DefaultArgs []string
}

// ResolvedProfile is the self-contained output of resolution: a catalog client
// and provider (when the current catalog supports them), the cloned launcher,
// cloned mutable env/settings, the planned credential, and the compatibility
// mode selected by resolution.
type ResolvedProfile struct {
	Name          string
	Client        catalog.Client
	Provider      catalog.Provider
	Launcher      Launcher
	Env           map[string]string
	Settings      map[string]interface{}
	Credential    CredentialPlan
	Compatibility CompatibilityMode
}

// cloneEnv returns a shallow copy of m so callers and the resolved profile do
// not share the underlying map.
func cloneEnv(m map[string]string) map[string]string {
	if m == nil {
		return map[string]string{}
	}
	out := make(map[string]string, len(m))
	for k, v := range m {
		out[k] = v
	}
	return out
}

// cloneSettings returns a shallow copy of m so callers and the resolved profile
// do not share the underlying map.
func cloneSettings(m map[string]interface{}) map[string]interface{} {
	if m == nil {
		return map[string]interface{}{}
	}
	out := make(map[string]interface{}, len(m))
	for k, v := range m {
		out[k] = v
	}
	return out
}

// launcherFromInput extracts the command and default_args from the raw
// launcher map without applying profile defaults; downstream command planning
// owns default/model logic.
func launcherFromInput(l map[string]interface{}) Launcher {
	out := Launcher{}
	if l == nil {
		return out
	}
	if cmd, ok := l["command"].(string); ok && cmd != "" {
		out.Command = splitCommand(cmd)
	}
	if args, ok := l["default_args"].([]interface{}); ok {
		for _, a := range args {
			if s, ok := a.(string); ok {
				out.DefaultArgs = append(out.DefaultArgs, s)
			}
		}
	}
	return out
}

func splitCommand(s string) []string {
	if s == "" {
		return nil
	}
	var out []string
	for _, p := range splitFields(s) {
		p = trimSpace(p)
		if p != "" {
			out = append(out, p)
		}
	}
	return out
}

func splitFields(s string) []string {
	var fields []string
	cur := ""
	inQuote := false
	quote := byte(0)
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case inQuote:
			if c == quote {
				inQuote = false
			} else {
				cur += string(c)
			}
		case c == '"' || c == '\'':
			inQuote = true
			quote = c
		case c == ' ' || c == '\t' || c == '\n':
			fields = append(fields, cur)
			cur = ""
		default:
			cur += string(c)
		}
	}
	if cur != "" || inQuote {
		fields = append(fields, cur)
	}
	return fields
}

func trimSpace(s string) string {
	start := 0
	for start < len(s) && (s[start] == ' ' || s[start] == '\t' || s[start] == '\n' || s[start] == '\r') {
		start++
	}
	end := len(s)
	for end > start && (s[end-1] == ' ' || s[end-1] == '\t' || s[end-1] == '\n' || s[end-1] == '\r') {
		end--
	}
	return s[start:end]
}
