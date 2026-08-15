package manifest

// builtinProfiles defines the complete source-owned profile registry.
// Order is deterministic: Codex order (Sol, Terra, Luna, Spark), then
// CodeBuddy profiles, then Claude Code profiles.
var builtinProfiles = []Profile{
	{
		Name:        "codex-sol",
		Client:      "codex",
		Provider:    "codex",
		Description: "Codex Sol",
		Launcher: map[string]any{
			"command": "codex",
		},
		Env: map[string]string{
			"CODEX_MODEL":            "gpt-5.6-sol",
			"CODEX_REASONING_EFFORT": "xhigh",
		},
		Settings: map[string]any{},
	},
	{
		Name:        "codex-terra",
		Client:      "codex",
		Provider:    "codex",
		Description: "Codex Terra",
		Launcher: map[string]any{
			"command": "codex",
		},
		Env: map[string]string{
			"CODEX_MODEL":            "gpt-5.6-terra",
			"CODEX_REASONING_EFFORT": "xhigh",
		},
		Settings: map[string]any{},
	},
	{
		Name:        "codex-luna",
		Client:      "codex",
		Provider:    "codex",
		Description: "Codex Luna",
		Launcher: map[string]any{
			"command": "codex",
		},
		Env: map[string]string{
			"CODEX_MODEL":            "gpt-5.6-luna",
			"CODEX_REASONING_EFFORT": "xhigh",
		},
		Settings: map[string]any{},
	},
	{
		Name:        "codex-spark",
		Client:      "codex",
		Provider:    "codex-spark",
		Description: "Codex Spark",
		Launcher: map[string]any{
			"command": "codex",
		},
		Env: map[string]string{
			"CODEX_MODEL":            "gpt-5.3-codex-spark",
			"CODEX_REASONING_EFFORT": "xhigh",
		},
		Settings: map[string]any{},
	},
	{
		Name:        "cb-hy",
		Client:      "codebuddy",
		Provider:    "codebuddy",
		Description: "CodeBuddy (Hunyuan)",
		Launcher: map[string]any{
			"command":      "codebuddy",
			"default_args": []any{"--model", "hunyuan-chat"},
		},
		Env:      map[string]string{},
		Settings: map[string]any{},
	},
	{
		Name:        "cb-ds",
		Client:      "codebuddy",
		Provider:    "codebuddy",
		Description: "CodeBuddy (DeepSeek V4 Pro)",
		Launcher: map[string]any{
			"command":      "codebuddy",
			"default_args": []any{"--model", "deepseek-v4-pro"},
		},
		Env:      map[string]string{},
		Settings: map[string]any{},
	},
	{
		Name:        "cb-dsf",
		Client:      "codebuddy",
		Provider:    "codebuddy",
		Description: "CodeBuddy (DeepSeek V4 Flash)",
		Launcher: map[string]any{
			"command":      "codebuddy",
			"default_args": []any{"--model", "deepseek-v4-flash"},
		},
		Env:      map[string]string{},
		Settings: map[string]any{},
	},
	{
		Name:        "cb-kimi",
		Client:      "codebuddy",
		Provider:    "codebuddy",
		Description: "CodeBuddy (Kimi)",
		Launcher: map[string]any{
			"command":      "codebuddy",
			"default_args": []any{"--model", "kimi-k2.6"},
		},
		Env:      map[string]string{},
		Settings: map[string]any{},
	},
	{
		Name:        "cc-kimi",
		Client:      "claude",
		Provider:    "kimi-coding",
		Supports1M:  true,
		Description: "Claude Code (Kimi)",
		Launcher: map[string]any{
			"command":          "claude",
			"interactive_args": []any{"agents", "--permission-mode", "bypassPermissions"},
		},
		Env: map[string]string{
			"ANTHROPIC_BASE_URL":              "https://api.kimi.com/coding/",
			"ANTHROPIC_API_KEY":               "",
			"ANTHROPIC_MODEL":                 "k3[1m]",
			"CLAUDE_CODE_SUBAGENT_MODEL":      "k3[1m]",
			"CLAUDE_CODE_AUTO_COMPACT_WINDOW": "1048576",
			"CLAUDE_CODE_MAX_CONTEXT_TOKENS":  "1048576",
			"ENABLE_TOOL_SEARCH":              "false",
		},
		Settings: map[string]any{
			"modelOverrides": map[string]any{
				"claude-opus-4-8":   "k3[1m]",
				"claude-sonnet-4-6": "k3[1m]",
				"claude-haiku-4-5":  "k3[1m]",
			},
		},
	},
	{
		Name:        "cc-glm",
		Client:      "claude",
		Provider:    "zhipu-coding",
		Description: "Claude Code (GLM)",
		Launcher: map[string]any{
			"command": "claude",
		},
		Env: map[string]string{
			"ANTHROPIC_BASE_URL":         "https://open.bigmodel.cn/api/anthropic",
			"ANTHROPIC_API_KEY":          "",
			"ANTHROPIC_MODEL":            "glm-5.3",
			"CLAUDE_CODE_SUBAGENT_MODEL": "glm-5.3",
		},
		Settings: map[string]any{},
	},
	{
		Name:        "gk-glm",
		Client:      "grok",
		Provider:    "zhipu-coding",
		Description: "Grok (GLM)",
		Launcher: map[string]any{
			"command": "grok",
		},
		Env: map[string]string{
			"GROK_MODEL": "forge-zhipu-coding--glm-5-3",
		},
		Settings: map[string]any{},
	},
	{
		Name:        "gk-kimi",
		Client:      "grok",
		Provider:    "kimi-coding",
		Description: "Grok (Kimi)",
		Launcher: map[string]any{
			"command": "grok",
		},
		Env: map[string]string{
			"GROK_MODEL": "forge-kimi-coding--k3",
		},
		Settings: map[string]any{},
	},
	{
		Name:        "gk-grok",
		Client:      "grok",
		Provider:    "xai",
		Description: "Grok (xAI)",
		Launcher: map[string]any{
			"command": "grok",
		},
		Env: map[string]string{
			"GROK_MODEL": "grok-4.5",
		},
		Settings: map[string]any{},
	},
}

