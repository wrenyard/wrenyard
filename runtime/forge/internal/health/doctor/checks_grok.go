package doctor

import (
	"os"
	"path/filepath"
	"strings"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/grok"
)

// GrokDoctorCheck reports the native Grok binary, ephemeral agent-home
// writability, and SpaceXAI OAuth availability. Non-native providers are
// configured per run through the daemon-owned Model Gateway.
func GrokDoctorCheck(deps Dependencies) map[string]interface{} {
	paths := grok.ResolvePaths()
	agentParent := grok.AgentHomeParent(filepath.Dir(filepath.Dir(paths.GrokHome)))
	details := map[string]interface{}{"agent_home_parent": agentParent}
	status := "ok"
	messages := []string{}

	binaryInstalled := deps.GrokBinaryInstalled != nil && deps.GrokBinaryInstalled()
	details["binary_installed"] = binaryInstalled
	if !binaryInstalled {
		status = WorstStatus(status, "warning")
		messages = append(messages, "grok binary not found on PATH; install Grok Build to use native Grok profiles")
	}

	parentWritable := probeWritableAncestor(agentParent) == nil
	details["agent_parent_writable"] = parentWritable
	if !parentWritable {
		status = WorstStatus(status, "error")
		messages = append(messages, "agent-grok parent is not writable")
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
	details["spacex_ai_oauth_available"] = oauthErr == nil
	if oauthErr == nil {
		details["spacex_ai_oauth_source"] = oauthSource
	} else {
		status = WorstStatus(status, "warning")
		messages = append(messages, "SpaceXAI OAuth auth.json is missing or not copyable")
	}

	message := "native Grok runtime ready"
	if len(messages) > 0 {
		message = strings.Join(messages, "; ")
	}
	return Check("grok", status, message, nil, details)
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
			return err
		}
		current = parent
	}
}
