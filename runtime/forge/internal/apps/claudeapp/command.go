package claudeapp

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

// Command runs the "forge app" subcommand flow using the supplied
// dependencies. The root package wires Dependencies (including the default
// port, profile/manifest/secret resolution, and path resolvers) before
// invoking Command.
func Command(args []string, deps Dependencies) int {
	if len(args) == 0 {
		Help()
		return 2
	}
	switch args[0] {
	case "use":
		return runUse(args[1:], deps)
	case "reset":
		return runReset(args[1:])
	default:
		Help()
		return 2
	}
}

// BuildConfig resolves a Config from a profile name and port using the supplied
// dependencies. Returns an error when the profile is unknown, incompatible,
// or missing upstream credentials or routes.
func BuildConfig(profileName string, port int, deps Dependencies) (Config, error) {
	manifest, err := deps.LoadManifest()
	if err != nil {
		return Config{}, err
	}
	p, ok := manifest[profileName]
	if !ok {
		return Config{}, fmt.Errorf("forge app: unknown profile %s", profileName)
	}
	if p.Client != "claude" {
		return Config{}, fmt.Errorf("forge app: profile %s is for client %s, expected claude", profileName, p.Client)
	}

	// Resolve provider binding — reject providers without anthropic-messages
	// inference and derive the upstream endpoint from the binding.
	if deps.ResolveProviderBinding == nil {
		return Config{}, fmt.Errorf("forge app: provider binding resolver is unavailable")
	}
	binding, bindErr := deps.ResolveProviderBinding(p)
	if bindErr != nil {
		return Config{}, bindErr
	}
	if binding.Protocol != "anthropic-messages" {
		return Config{}, fmt.Errorf("forge app: profile %s uses provider %s which does not support anthropic-messages", profileName, p.Provider)
	}
	baseURL := strings.TrimSpace(binding.Endpoint)
	if baseURL == "" {
		return Config{}, fmt.Errorf("forge app: profile %s has no inference endpoint", profileName)
	}
	if deps.ResolveCredential == nil {
		return Config{}, fmt.Errorf("forge app: provider credential resolver is unavailable")
	}
	upstreamToken, ok := deps.ResolveCredential(p.Provider)
	upstreamToken = strings.TrimSpace(upstreamToken)
	if !ok || upstreamToken == "" {
		return Config{}, fmt.Errorf("forge app: profile %s has no credential for provider %s; run forge providers auth login %s", profileName, p.Provider, p.Provider)
	}
	routes := routesFromProfile(p, deps.ModelOverrides(p), binding.DefaultModel, deps.ModelDisplayName)
	if len(routes) == 0 {
		return Config{}, fmt.Errorf("forge app: profile %s has no Claude app model routes", profileName)
	}
	state, statePath, err := ReadOrCreateState()
	if err != nil {
		return Config{}, err
	}
	gatewayBaseURL := fmt.Sprintf("http://127.0.0.1:%d", port)
	state.Profile = p.Name
	state.Provider = p.Provider
	state.Port = port
	state.GatewayBaseURL = gatewayBaseURL
	state.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
	if err := WriteState(statePath, state); err != nil {
		return Config{}, err
	}
	return Config{
		Profile:         p,
		Port:            port,
		GatewayBaseURL:  gatewayBaseURL,
		GatewayAPIKey:   state.GatewayAPIKey,
		UpstreamBaseURL: baseURL,
		UpstreamToken:   upstreamToken,
		Routes:          routes,
	}, nil
}

