package claudeapp

import "strings"

func routesFromProfile(
	p Profile,
	overrides map[string]string,
	providerDefaultModel string,
	modelDisplayName func(providerID, modelID string) string,
) []ModelRoute {
	upstreams := make(map[string]string, len(slotDefs))
	for _, def := range slotDefs {
		upstreams[def.slot] = strings.TrimSpace(p.Env[def.modelEnv])
		if upstreams[def.slot] == "" {
			upstreams[def.slot] = routeOverrideModel(overrides, def.slot, def.modelID)
		}
		if upstreams[def.slot] == "" {
			upstreams[def.slot] = providerDefaultModel
		}
	}
	// Fallback: empty slots inherit from related slots.
	if upstreams["sonnet"] == "" {
		upstreams["sonnet"] = firstNonEmpty(upstreams["opus"], upstreams["haiku"])
	}
	if upstreams["opus"] == "" {
		upstreams["opus"] = upstreams["sonnet"]
	}
	if upstreams["haiku"] == "" {
		upstreams["haiku"] = upstreams["sonnet"]
	}
	var routes []ModelRoute
	for _, def := range slotDefs {
		upstream := upstreams[def.slot]
		if upstream == "" {
			continue
		}
		route := ModelRoute{
			Name:          def.modelID,
			DisplayName:   routeDisplayName(p.Provider, upstream, p.Env[def.nameEnv], def.modelID, modelDisplayName),
			Slot:          def.slot,
			UpstreamModel: upstream,
		}
		if route.LabelOverride == "" {
			route.LabelOverride = route.DisplayName
		}
		route.Supports1M = modelSupports1M(route.UpstreamModel) || p.Supports1M
		routes = append(routes, route)
	}
	return routes
}

func routeOverrideModel(overrides map[string]string, _ string, modelID string) string {
	if len(overrides) == 0 {
		return ""
	}
	if value := strings.TrimSpace(overrides[modelID]); value != "" {
		return value
	}
	return ""
}

func routeDisplayName(
	providerID string,
	upstreamModel string,
	explicit string,
	fallback string,
	modelDisplayName func(providerID, modelID string) string,
) string {
	explicit = strings.TrimSpace(explicit)
	if explicit != "" {
		return explicit
	}
	clean := strings.TrimSpace(upstreamModel)
	if clean == "" {
		return fallback
	}
	base, _ := modelWithoutContextTag(clean)
	if strings.HasSuffix(strings.ToLower(base), "-1m") {
		base = strings.TrimSpace(base[:len(base)-len("-1m")])
	}
	if modelDisplayName != nil {
		if displayName := strings.TrimSpace(modelDisplayName(providerID, base)); displayName != "" {
			return displayName
		}
	}
	switch base {
	case "claude-opus-4.8":
		return "Opus 4.8"
	case "claude-sonnet-4.6":
		return "Sonnet 4.6"
	case "claude-haiku-4.5":
		return "Haiku 4.5"
	}
	if strings.HasPrefix(base, "deepseek-") {
		return friendlyModelName(base, "DeepSeek")
	}
	if strings.HasPrefix(base, "gemini-") {
		return friendlyModelName(base, "Gemini")
	}
	if strings.HasPrefix(base, "glm-") {
		return friendlyModelName(base, "GLM")
	}
	if strings.HasPrefix(base, "kimi-") {
		return friendlyModelName(base, "Kimi")
	}
	return fallback
}

func friendlyModelName(model, prefix string) string {
	clean := strings.TrimSpace(model)
	clean = strings.TrimSuffix(clean, "-air")
	parts := strings.Split(strings.TrimPrefix(clean, strings.ToLower(prefix)+"-"), "-")
	for i, part := range parts {
		if part == "" {
			continue
		}
		switch strings.ToLower(part) {
		case "air":
			parts[i] = "Air"
		default:
			if len(part) > 0 {
				parts[i] = strings.ToUpper(part[:1]) + part[1:]
			}
		}
	}
	return prefix + " " + strings.Join(parts, " ")
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func requestedSlot(model string) string {
	lower := strings.ToLower(strings.TrimSpace(model))
	switch {
	case lower == opusID, lower == "claude-opus-4-7", lower == "claude-opus-4-6", strings.Contains(lower, "opus"):
		return "opus"
	case lower == sonnetID, lower == "claude-sonnet-4-5", strings.Contains(lower, "sonnet"):
		return "sonnet"
	case lower == haikuID, strings.Contains(lower, "haiku"):
		return "haiku"
	default:
		return ""
	}
}

func publicModelID(route ModelRoute) string {
	if id, ok := publicClaudeModelID(route.UpstreamModel); ok {
		return id
	}
	if route.Supports1M {
		return route.Name + "[1m]"
	}
	return route.Name
}

func publicClaudeModelID(upstreamModel string) (string, bool) {
	base, hasClaudeContextTag := modelWithoutContextTag(upstreamModel)
	if !strings.HasPrefix(strings.ToLower(base), "claude-") {
		return "", false
	}
	supports1M := hasClaudeContextTag
	if strings.HasSuffix(strings.ToLower(base), "-1m") {
		supports1M = true
		base = strings.TrimSpace(base[:len(base)-len("-1m")])
	}
	id := hyphenatedVersionID(base)
	if supports1M {
		id += "[1m]"
	}
	return id, true
}

func modelSupports1M(model string) bool {
	base, hasClaudeContextTag := modelWithoutContextTag(model)
	return hasClaudeContextTag || strings.HasSuffix(strings.ToLower(base), "-1m")
}

func modelWithoutContextTag(model string) (string, bool) {
	clean := strings.TrimSpace(model)
	if strings.HasSuffix(strings.ToLower(clean), "[1m]") {
		return strings.TrimSpace(clean[:len(clean)-len("[1m]")]), true
	}
	return clean, false
}

func hyphenatedVersionID(model string) string {
	parts := strings.Split(model, "-")
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		if isDottedNumeric(part) {
			out = append(out, strings.Split(part, ".")...)
			continue
		}
		out = append(out, part)
	}
	return strings.Join(out, "-")
}

func isDottedNumeric(value string) bool {
	if !strings.Contains(value, ".") {
		return false
	}
	for _, part := range strings.Split(value, ".") {
		if part == "" {
			return false
		}
		for _, r := range part {
			if r < '0' || r > '9' {
				return false
			}
		}
	}
	return true
}

func publicModelDisplayName(route ModelRoute) string {
	if route.Supports1M {
		return route.DisplayName + " (1M context)"
	}
	return route.DisplayName
}

func configuredModelID(route ModelRoute) string {
	if id, ok := publicClaudeModelID(route.UpstreamModel); ok {
		return id
	}
	return route.Name
}

func localModelEntries(routes []ModelRoute) []map[string]interface{} {
	models := []map[string]interface{}{}
	for _, route := range routes {
		name := configuredModelID(route)
		if route.Supports1M {
			name = publicModelID(route)
		}
		model := map[string]interface{}{
			"name":          name,
			"labelOverride": firstNonEmpty(route.LabelOverride, route.DisplayName),
		}
		models = append(models, model)
	}
	return models
}
