package statusline

import (
	"os"
	"strings"
)

func DetectProfile(input Input, profiles map[string]Profile) string {
	if env := strings.ToLower(strings.TrimSpace(os.Getenv("FORGE_PROFILE"))); env != "" {
		if _, ok := profiles[env]; ok {
			return env
		}
		if strings.HasPrefix(env, "cb-") {
			return firstProfile(profiles, "cb")
		}
	}
	client := strings.ToLower(clientName(input.Client))
	transcript := strings.ToLower(strings.ReplaceAll(input.Transcript, "\\", "/"))
	switch {
	case strings.Contains(transcript, "/.codebuddy/projects/"):
		return firstProfile(profiles, "ccc")
	case strings.Contains(client, "codebuddy"):
		if name := firstProfile(profiles, "cb"); name != "unknown" {
			return name
		}
		return firstProfile(profiles, "ccc")
	case client == "claude" || strings.Contains(transcript, "/.claude/"):
		return firstProfile(profiles, "ccc")
	default:
		return "unknown"
	}
}

func clientName(raw any) string {
	switch v := raw.(type) {
	case map[string]any:
		for _, key := range []string{"name", "id"} {
			if s, ok := v[key].(string); ok {
				return strings.TrimSpace(s)
			}
		}
	case map[string]string:
		if v["name"] != "" {
			return strings.TrimSpace(v["name"])
		}
		return strings.TrimSpace(v["id"])
	case string:
		return strings.TrimSpace(v)
	}
	return ""
}

func firstProfile(profiles map[string]Profile, family string) string {
	if _, ok := profiles[family]; ok {
		return family
	}
	for name, p := range profiles {
		provider := strings.ToLower(p.Provider)
		switch family {
		case "cb":
			if strings.HasPrefix(name, "cb-") {
				return name
			}
		case "ccg":
			if name == "ccg" || provider == "zhipu-coding" {
				return name
			}
		case "ccc":
			if name == "ccc" || provider == "anthropic" {
				return name
			}
		}
	}
	return "unknown"
}