// builtinManifest is the memoized manifest built from builtinProfiles.
var builtinManifest = buildBuiltinManifest()

func buildBuiltinManifest() *Manifest {
	m := &Manifest{
		SchemaVersion: 1,
		Profiles:      make(map[string]Profile, len(builtinProfiles)),
	}
	// Use a slice to preserve deterministic iteration order.
	orderedIDs := make([]string, 0, len(builtinProfiles))
	for _, p := range builtinProfiles {
		orderedIDs = append(orderedIDs, p.Name)
	}
	m.OrderedIDs = orderedIDs
	for _, p := range builtinProfiles {
		cp := p // copy
		cp.Name = p.Name
		if cp.Launcher == nil {
			cp.Launcher = map[string]any{}
		}
		if cp.Env == nil {
			cp.Env = map[string]string{}
		}
		if cp.Settings == nil {
			cp.Settings = map[string]any{}
		}
		m.Profiles[p.Name] = cp
	}
	return m
}

// cloneProfile returns a deep copy of p, cloning all mutable fields.
func cloneProfile(p Profile) Profile {
	p.Env = cloneStrMap(p.Env)
	p.Launcher = cloneAnyMap(p.Launcher)
	p.Settings = cloneAnyMap(p.Settings)
	if p.Statusline != nil {
		sl := *p.Statusline
		if sl.Segments != nil {
			sl.Segments = append([]string{}, sl.Segments...)
		}
		p.Statusline = &sl
	}
	if p.Capabilities != nil {
		p.Capabilities = append([]string{}, p.Capabilities...)
	}
	return p
}

func cloneStrMap(src map[string]string) map[string]string {
	if src == nil {
		return nil
	}
	dst := make(map[string]string, len(src))
	for k, v := range src {
		dst[k] = v
	}
	return dst
}

func cloneAnyMap(src map[string]any) map[string]any {
	if src == nil {
		return nil
	}
	dst := make(map[string]any, len(src))
	for k, v := range src {
		switch val := v.(type) {
		case []any:
			dst[k] = append([]any{}, val...)
		case map[string]any:
			dst[k] = cloneAnyMap(val)
		default:
			dst[k] = v
		}
	}
	return dst
}

// List returns the profile IDs in deterministic display order.
func List() []string {
	out := make([]string, len(builtinManifest.OrderedIDs))
	copy(out, builtinManifest.OrderedIDs)
	return out
}

// Get returns a deep copy of the profile for the given id, or nil if not found.
func Get(id string) *Profile {
	p, ok := builtinManifest.Profiles[id]
	if !ok {
		return nil
	}
	cp := cloneProfile(p)
	return &cp
}

// BuiltinManifest returns a deep copy of the complete built-in manifest.
func BuiltinManifest() *Manifest {
	m := &Manifest{
		SchemaVersion: builtinManifest.SchemaVersion,
		Profiles:      make(map[string]Profile, len(builtinManifest.Profiles)),
		OrderedIDs:    make([]string, len(builtinManifest.OrderedIDs)),
	}
	copy(m.OrderedIDs, builtinManifest.OrderedIDs)
	for k, v := range builtinManifest.Profiles {
		m.Profiles[k] = cloneProfile(v)
	}
	return m
}
