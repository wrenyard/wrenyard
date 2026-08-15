package doctor

import (
	"os"
	"path/filepath"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/grok"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/catalog"
)

// GrokDoctorCheck reports on the Forge shell-Grok wrapper: the official grok
// binary, the expected GROK_HOME, config/overlay validity, and the eligible
// provider/model projection set. It never reports credential values and never
// creates files or directories on the filesystem.
func GrokDoctorCheck(deps Dependencies) map[string]interface{} {
	paths := grok.ResolvePaths()
	details := map[string]interface{}{
		"grok_home":    paths.GrokHome,
		"config_path":  paths.ConfigPath,
		"overlay_path": paths.OverlayPath,
	}
	agentParent := grok.AgentHomeParent(filepath.Dir(filepath.Dir(paths.GrokHome)))
	details["agent_home_parent"] = agentParent

	status := "ok"
	messages := []string{}

	// 1. Official grok binary. Missing is reported clearly; forge never
	//    auto-installs it.
	binaryInstalled := deps.GrokBinaryInstalled != nil && deps.GrokBinaryInstalled()
	details["binary_installed"] = binaryInstalled
	if !binaryInstalled {
		status = WorstStatus(status, "warning")
		messages = append(messages, "grok binary not found on PATH; install Grok Build to use `forge shell grok`")
	}

	// Agent runs need a writable parent but doctor leaves no probe artifact.
	parentWritable := probeWritableAncestor(agentParent) == nil
	details["agent_parent_writable"] = parentWritable
	if !parentWritable {
		status = WorstStatus(status, "error")
		messages = append(messages, "agent-grok parent is not writable")
	}

	// 2. GROK_HOME: absent is fine (created on first materialize); if present
	//    it must be a directory. Any other stat error is treated as an error.
	if fi, err := os.Stat(paths.GrokHome); err != nil {
		if !cleanlyMissingPath(paths.GrokHome, err) {
			status = WorstStatus(status, "error")
			messages = append(messages, "GROK_HOME path is inaccessible")
		}
	} else {
		if !fi.IsDir() {
			status = WorstStatus(status, "error")
			messages = append(messages, "GROK_HOME path exists but is not a directory")
		}
	}

	// 3. Config: absent is fine; if present it must be a readable regular file
	//    with valid TOML. Any other stat error is treated as an error.
	if fi, err := os.Stat(paths.ConfigPath); err != nil {
		if !cleanlyMissingPath(paths.ConfigPath, err) {
			status = WorstStatus(status, "error")
			messages = append(messages, "config.toml is inaccessible")
		}
	} else {
		if !fi.Mode().IsRegular() {
			status = WorstStatus(status, "error")
			messages = append(messages, "config.toml exists but is not a regular file")
		} else if err := grok.ValidateConfig(paths.ConfigPath); err != nil {
			status = WorstStatus(status, "error")
			messages = append(messages, "config.toml is not valid: "+err.Error())
		}
	}

	// 4. Overlay validity (absent is fine; api_key or forge-* model is invalid).
	if err := grok.CheckOverlay(paths.OverlayPath); err != nil {
		status = WorstStatus(status, "error")
		messages = append(messages, "overlay invalid")
	}

	// 5. Eligible provider/model projection (no secret leakage).
	reg := deps.CatalogRegistry
	if reg == nil {
		reg = catalog.DefaultRegistry()
	}
	projections, skips := grok.EligibleProjections(reg, deps.ResolveCredential)
	eligible := make([]map[string]interface{}, 0, len(projections))
	for _, p := range projections {
		eligible = append(eligible, map[string]interface{}{
			"id":             p.ID,
			"provider":       p.ProviderID,
			"model":          p.Model,
			"env_key":        p.EnvKey,
			"context_window": p.ContextWindow,
		})
	}
	skipDetails := make([]map[string]interface{}, 0, len(skips))
	for _, s := range skips {
		entry := map[string]interface{}{"provider": s.ProviderID, "reason": s.Reason}
		if s.ModelID != "" {
			entry["model"] = s.ModelID
		}
		skipDetails = append(skipDetails, entry)
	}
	details["eligible_models"] = eligible
	details["skipped"] = skipDetails
	details["eligible_count"] = len(projections)
	if len(projections) == 0 {
		status = WorstStatus(status, "warning")
		messages = append(messages, "no forge-managed Grok projections have credentials")
	}

	home := ""
	if deps.UserHome != nil {
		home = deps.UserHome()
	} else {
		home = os.Getenv("HOME")
		if home == "" {
			home = os.Getenv("USERPROFILE")
		}
		if home == "" {
			home, _ = os.UserHomeDir()
		}
	}
	oauthSource, oauthErr := grok.SelectOAuthSource(filepath.Dir(filepath.Dir(paths.GrokHome)), home)
	details["xai_oauth_available"] = oauthErr == nil
	if oauthErr == nil {
		details["xai_oauth_source"] = oauthSource
	} else {
		status = WorstStatus(status, "warning")
		messages = append(messages, "xAI OAuth auth.json is missing or not copyable")
	}

	message := "Grok shell and agent runtime ready"
	if len(messages) > 0 {
		message = joinMessages(messages)
	}
	return Check("grok", status, message, nil, details)
}

func cleanlyMissingPath(path string, statErr error) bool {
	if !os.IsNotExist(statErr) {
		return false
	}
	current := filepath.Dir(filepath.Clean(path))
	for {
		info, err := os.Stat(current)
		if err == nil {
			return info.IsDir()
		}
		if !os.IsNotExist(err) {
			return false
		}
		parent := filepath.Dir(current)
		if parent == current {
			return true
		}
		current = parent
	}
}

func probeWritableAncestor(target string) error {
	current := filepath.Clean(target)
	for {
		info, err := os.Stat(current)
		if err == nil {
			if !info.IsDir() {
				return os.ErrInvalid
			}
			probe, err := os.CreateTemp(current, ".forge-grok-write-probe-*")
			if err != nil {
				return err
			}
			name := probe.Name()
			closeErr := probe.Close()
			removeErr := os.Remove(name)
			if closeErr != nil {
				return closeErr
			}
			return removeErr
		}
		if !os.IsNotExist(err) {
			return err
		}
		parent := filepath.Dir(current)
		if parent == current {
			return os.ErrNotExist
		}
		current = parent
	}
}

func joinMessages(msgs []string) string {
	out := ""
	for i, m := range msgs {
		if i > 0 {
			out += "; "
		}
		out += m
	}
	return out
}