func runUse(args []string, deps Dependencies) int {
	serveProxy := hasFlag(args, "--forge-serve-proxy")
	userArgs := make([]string, 0, len(args))
	for _, arg := range args {
		if arg == "--forge-serve-proxy" {
			continue
		}
		userArgs = append(userArgs, arg)
	}
	profileName, port, asJSON := parseProfileArgs("forge app use", userArgs, deps.DefaultPort)
	if serveProxy {
		cfg, err := BuildConfig(profileName, port, deps)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			return 1
		}
		return Serve(cfg)
	}
	cfg, err := BuildConfig(profileName, port, deps)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	if err := ApplyPolicy(cfg); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	started, err := Ensure(cfg)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	payload := Display(cfg)
	payload["proxy_started"] = started
	payload["gateway_healthy"] = true
	if asJSON {
		return printJSON(payload)
	}
	fmt.Printf("Claude Desktop app profile: %s (%s)\n", cfg.Profile.Name, cfg.Profile.Provider)
	fmt.Printf("gateway: %s\n", cfg.GatewayBaseURL)
	if started {
		fmt.Println("proxy: started")
	} else {
		fmt.Println("proxy: already running")
	}
	fmt.Println("policy: applied")
	return 0
}

func runReset(args []string) int {
	asJSON := hasFlag(args, "--json")
	stopped, stopErr := StopProcesses()
	settingsErr := ResetPolicy()
	var failures []string
	if stopErr != nil {
		failures = append(failures, stopErr.Error())
	}
	if settingsErr != nil {
		failures = append(failures, settingsErr.Error())
	}
	payload := map[string]interface{}{
		"reset":          len(failures) == 0,
		"stopped":        stopped,
		"policy":         registryKey,
		"settings_reset": settingsErr == nil,
	}
	var err error
	if len(failures) > 0 {
		err = errors.New(strings.Join(failures, "; "))
		payload["error"] = err.Error()
	}
	if asJSON {
		printJSON(payload)
	} else if err == nil {
		fmt.Printf("reset Claude Desktop app settings to default; stopped proxy processes: %d\n", stopped)
	} else {
		fmt.Fprintln(os.Stderr, err)
	}
	if err != nil {
		return 1
	}
	return 0
}

// Display builds the status payload for the resolved config.
func Display(cfg Config) map[string]interface{} {
	routes := []map[string]string{}
	for _, route := range cfg.Routes {
		routes = append(routes, map[string]string{"name": route.Name, "upstream_model": route.UpstreamModel})
	}
	return map[string]interface{}{
		"profile":          cfg.Profile.Name,
		"provider":         cfg.Profile.Provider,
		"gateway_base_url": cfg.GatewayBaseURL,
		"policy":           registryKey,
		"routes":           routes,
	}
}

func printJSON(value interface{}) int {
	content, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	fmt.Println(string(content))
	return 0
}

func Help() {
	fmt.Fprintln(os.Stdout, `forge app manages Claude Desktop third-party inference through a Forge local gateway.

Usage:
  forge app use <profile> [--port N] [--json]
  forge app reset [--json]`)
}

func hasFlag(args []string, flag string) bool {
	for _, arg := range args {
		if arg == flag {
			return true
		}
	}
	return false
}

func parseProfileArgs(command string, args []string, defaultPort int) (string, int, bool) {
	port := defaultPort
	asJSON := false
	profileName := ""
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "--json":
			asJSON = true
		case "--port":
			if i+1 >= len(args) {
				fmt.Fprintf(os.Stderr, "%s: --port requires a value\n", command)
				return "", 0, false
			}
			value, err := strconv.Atoi(args[i+1])
			if err != nil || value < 1 || value > 65535 {
				fmt.Fprintf(os.Stderr, "%s: invalid --port %q\n", command, args[i+1])
				return "", 0, false
			}
			port = value
			i++
		default:
			if strings.HasPrefix(args[i], "--") {
				fmt.Fprintf(os.Stderr, "%s: unknown option %s\n", command, args[i])
				return "", 0, false
			}
			if profileName != "" {
				fmt.Fprintf(os.Stderr, "%s: unexpected argument %s\n", command, args[i])
				return "", 0, false
			}
			profileName = args[i]
		}
	}
	if profileName == "" {
		fmt.Fprintf(os.Stderr, "%s: expected profile name\n", command)
	}
	return profileName, port, asJSON
}
