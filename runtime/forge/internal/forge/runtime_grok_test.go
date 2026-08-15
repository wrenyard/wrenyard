package forge

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/grok"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/catalog"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/driver"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/execution"
	profilepkg "github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/profile"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/protocol"
	"github.com/pelletier/go-toml/v2"
)

func isolateGrokRuntimeTest(t *testing.T) (home, dataHome string) {
	t.Helper()
	home = t.TempDir()
	dataHome = t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("XDG_DATA_HOME", dataHome)
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	if err := writeAuth(map[string]AuthEntry{
		"zhipu-coding": {Type: "api", Key: "zhipu-test-secret"},
		"kimi-coding":  {Type: "api", Key: "kimi-test-secret"},
	}); err != nil {
		t.Fatal(err)
	}
	return home, dataHome
}

func TestPrepareGrokRuntimeUsesProjectionSSOTWithoutTouchingShellHome(t *testing.T) {
	_, _ = isolateGrokRuntimeTest(t)
	_, selectedProvider, err := catalog.DefaultRegistry().ResolveBinding("grok", "zhipu-coding")
	if err != nil {
		t.Fatal(err)
	}
	shellHome := filepath.Join(forgeDataDir(), "grok", "shell-grok")
	if err := os.MkdirAll(shellHome, 0o700); err != nil {
		t.Fatal(err)
	}
	shellConfig := filepath.Join(shellHome, "config.toml")
	original := []byte("shell-owned = true\n")
	if err := os.WriteFile(shellConfig, original, 0o600); err != nil {
		t.Fatal(err)
	}

	prep, err := prepareClientRuntime(
		execution.ProfileDefinition{Client: "grok", Provider: "zhipu-coding"},
		profilepkg.ResolvedProfile{Provider: selectedProvider, Credential: profilepkg.CredentialPlan{Value: "zhipu-test-secret", Source: "provider"}},
	)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(filepath.Clean(prep.HomeParent), filepath.Join("grok", "agent-grok")) || strings.Contains(prep.HomeParent, "shell-grok") {
		t.Fatalf("agent home parent = %q", prep.HomeParent)
	}
	if len(prep.Files) != 1 || prep.Files[0].RelativePath != "config.toml" {
		t.Fatalf("prepared files = %+v", prep.Files)
	}
	config := string(prep.Files[0].Data)
	for _, model := range []string{"forge-zhipu-coding--glm-5-3", "forge-kimi-coding--k3"} {
		if !strings.Contains(config, model) {
			t.Fatalf("full eligible projection config missing %q:\n%s", model, config)
		}
	}
	for _, secret := range []string{"zhipu-test-secret", "kimi-test-secret"} {
		if strings.Contains(config, secret) {
			t.Fatal("prepared config leaked an API key value")
		}
	}
	if len(prep.Env) != 1 || prep.Env["FORGE_GROK_ZHIPU_CODING_API_KEY"] != "zhipu-test-secret" {
		t.Fatalf("canonical Grok env = %#v", prep.Env)
	}
	if !reflect.DeepEqual(prep.SensitiveEnvKeys, []string{"FORGE_GROK_ZHIPU_CODING_API_KEY"}) {
		t.Fatalf("selected sensitive env keys = %#v", prep.SensitiveEnvKeys)
	}
	if !reflect.DeepEqual(prep.SensitiveSources, []driver.PreparedSensitiveSource{{Path: authPath()}}) {
		t.Fatalf("managed Grok sensitive sources = %#v", prep.SensitiveSources)
	}
	current, _ := os.ReadFile(shellConfig)
	if !bytes.Equal(current, original) {
		t.Fatal("agent preparation modified shell-grok config")
	}
}

func prepareSecretRefGrokPlan(t *testing.T, globalAuth map[string]AuthEntry, selectedSecret string) driver.CommandPlan {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("XDG_DATA_HOME", t.TempDir())
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	t.Setenv("SELECTED_GROK_KEY", selectedSecret)
	if err := writeAuth(globalAuth); err != nil {
		t.Fatal(err)
	}
	setFakeClientsOnPath(t, "grok")
	secretRef := "env:SELECTED_GROK_KEY"
	deps := executionDependencies()
	deps.LoadProfile = func(name string) (execution.ProfileDefinition, bool, error) {
		if name != "gk-secret-ref" {
			return execution.ProfileDefinition{}, false, nil
		}
		return execution.ProfileDefinition{
			Name: name, Client: "grok", Provider: "zhipu-coding", SecretRef: &secretRef,
			Launcher: map[string]interface{}{"command": "grok"},
			Env:      map[string]string{"GROK_MODEL": "forge-zhipu-coding--glm-5-3"},
			Settings: map[string]interface{}{},
		}, true, nil
	}
	plan, family, err := execution.Prepare(execution.Request{
		ProfileName: "gk-secret-ref", Prompt: "inspect selected projection",
		WorkDir: t.TempDir(), Permission: catalog.PermissionReadonly,
	}, deps)
	if err != nil {
		t.Fatal(err)
	}
	if family != "grok" || plan.Dialect != catalog.DialectGrok {
		t.Fatalf("secret-ref Grok plan family/dialect = %q/%q", family, plan.Dialect)
	}
	return plan
}

func TestGrokSelectedSecretRefCredentialIncludesProviderWithoutGlobalAuth(t *testing.T) {
	plan := prepareSecretRefGrokPlan(t, map[string]AuthEntry{
		"kimi-coding": {Type: "api", Key: "other-global-kimi"},
	}, "selected-secret-only")
	if plan.Env["FORGE_GROK_ZHIPU_CODING_API_KEY"] != "selected-secret-only" {
		t.Fatalf("selected canonical Grok credential = %#v", plan.Env)
	}
	if _, present := plan.Env["FORGE_GROK_KIMI_CODING_API_KEY"]; present {
		t.Fatalf("unrelated eligible provider credential reached child env: %#v", plan.Env)
	}
	config, err := os.ReadFile(filepath.Join(plan.ConfigDir, "config.toml"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(config), "forge-zhipu-coding--glm-5-3") || !strings.Contains(string(config), "forge-kimi-coding--k3") {
		t.Fatalf("selected/other projections missing from complete materialization:\n%s", config)
	}
	if bytes.Contains(config, []byte("selected-secret-only")) || bytes.Contains(config, []byte("other-global-kimi")) {
		t.Fatal("Grok materialized config leaked a credential")
	}
	hook, err := os.ReadFile(filepath.Join(plan.ConfigDir, "hooks", "forge-bash-guard.json"))
	if err != nil {
		t.Fatal(err)
	}
	prompt, err := os.ReadFile(filepath.Join(plan.ConfigDir, "prompt.txt"))
	if err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{"selected-secret-only", "other-global-kimi"} {
		if bytes.Contains(hook, []byte(secret)) || bytes.Contains(prompt, []byte(secret)) || strings.Contains(strings.Join(plan.Command, "\n"), secret) {
			t.Fatal("Grok hook, prompt, or argv leaked a credential")
		}
	}
}

func TestGrokSelectedSecretRefCredentialOverridesDifferentGlobalCredential(t *testing.T) {
	plan := prepareSecretRefGrokPlan(t, map[string]AuthEntry{
		"zhipu-coding": {Type: "api", Key: "wrong-global-zhipu"},
		"kimi-coding":  {Type: "api", Key: "independent-global-kimi"},
	}, "selected-profile-zhipu")
	if got := plan.Env["FORGE_GROK_ZHIPU_CODING_API_KEY"]; got != "selected-profile-zhipu" {
		t.Fatalf("selected profile credential precedence = %q", got)
	}
	if _, present := plan.Env["FORGE_GROK_KIMI_CODING_API_KEY"]; present {
		t.Fatal("other provider global credential reached child env")
	}
	for _, secret := range []string{"wrong-global-zhipu", "selected-profile-zhipu", "independent-global-kimi"} {
		config, err := os.ReadFile(filepath.Join(plan.ConfigDir, "config.toml"))
		if err != nil {
			t.Fatal(err)
		}
		if bytes.Contains(config, []byte(secret)) {
			t.Fatalf("materialized config contained credential for secret case %q", secret)
		}
	}
}

func TestGrokCompletePlanEncodesEmbeddedNotesmdCapability(t *testing.T) {
	_, _ = isolateGrokRuntimeTest(t)
	setFakeClientsOnPath(t, "grok")
	for _, mode := range []catalog.PermissionMode{catalog.PermissionReadonly, catalog.PermissionEdit} {
		t.Run(string(mode), func(t *testing.T) {
			plan, family, err := execution.Prepare(execution.Request{
				ProfileName: "gk-glm", Prompt: "inspect notes", WorkDir: t.TempDir(),
				Permission: mode, Capabilities: []string{"notesmd"},
			}, executionDependencies())
			if err != nil {
				t.Fatal(err)
			}
			if family != "grok" || !containsGrokOrderedArgs(plan.Command, "--allow", "Bash(notesmd-cli *)") {
				t.Fatalf("Grok embedded notesmd plan = family %q command %v", family, plan.Command)
			}
		})
	}
}

func TestGrokHTTPMCPCapabilityEndToEndPrepare(t *testing.T) {
	_, _ = isolateGrokRuntimeTest(t)
	setFakeClientsOnPath(t, "grok")

	// Set up a shell-grok config that must remain untouched.
	shellHome := filepath.Join(forgeDataDir(), "grok", "shell-grok")
	if err := os.MkdirAll(shellHome, 0o700); err != nil {
		t.Fatal(err)
	}
	shellConfig := filepath.Join(shellHome, "config.toml")
	original := []byte("shell-owned = true\n")
	if err := os.WriteFile(shellConfig, original, 0o600); err != nil {
		t.Fatal(err)
	}

	deps := executionDependencies()
	deps.LoadProfile = func(name string) (execution.ProfileDefinition, bool, error) {
		if name != "gk-glm" {
			return execution.ProfileDefinition{}, false, nil
		}
		return execution.ProfileDefinition{
			Name: name, Client: "grok", Provider: "zhipu-coding",
			Capabilities: []string{"ure-internal-qa"},
			Launcher:     map[string]interface{}{"command": "grok"},
			Env:          map[string]string{"GROK_MODEL": "forge-zhipu-coding--glm-5-3"},
			Settings:     map[string]interface{}{},
		}, true, nil
	}
	// Override capability resolution to assert the merged stable names and
	// return a fake HTTP MCP server.
	deps.ResolveCapabilities = func(names []string) (driver.CapabilityResult, error) {
		expected := []string{"ure-internal-qa", "notesmd"}
		if !reflect.DeepEqual(names, expected) {
			t.Fatalf("ResolveCapabilities names = %#v, want %#v", names, expected)
		}
		return driver.CapabilityResult{
			Tools: driver.CapabilityTools{
				MCP: []driver.CapabilityServer{
					{Name: "ure", URL: "http://127.0.0.1:19999/mcp"},
					{Name: "ure-materials", URL: "http://127.0.0.1:18766/mcp"},
				},
			},
		}, nil
	}

	headers := map[string]map[string]string{
		"ure":           {"x-tai-identity": "test-id", "X-URE-Profile": "internal-qa"},
		"ure-materials": {"X-URE-Material-Capability": "material-capability"},
	}
	plan, family, err := execution.Prepare(execution.Request{
		ProfileName:    "gk-glm",
		Prompt:         "run with ure MCP",
		WorkDir:        t.TempDir(),
		Permission:     catalog.PermissionReadonly,
		Capabilities:   []string{"notesmd", "ure-internal-qa"},
		MCPHTTPHeaders: headers,
	}, deps)
	if err != nil {
		t.Fatalf("Prepare with profile defaults + CLI capabilities: %v", err)
	}
	if family != "grok" || plan.Dialect != catalog.DialectGrok {
		t.Fatalf("family/dialect = %q/%q", family, plan.Dialect)
	}

	// Assert config.toml contains native Grok mcp_servers.ure.
	config, err := os.ReadFile(filepath.Join(plan.ConfigDir, "config.toml"))
	if err != nil {
		t.Fatal(err)
	}
	configStr := string(config)
	if !strings.Contains(configStr, "mcp_servers.ure") {
		t.Fatalf("config.toml missing mcp_servers.ure:\n%s", configStr)
	}
	if !strings.Contains(configStr, "http://127.0.0.1:19999/mcp") {
		t.Fatalf("config.toml missing ure URL:\n%s", configStr)
	}
	if !strings.Contains(configStr, "mcp_servers.ure-materials") || !strings.Contains(configStr, "http://127.0.0.1:18766/mcp") {
		t.Fatalf("config.toml missing ure-materials server:\n%s", configStr)
	}
	var parsedConfig map[string]interface{}
	if err := toml.Unmarshal(config, &parsedConfig); err != nil {
		t.Fatalf("multi-server config.toml must parse without duplicate keys: %v\n%s", err, configStr)
	}
	if !strings.Contains(configStr, "enabled = true") {
		t.Fatalf("config.toml missing enabled = true:\n%s", configStr)
	}
	if !strings.Contains(configStr, "x-tai-identity") || !strings.Contains(configStr, "X-URE-Profile") {
		t.Fatalf("config.toml missing ure headers:\n%s", configStr)
	}

	// Assert headless MCP permission allowlist: exactly one --allow MCPTool(ure__*)
	// pair and no broad approval or bypass flags.
	if !containsGrokOrderedArgs(plan.Command, "--allow", "MCPTool(ure__*)") {
		t.Fatalf("MCP headless argv missing --allow MCPTool(ure__*): %v", plan.Command)
	}
	if !containsGrokOrderedArgs(plan.Command, "--allow", "MCPTool(ure-materials__*)") {
		t.Fatalf("MCP headless argv missing --allow MCPTool(ure-materials__*): %v", plan.Command)
	}
	if containsGrokOrderedArgs(plan.Command, "--always-approve") {
		t.Fatalf("readonly MCP plan must not contain --always-approve: %v", plan.Command)
	}

	// Assert argv and plan.Env do not contain the fake identity or env var.
	planStr := strings.Join(plan.Command, " ") + "\n" + fmt.Sprintf("%v", plan.Env)
	if strings.Contains(planStr, "test-id") || strings.Contains(planStr, "material-capability") {
		t.Fatal("argv or plan.Env leaked identity value")
	}
	if _, present := plan.Env["FORGE_MCP_HTTP_HEADERS_JSON"]; present {
		t.Fatal("plan.Env contains FORGE_MCP_HTTP_HEADERS_JSON")
	}
	for _, envKey := range plan.Env {
		if strings.Contains(envKey, "test-id") || strings.Contains(envKey, "material-capability") {
			t.Fatal("plan.Env value contains test-id")
		}
	}
	for _, arg := range plan.Command {
		if strings.Contains(arg, "test-id") || strings.Contains(arg, "material-capability") {
			t.Fatalf("argv argument contains test-id: %q", arg)
		}
	}

	// Assert existing shell-grok config remains byte-identical.
	current, _ := os.ReadFile(shellConfig)
	if !bytes.Equal(current, original) {
		t.Fatal("agent preparation modified shell-grok config")
	}
}

func TestGrokHTTPMCPCapabilityDeduplicatesPermissionAllow(t *testing.T) {
	_, _ = isolateGrokRuntimeTest(t)
	setFakeClientsOnPath(t, "grok")

	deps := executionDependencies()
	deps.LoadProfile = func(name string) (execution.ProfileDefinition, bool, error) {
		if name != "gk-glm" {
			return execution.ProfileDefinition{}, false, nil
		}
		return execution.ProfileDefinition{
			Name: name, Client: "grok", Provider: "zhipu-coding",
			Capabilities: []string{"mcp-dedup"},
			Launcher:     map[string]interface{}{"command": "grok"},
			Env:          map[string]string{"GROK_MODEL": "forge-zhipu-coding--glm-5-3"},
			Settings:     map[string]interface{}{},
		}, true, nil
	}
	deps.ResolveCapabilities = func(names []string) (driver.CapabilityResult, error) {
		return driver.CapabilityResult{
			Tools: driver.CapabilityTools{
				MCP: []driver.CapabilityServer{
					{Name: "b", URL: "http://127.0.0.1:1/mcp"},
					{Name: "a", URL: "http://127.0.0.1:2/mcp"},
					{Name: "b", URL: "http://127.0.0.1:3/mcp"},
					{Name: "c", URL: "http://127.0.0.1:4/mcp"},
				},
			},
		}, nil
	}

	plan, family, err := execution.Prepare(execution.Request{
		ProfileName: "gk-glm", Prompt: "test MCP dedup",
		WorkDir: t.TempDir(), Permission: catalog.PermissionReadonly,
		Capabilities: []string{"mcp-dedup"},
	}, deps)
	if err != nil {
		t.Fatal(err)
	}
	if family != "grok" {
		t.Fatalf("family = %q", family)
	}

	// Collect all --allow MCPTool pairs and verify dedup + sort order.
	type mcpAllow struct{ flag, rule string }
	var allows []mcpAllow
	for i := 0; i+1 < len(plan.Command); i++ {
		if plan.Command[i] == "--allow" && strings.HasPrefix(plan.Command[i+1], "MCPTool(") {
			allows = append(allows, mcpAllow{flag: plan.Command[i], rule: plan.Command[i+1]})
		}
	}
	if len(allows) != 3 {
		t.Fatalf("expected 3 distinct MCPTool allows (a, b, c), got %d: %+v", len(allows), allows)
	}
	expectedRules := []string{"MCPTool(a__*)", "MCPTool(b__*)", "MCPTool(c__*)"}
	for i, want := range expectedRules {
		if allows[i].rule != want {
			t.Fatalf("MCP allow[%d] = %q, want %q", i, allows[i].rule, want)
		}
	}

	// Confirm no broad permission flag appears.
	if containsGrokOrderedArgs(plan.Command, "--always-approve") || containsGrokOrderedArgs(plan.Command, "--permission-mode", "bypassPermissions") {
		t.Fatalf("MCP dedup plan must not use always-approve or bypass: %v", plan.Command)
	}
}

func TestGrokHTTPMCPCapabilityNoMCPPermissionArgsWhenNoMCPServer(t *testing.T) {
	_, _ = isolateGrokRuntimeTest(t)
	setFakeClientsOnPath(t, "grok")

	deps := executionDependencies()
	deps.LoadProfile = func(name string) (execution.ProfileDefinition, bool, error) {
		if name != "gk-glm" {
			return execution.ProfileDefinition{}, false, nil
		}
		return execution.ProfileDefinition{
			Name: name, Client: "grok", Provider: "zhipu-coding",
			Capabilities: []string{"browser-use"},
			Launcher:     map[string]interface{}{"command": "grok"},
			Env:          map[string]string{"GROK_MODEL": "forge-zhipu-coding--glm-5-3"},
			Settings:     map[string]interface{}{},
		}, true, nil
	}
	deps.ResolveCapabilities = func(names []string) (driver.CapabilityResult, error) {
		return driver.CapabilityResult{}, nil
	}

	plan, family, err := execution.Prepare(execution.Request{
		ProfileName: "gk-glm", Prompt: "test no MCP", WorkDir: t.TempDir(),
		Permission: catalog.PermissionReadonly, Capabilities: []string{"browser-use"},
	}, deps)
	if err != nil {
		t.Fatal(err)
	}
	if family != "grok" {
		t.Fatalf("family = %q", family)
	}
	for i := 0; i < len(plan.Command); i++ {
		if plan.Command[i] == "--allow" && i+1 < len(plan.Command) && strings.HasPrefix(plan.Command[i+1], "MCPTool(") {
			t.Fatalf("MCP --allow arg present when effective pack has no HTTP MCP server: %v", plan.Command)
		}
	}
}

func TestGrokHTTPMCPRejectsNonHTTPServer(t *testing.T) {
	_, _ = isolateGrokRuntimeTest(t)
	setFakeClientsOnPath(t, "grok")

	// browser-use has a command-based MCP server (stdio), not URL-based.
	// Grok only supports HTTP URL MCP servers.
	_, _, err := execution.Prepare(execution.Request{
		ProfileName:  "gk-glm",
		Prompt:       "use browser",
		WorkDir:      t.TempDir(),
		Permission:   catalog.PermissionReadonly,
		Capabilities: []string{"browser-use"},
	}, executionDependencies())
	if err == nil || !strings.Contains(err.Error(), "only supports HTTP MCP servers") {
		t.Fatalf("expected error for non-HTTP MCP server, got %v", err)
	}
}

func TestGrokMCPHTTPHeadersMalformedJSON(t *testing.T) {
	_, err := driver.ParseMCPHTTPHeaders(`not-json`, nil)
	if err == nil || !strings.Contains(err.Error(), "malformed JSON") {
		t.Fatalf("expected malformed JSON error, got %v", err)
	}
}

func TestGrokMCPHTTPHeadersEmptyName(t *testing.T) {
	_, err := driver.ParseMCPHTTPHeaders(`{"":{"x": "y"}}`, nil)
	if err == nil || !strings.Contains(err.Error(), "empty server name") {
		t.Fatalf("expected empty server name error, got %v", err)
	}
}

func TestGrokMCPHTTPHeadersCRLFRejected(t *testing.T) {
	_, err := driver.ParseMCPHTTPHeaders(`{"s":{"h\r":"v"}}`, nil)
	if err == nil || !strings.Contains(err.Error(), "CR or LF") {
		t.Fatalf("expected CR/LF error, got %v", err)
	}
	_, err = driver.ParseMCPHTTPHeaders(`{"s":{"h":"v\r\n"}}`, nil)
	if err == nil || !strings.Contains(err.Error(), "CR or LF") {
		t.Fatalf("expected CR/LF error for value, got %v", err)
	}
}

func TestGrokMCPHTTPHeadersNilHeaders(t *testing.T) {
	_, err := driver.ParseMCPHTTPHeaders(`{"s":null}`, nil)
	if err == nil || !strings.Contains(err.Error(), "nil headers") {
		t.Fatalf("expected nil headers error, got %v", err)
	}
}

func TestGrokMCPTomlSectionRendersCorrectly(t *testing.T) {
	section, err := grok.MCPTomlSection("ure", "https://mcp.example.com", map[string]string{"x-tai-identity": "test-id"})
	if err != nil {
		t.Fatal(err)
	}
	rendered := string(section)
	if !strings.Contains(rendered, "ure") || !strings.Contains(rendered, "https://mcp.example.com") {
		t.Fatalf("MCP TOML section missing server name or URL:\n%s", rendered)
	}
	if !strings.Contains(rendered, "enabled = true") {
		t.Fatalf("MCP TOML section missing enabled=true:\n%s", rendered)
	}
	if !strings.Contains(rendered, "x-tai-identity") {
		t.Fatalf("MCP TOML section missing headers:\n%s", rendered)
	}
}

func TestGrokMCPTomlSectionEmptyServerName(t *testing.T) {
	_, err := grok.MCPTomlSection("", "https://example.com", nil)
	if err == nil {
		t.Fatal("expected error for empty server name")
	}
}

func TestGrokMCPTomlSectionEmptyURL(t *testing.T) {
	_, err := grok.MCPTomlSection("test", "", nil)
	if err == nil {
		t.Fatal("expected error for empty URL")
	}
}

func TestGrokOAuthMissingRejectsBeforeDispatchAndCopySourceIsOpaque(t *testing.T) {
	home, _ := isolateGrokRuntimeTest(t)
	_, xaiProvider, err := catalog.DefaultRegistry().ResolveBinding("grok", "xai")
	if err != nil {
		t.Fatal(err)
	}
	resolved := profilepkg.ResolvedProfile{Provider: xaiProvider}
	_, err = prepareClientRuntime(execution.ProfileDefinition{Client: "grok", Provider: "xai"}, resolved)
	if err == nil || !strings.Contains(err.Error(), "OAuth") {
		t.Fatalf("missing xAI OAuth error = %v", err)
	}
	if strings.Contains(err.Error(), "zhipu-test-secret") || strings.Contains(err.Error(), "kimi-test-secret") {
		t.Fatalf("dispatch error leaked secret text: %v", err)
	}

	defaultAuth := filepath.Join(home, ".grok", "auth.json")
	if err := os.MkdirAll(filepath.Dir(defaultAuth), 0o700); err != nil {
		t.Fatal(err)
	}
	oauthBytes := []byte("opaque-oauth-\x00-byte-copy")
	if err := os.WriteFile(defaultAuth, oauthBytes, 0o600); err != nil {
		t.Fatal(err)
	}
	prep, err := prepareClientRuntime(execution.ProfileDefinition{Client: "grok", Provider: "xai"}, resolved)
	if err != nil {
		t.Fatal(err)
	}
	if len(prep.Copies) != 1 || prep.Copies[0].SourcePath != defaultAuth || prep.Copies[0].RelativePath != "auth.json" || !prep.Copies[0].Sensitive {
		t.Fatalf("OAuth prepared copy = %+v", prep.Copies)
	}
	wantSensitiveSources := []driver.PreparedSensitiveSource{{Path: authPath()}, {Path: defaultAuth}}
	if !reflect.DeepEqual(prep.SensitiveSources, wantSensitiveSources) {
		t.Fatalf("OAuth sensitive sources = %#v", prep.SensitiveSources)
	}
	if len(prep.Env) != 0 || len(prep.SensitiveEnvKeys) != 0 {
		t.Fatalf("xAI OAuth must be file-copy only: env=%#v sensitive=%#v", prep.Env, prep.SensitiveEnvKeys)
	}
	if bytes.Contains(prep.Files[0].Data, oauthBytes) {
		t.Fatal("xAI OAuth bytes leaked into projected config")
	}
	unchanged, _ := os.ReadFile(defaultAuth)
	if !bytes.Equal(unchanged, oauthBytes) {
		t.Fatal("OAuth source changed during preparation")
	}
}

func TestPrepareGrokOAuthTracksEveryReadableSourceButCopiesOnlyWinner(t *testing.T) {
	home, _ := isolateGrokRuntimeTest(t)
	shellAuth := filepath.Join(forgeDataDir(), "grok", "shell-grok", "auth.json")
	defaultAuth := filepath.Join(home, ".grok", "auth.json")
	for path, data := range map[string][]byte{
		shellAuth:   []byte("shell-oauth-sensitive-source"),
		defaultAuth: []byte("default-oauth-sensitive-source"),
	} {
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, data, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	_, xaiProvider, err := catalog.DefaultRegistry().ResolveBinding("grok", "xai")
	if err != nil {
		t.Fatal(err)
	}
	prep, err := prepareClientRuntime(
		execution.ProfileDefinition{Client: "grok", Provider: "xai"},
		profilepkg.ResolvedProfile{Provider: xaiProvider},
	)
	if err != nil {
		t.Fatal(err)
	}
	if len(prep.Copies) != 1 || prep.Copies[0].SourcePath != shellAuth {
		t.Fatalf("OAuth winner copies = %#v", prep.Copies)
	}
	wantSources := []driver.PreparedSensitiveSource{{Path: authPath()}, {Path: shellAuth}, {Path: defaultAuth}}
	if !reflect.DeepEqual(prep.SensitiveSources, wantSources) {
		t.Fatalf("OAuth protected sources = %#v, want %#v", prep.SensitiveSources, wantSources)
	}
}

func TestGrokCompletePlansUseEffectiveProviderForOAuthMaterialization(t *testing.T) {
	requireClientExecution(t)
	fakeBinary := buildFakeGrokBinary(t)
	cases := []struct {
		name            string
		rawProvider     string
		model           string
		removeShellAuth bool
		wantAuth        []byte
		managed         bool
		secretRef       bool
	}{
		{name: "gk-grok protects Forge and OAuth stores while copying only the winner", model: "grok-4.5", wantAuth: []byte("oauth-source-sentinel-primary-\x00")},
		{name: "explicit xai keeps official fallback", rawProvider: "xai", model: "grok-4.5", removeShellAuth: true, wantAuth: []byte("oauth-source-sentinel-fallback-\x00")},
		{name: "managed provider protects every readable credential store", rawProvider: "zhipu-coding", model: "forge-zhipu-coding--glm-5-3", managed: true},
		{name: "secret_ref protects every store without copying unselected credentials", rawProvider: "zhipu-coding", model: "forge-zhipu-coding--glm-5-3", managed: true, secretRef: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			home, _ := isolateGrokRuntimeTest(t)
			t.Setenv("PATH", filepath.Dir(fakeBinary)+string(os.PathListSeparator)+os.Getenv("PATH"))
			shellAuth := filepath.Join(forgeDataDir(), "grok", "shell-grok", "auth.json")
			officialAuth := filepath.Join(home, ".grok", "auth.json")
			if err := os.MkdirAll(filepath.Dir(shellAuth), 0o700); err != nil {
				t.Fatal(err)
			}
			if err := os.MkdirAll(filepath.Dir(officialAuth), 0o700); err != nil {
				t.Fatal(err)
			}
			shellBytes := []byte("oauth-source-sentinel-primary-\x00")
			officialBytes := []byte("oauth-source-sentinel-fallback-\x00")
			if err := os.WriteFile(shellAuth, shellBytes, 0o600); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(officialAuth, officialBytes, 0o600); err != nil {
				t.Fatal(err)
			}
			if tc.removeShellAuth {
				if err := os.Remove(shellAuth); err != nil {
					t.Fatal(err)
				}
			}
			protectedSources := []string{authPath(), shellAuth, officialAuth}
			if tc.removeShellAuth {
				protectedSources = []string{authPath(), officialAuth}
			}
			sourceBytes := map[string][]byte{}
			sourceHashes := map[string][sha256.Size]byte{}
			for _, path := range protectedSources {
				data, readErr := os.ReadFile(path)
				if readErr != nil {
					t.Fatal(readErr)
				}
				sourceBytes[path] = append([]byte(nil), data...)
				sourceHashes[path] = sha256.Sum256(data)
			}

			deps := executionDependencies()
			secretRef := "env:SELECTED_GROK_KEY"
			if tc.secretRef {
				t.Setenv("SELECTED_GROK_KEY", "selected-secret-ref-sentinel-4f8b")
			}
			deps.LoadProfile = func(name string) (execution.ProfileDefinition, bool, error) {
				if name != "effective-provider-grok" {
					return execution.ProfileDefinition{}, false, nil
				}
				definition := execution.ProfileDefinition{
					Name: name, Client: "grok", Provider: tc.rawProvider,
					Launcher: map[string]interface{}{"command": "grok"},
					Env:      map[string]string{"GROK_MODEL": tc.model}, Settings: map[string]interface{}{},
				}
				if tc.secretRef {
					definition.SecretRef = &secretRef
				}
				return definition, true, nil
			}
			workDir := t.TempDir()
			request := execution.Request{
				ProfileName: "effective-provider-grok", Prompt: "verify effective provider",
				WorkDir: workDir, Permission: catalog.PermissionReadonly, Format: protocol.OutputFormatStreamJSON,
			}
			plan, family, err := execution.Prepare(request, deps)
			if err != nil {
				t.Fatal(err)
			}
			if family != "grok" || plan.Dialect != catalog.DialectGrok {
				t.Fatalf("complete plan family/dialect = %q/%q", family, plan.Dialect)
			}
			preparedAuth, authErr := os.ReadFile(filepath.Join(plan.ConfigDir, "auth.json"))
			if tc.managed {
				if !os.IsNotExist(authErr) {
					t.Fatalf("forge-managed plan materialized OAuth: bytes=%q err=%v", preparedAuth, authErr)
				}
				wantCredential := "zhipu-test-secret"
				if tc.secretRef {
					wantCredential = "selected-secret-ref-sentinel-4f8b"
				}
				if plan.Env["FORGE_GROK_ZHIPU_CODING_API_KEY"] != wantCredential {
					t.Fatal("forge-managed projection credential was not projected")
				}
			} else if authErr != nil || !bytes.Equal(preparedAuth, tc.wantAuth) {
				t.Fatalf("OAuth byte copy = %q err=%v, want exact selected source bytes", preparedAuth, authErr)
			}
			config, err := os.ReadFile(filepath.Join(plan.ConfigDir, "config.toml"))
			if err != nil {
				t.Fatal(err)
			}
			hookBytes, err := os.ReadFile(filepath.Join(plan.ConfigDir, "hooks", "forge-bash-guard.json"))
			if err != nil {
				t.Fatal(err)
			}
			observablePlan := strings.Join(plan.Command, "\n") + "\n" + string(config) + "\n" + string(hookBytes)
			for _, credential := range []string{string(shellBytes), string(officialBytes), "zhipu-test-secret", "kimi-test-secret", "selected-secret-ref-sentinel-4f8b"} {
				if strings.Contains(observablePlan, credential) {
					t.Fatal("complete Grok argv/config exposed credential bytes")
				}
			}

			observationPath := filepath.Join(t.TempDir(), "effective-provider-observation.json")
			t.Setenv("FAKE_GROK_STREAM_CASE", "success")
			t.Setenv("FAKE_GROK_OBSERVATION", observationPath)
			aliases := []string{}
			for index, source := range protectedSources {
				hardLink := filepath.Join(workDir, fmt.Sprintf("credential-hard-link-%d.json", index))
				if linkErr := os.Link(source, hardLink); linkErr == nil {
					aliases = append(aliases, hardLink)
				}
				symlink := filepath.Join(workDir, fmt.Sprintf("credential-symlink-%d.json", index))
				if linkErr := os.Symlink(source, symlink); linkErr == nil {
					aliases = append(aliases, symlink)
				}
			}
			if len(aliases) == 0 {
				t.Log("filesystem does not support disposable hard-link or symlink aliases")
			}
			t.Setenv("FAKE_GROK_SENSITIVE_ALIASES", strings.Join(aliases, string(os.PathListSeparator)))
			var stdout, stderr bytes.Buffer
			result, runErr := execution.Execute(request, deps, &stdout, &stderr)
			if runErr != nil || result.Status != "done" {
				t.Fatalf("effective-provider execution result=%+v err=%v stderr=%s", result, runErr, stderr.String())
			}
			observation := readFakeGrokObservation(t, observationPath)
			if !observation.GuardOutputSafe {
				t.Fatal("credential guard hook output was not credential-safe")
			}
			nativeReads, nativeGreps, nativeLists, bashReads, compoundReads, aliasReads := 0, 0, 0, 0, 0, 0
			for name, decision := range observation.GuardDecisions {
				if strings.HasPrefix(name, "sensitive_path_") || strings.HasPrefix(name, "sensitive_alias_") {
					if decision != "deny/2" {
						t.Errorf("credential guard %s = %q, want deny/2", name, decision)
					}
				}
				if strings.HasPrefix(name, "sensitive_path_") && strings.HasSuffix(name, "_read") && !strings.Contains(name, "_compound_") {
					nativeReads++
				}
				if strings.HasPrefix(name, "sensitive_path_") && strings.HasSuffix(name, "_grep") && !strings.Contains(name, "_compound_") {
					nativeGreps++
				}
				if strings.HasPrefix(name, "sensitive_path_") && strings.HasSuffix(name, "_list_parent") {
					nativeLists++
				}
				if strings.HasPrefix(name, "sensitive_path_") && strings.HasSuffix(name, "_bash") {
					bashReads++
				}
				if strings.HasPrefix(name, "sensitive_path_") && strings.Contains(name, "_compound_") {
					compoundReads++
				}
				if strings.HasPrefix(name, "sensitive_alias_") {
					aliasReads++
				}
			}
			expectedGuardPaths := len(protectedSources)
			if !tc.managed {
				expectedGuardPaths++ // selected OAuth is also protected at the materialized destination
			}
			if nativeReads != expectedGuardPaths || nativeGreps != expectedGuardPaths || nativeLists != expectedGuardPaths || bashReads != expectedGuardPaths || compoundReads != 4*expectedGuardPaths || aliasReads != len(aliases) {
				t.Fatalf("credential coverage read=%d grep=%d list=%d bash=%d compound=%d aliases=%d paths=%d: %+v", nativeReads, nativeGreps, nativeLists, bashReads, compoundReads, aliasReads, expectedGuardPaths, observation.GuardDecisions)
			}
			for path, before := range sourceBytes {
				current, readErr := os.ReadFile(path)
				if readErr != nil || !bytes.Equal(current, before) || sha256.Sum256(current) != sourceHashes[path] {
					t.Fatalf("credential source bytes/hash changed for %s: %v", filepath.Base(path), readErr)
				}
			}
			snapshot, snapshotErr := grok.NativeSessionSnapshotPath(forgeDataDir(), result.NativeSessionID)
			if snapshotErr != nil {
				t.Fatal(snapshotErr)
			}
			for name, data := range readSnapshotTreeBytes(t, snapshot) {
				for _, sentinel := range sourceBytes {
					if bytes.Contains([]byte(data), sentinel) {
						t.Fatalf("credential sentinel reached native snapshot %s", name)
					}
				}
			}
			observationBytes, observationErr := os.ReadFile(observationPath)
			if observationErr != nil {
				t.Fatal(observationErr)
			}
			resultBytes, _ := json.Marshal(result)
			logged := stdout.String() + stderr.String() + result.Error + string(observationBytes) + string(resultBytes)
			for _, credential := range []string{string(shellBytes), string(officialBytes), "zhipu-test-secret", "kimi-test-secret", "selected-secret-ref-sentinel-4f8b"} {
				if strings.Contains(logged, credential) {
					t.Fatal("Grok execution output logged credential bytes")
				}
			}
		})
	}
}

type fakeGrokObservation struct {
	Argv                       []string          `json:"argv"`
	Prompt                     string            `json:"prompt"`
	PromptPath                 string            `json:"prompt_path"`
	GrokHome                   string            `json:"grok_home"`
	Config                     string            `json:"config"`
	CredentialKeys             []string          `json:"credential_keys"`
	StaleCredentialSeen        bool              `json:"stale_credential_seen"`
	AuthPresent                bool              `json:"auth_present"`
	BashGuardPresent           bool              `json:"bash_guard_present"`
	SelectedCredentialMatched  bool              `json:"selected_credential_matched"`
	UnrelatedCredentialPresent bool              `json:"unrelated_credential_present"`
	GuardDecisions             map[string]string `json:"guard_decisions"`
	GuardOutputSafe            bool              `json:"guard_output_safe"`
	ResumeID                   string            `json:"resume_id"`
	RestoredUsable             bool              `json:"restored_session_usable"`
	RestoredState              string            `json:"restored_state"`
	WrittenState               string            `json:"written_state"`
}

func buildFakeGrokBinary(t *testing.T) string {
	t.Helper()
	name := "grok"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	path := filepath.Join(t.TempDir(), name)
	cmd := exec.Command("go", "build", "-o", path, "./testdata/fake_grok")
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("build fake Grok: %v\n%s", err, output)
	}
	return path
}

func runObservedFakeGrok(t *testing.T, streamCase string) (execution.Result, fakeGrokObservation) {
	t.Helper()
	observationPath := filepath.Join(t.TempDir(), "observation.json")
	t.Setenv("FAKE_GROK_OBSERVATION", observationPath)
	t.Setenv("FAKE_GROK_STREAM_CASE", streamCase)
	result, _ := executeDirectRun(directRunOptions{
		Profile: "gk-glm", Prompt: "inspect Forge 你好 🛠️", Permission: "readonly",
		WorkDir: t.TempDir(), Format: string(protocol.OutputFormatJSON),
	}, &bytes.Buffer{}, &bytes.Buffer{})
	data, err := os.ReadFile(observationPath)
	if err != nil {
		t.Fatalf("read fake Grok observation: %v", err)
	}
	var observation fakeGrokObservation
	if err := json.Unmarshal(data, &observation); err != nil {
		t.Fatalf("decode fake Grok observation: %v", err)
	}
	return result, observation
}

func TestBuiltBinaryFakeGrokExecutionMatrix(t *testing.T) {
	requireClientExecution(t)
	_, _ = isolateGrokRuntimeTest(t)
	fakeBinary := buildFakeGrokBinary(t)
	t.Setenv("PATH", filepath.Dir(fakeBinary)+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("GROK_HOME", filepath.Join(t.TempDir(), "stale-shell-home"))
	t.Setenv("XAI_API_KEY", "stale-xai")
	t.Setenv("FORGE_GROK_ZHIPU_CODING_API_KEY", "stale-zhipu")
	t.Setenv("FORGE_GROK_KIMI_CODING_API_KEY", "stale-kimi")
	t.Setenv("FAKE_GROK_SESSION_ID", "fake-session-matrix")

	t.Run("valid end cleans after rendering session prompt and env", func(t *testing.T) {
		result, observation := runObservedFakeGrok(t, "success")
		if result.Status != "done" || result.ExitCode != 0 || result.NativeSessionID != "fake-session-matrix" || result.Summary != "FAKE_GROK_FINAL" {
			t.Fatalf("valid native success result = %+v", result)
		}
		for _, sequence := range [][]string{
			{"--permission-mode", "dontAsk"},
			{"--tools", "read_file,list_dir,grep,run_terminal_cmd,web_search,web_fetch"},
			{"--model", "forge-zhipu-coding--glm-5-3"},
			{"--output-format", "streaming-json"},
			{"--prompt-file", observation.PromptPath},
		} {
			if !containsGrokOrderedArgs(observation.Argv, sequence...) {
				t.Errorf("fake Grok argv missing ordered sequence %v: %v", sequence, observation.Argv)
			}
		}
		if observation.Prompt != "inspect Forge 你好 🛠️" || filepath.Dir(observation.PromptPath) != observation.GrokHome {
			t.Fatalf("prompt rendering observation = %+v", observation)
		}
		for _, model := range []string{"forge-zhipu-coding--glm-5-3", "forge-kimi-coding--k3"} {
			if !strings.Contains(observation.Config, model) {
				t.Errorf("projected config missing model %q", model)
			}
		}
		if observation.StaleCredentialSeen || observation.AuthPresent {
			t.Fatalf("unexpected stale credential or OAuth projection: %+v", observation)
		}
		if !observation.BashGuardPresent {
			t.Fatalf("restricted fake-Grok run did not receive its per-run Bash guard: %+v", observation)
		}
		if !reflect.DeepEqual(observation.CredentialKeys, []string{"FORGE_GROK_ZHIPU_CODING_API_KEY"}) ||
			!observation.SelectedCredentialMatched || observation.UnrelatedCredentialPresent {
			t.Fatalf("projected credential keys = %v", observation.CredentialKeys)
		}
		for name, decision := range observation.GuardDecisions {
			want := "deny/2"
			if name == "safe_repository_read" || name == "ordinary_safe_compound" || name == "ordinary_edit" || runtime.GOOS != "windows" && strings.HasPrefix(name, "backslash_") {
				want = "allow/0"
			}
			if decision != want {
				t.Errorf("restricted builtin guard %s = %q, want %q", name, decision, want)
			}
		}
		if len(observation.GuardDecisions) < 23 || !observation.GuardOutputSafe {
			t.Fatalf("restricted builtin guard observation = %+v", observation)
		}
		observationBytes, err := os.ReadFile(os.Getenv("FAKE_GROK_OBSERVATION"))
		if err != nil {
			t.Fatal(err)
		}
		for _, sentinel := range []string{"zhipu-test-secret", "kimi-test-secret"} {
			if bytes.Contains(observationBytes, []byte(sentinel)) {
				t.Fatalf("fake execution observation exposed credential sentinel")
			}
		}
		if _, err := os.Stat(observation.GrokHome); !os.IsNotExist(err) {
			t.Fatalf("valid native terminal success did not remove run Home: %v", err)
		}
	})

	for _, streamCase := range []string{"empty", "malformed", "truncated", "incomplete", "duplicate", "non-final-after-terminal"} {
		t.Run(streamCase+" fails and retains run Home", func(t *testing.T) {
			result, observation := runObservedFakeGrok(t, streamCase)
			if result.Status != "failed" || result.ExitCode != 1 || result.Error != "invalid or incomplete Grok native output" {
				t.Fatalf("abnormal %s result = %+v", streamCase, result)
			}
			if _, err := os.Stat(observation.GrokHome); err != nil {
				t.Fatalf("%s stream removed run Home: %v", streamCase, err)
			}
		})
	}

	for _, diagnostic := range []struct{ streamCase, wantError string }{{"failed", "Error"}, {"cancelled", "Cancelled"}} {
		t.Run(diagnostic.streamCase+" preserves native diagnostic and run Home", func(t *testing.T) {
			result, observation := runObservedFakeGrok(t, diagnostic.streamCase)
			if result.Status != "failed" || result.ExitCode != 1 || result.Error != diagnostic.wantError {
				t.Fatalf("native diagnostic %s result = %+v", diagnostic.streamCase, result)
			}
			if _, err := os.Stat(observation.GrokHome); err != nil {
				t.Fatalf("%s diagnostic removed run Home: %v", diagnostic.streamCase, err)
			}
		})
	}

	t.Run("native nonzero preserves specific error and run Home", func(t *testing.T) {
		result, observation := runObservedFakeGrok(t, "native-nonzero")
		if result.Status != "failed" || result.ExitCode != 7 || result.Error != "fake Grok failure" {
			t.Fatalf("native nonzero result = %+v", result)
		}
		if _, err := os.Stat(observation.GrokHome); err != nil {
			t.Fatalf("native nonzero removed run Home: %v", err)
		}
	})
}

func TestBuiltFakeGrokYoloKeepsUnrestrictedBashAndSensitiveToolGuard(t *testing.T) {
	requireClientExecution(t)
	_, _ = isolateGrokRuntimeTest(t)
	fakeBinary := buildFakeGrokBinary(t)
	t.Setenv("PATH", filepath.Dir(fakeBinary)+string(os.PathListSeparator)+os.Getenv("PATH"))
	observationPath := filepath.Join(t.TempDir(), "yolo-observation.json")
	t.Setenv("FAKE_GROK_OBSERVATION", observationPath)
	t.Setenv("FAKE_GROK_STREAM_CASE", "success")
	var stdout, stderr bytes.Buffer
	result, err := executeDirectRun(directRunOptions{
		Profile: "gk-glm", Prompt: "document yolo trust boundary", Permission: "yolo",
		WorkDir: t.TempDir(), Format: string(protocol.OutputFormatJSON),
	}, &stdout, &stderr)
	if err != nil || result.Status != "done" {
		t.Fatalf("yolo fake Grok result=%+v err=%v stderr=%s", result, err, stderr.String())
	}
	observation := readFakeGrokObservation(t, observationPath)
	if !observation.SelectedCredentialMatched || observation.UnrelatedCredentialPresent ||
		!reflect.DeepEqual(observation.CredentialKeys, []string{"FORGE_GROK_ZHIPU_CODING_API_KEY"}) {
		t.Fatalf("yolo credential boundary = %+v", observation)
	}
	if !observation.BashGuardPresent || len(observation.GuardDecisions) < 23 || !observation.GuardOutputSafe {
		t.Fatalf("yolo did not retain its sensitive tool guard: %+v", observation)
	}
	for name, decision := range observation.GuardDecisions {
		want := "deny/2"
		if name == "safe_repository_read" || name == "ordinary_safe_compound" || name == "ordinary_edit" || name == "background_unrelated" || strings.HasPrefix(name, "backslash_") || strings.HasPrefix(name, "bash_tree_") || strings.HasPrefix(name, "bash_file_") || strings.HasPrefix(name, "bash_git_") || strings.HasPrefix(name, "bash_rg_") {
			want = "allow/0"
		}
		if decision != want {
			t.Errorf("yolo guard %s = %q, want %q", name, decision, want)
		}
	}
	visible := append(append([]byte{}, stdout.Bytes()...), stderr.Bytes()...)
	visible = append(visible, []byte(result.Error)...)
	observationBytes, readErr := os.ReadFile(observationPath)
	if readErr != nil {
		t.Fatal(readErr)
	}
	visible = append(visible, observationBytes...)
	for _, sentinel := range []string{"zhipu-test-secret", "kimi-test-secret"} {
		if bytes.Contains(visible, []byte(sentinel)) {
			t.Fatal("yolo execution output exposed credential sentinel")
		}
	}
}

func TestBuiltFakeGrokFirstRunAndExplicitNativeResumeUseUniqueHomes(t *testing.T) {
	requireClientExecution(t)
	_, _ = isolateGrokRuntimeTest(t)
	fakeBinary := buildFakeGrokBinary(t)
	t.Setenv("PATH", filepath.Dir(fakeBinary)+string(os.PathListSeparator)+os.Getenv("PATH"))
	nativeID := "fake-native-resume-matrix"
	t.Setenv("FAKE_GROK_SESSION_ID", nativeID)
	workDir := t.TempDir()
	request := execution.Request{
		ProfileName: "gk-glm", Prompt: "first native turn", WorkDir: workDir,
		Permission: catalog.PermissionReadonly, Format: protocol.OutputFormatJSON,
	}

	firstObservationPath := filepath.Join(t.TempDir(), "first.json")
	t.Setenv("FAKE_GROK_OBSERVATION", firstObservationPath)
	t.Setenv("FAKE_GROK_STATE", "first-persisted-state")
	first, err := execution.Execute(request, executionDependencies(), &bytes.Buffer{}, &bytes.Buffer{})
	if err != nil || first.Status != "done" || first.NativeSessionID != nativeID {
		t.Fatalf("first fake-Grok run result=%+v err=%v", first, err)
	}
	firstObservation := readFakeGrokObservation(t, firstObservationPath)
	if firstObservation.ResumeID != "" || firstObservation.RestoredUsable {
		t.Fatalf("first run unexpectedly resumed native state: %+v", firstObservation)
	}
	if _, statErr := os.Stat(firstObservation.GrokHome); !os.IsNotExist(statErr) {
		t.Fatalf("first successful run Home was not removed: %v", statErr)
	}
	snapshot, err := grok.NativeSessionSnapshotPath(forgeDataDir(), nativeID)
	if err != nil {
		t.Fatal(err)
	}
	if info, statErr := os.Stat(snapshot); statErr != nil || !info.IsDir() {
		t.Fatalf("first run did not persist a native Grok snapshot: info=%v err=%v", info, statErr)
	}
	trustedSnapshot := readSnapshotTreeBytes(t, snapshot)
	for _, streamCase := range []string{"empty", "malformed", "truncated", "incomplete", "duplicate", "non-final-after-terminal", "cancelled", "native-nonzero"} {
		t.Run("resumed "+streamCase+" preserves trusted snapshot", func(t *testing.T) {
			observationPath := filepath.Join(t.TempDir(), streamCase+".json")
			t.Setenv("FAKE_GROK_OBSERVATION", observationPath)
			t.Setenv("FAKE_GROK_STATE", "untrusted-"+streamCase)
			t.Setenv("FAKE_GROK_STREAM_CASE", streamCase)
			abnormalRequest := request
			abnormalRequest.ResumeID = nativeID
			abnormalRequest.Prompt = "abnormal resumed native turn"
			result, runErr := execution.Execute(abnormalRequest, executionDependencies(), &bytes.Buffer{}, &bytes.Buffer{})
			if runErr == nil || result.Status != "failed" {
				t.Fatalf("abnormal resumed %s result=%+v err=%v", streamCase, result, runErr)
			}
			observation := readFakeGrokObservation(t, observationPath)
			if !observation.RestoredUsable || observation.RestoredState != "first-persisted-state" {
				t.Fatalf("abnormal resumed %s did not start from trusted state: %+v", streamCase, observation)
			}
			if _, statErr := os.Stat(observation.GrokHome); statErr != nil {
				t.Fatalf("abnormal resumed %s removed run Home: %v", streamCase, statErr)
			}
			if got := readSnapshotTreeBytes(t, snapshot); !reflect.DeepEqual(got, trustedSnapshot) {
				t.Fatalf("abnormal resumed %s replaced durable snapshot", streamCase)
			}
		})
	}

	secondObservationPath := filepath.Join(t.TempDir(), "second.json")
	t.Setenv("FAKE_GROK_OBSERVATION", secondObservationPath)
	t.Setenv("FAKE_GROK_STATE", "second-refreshed-state")
	request.Prompt = "second native turn"
	request.ResumeID = nativeID
	second, err := execution.Execute(request, executionDependencies(), &bytes.Buffer{}, &bytes.Buffer{})
	if err != nil || second.Status != "done" || second.NativeSessionID != nativeID {
		t.Fatalf("resumed fake-Grok run result=%+v err=%v", second, err)
	}
	secondObservation := readFakeGrokObservation(t, secondObservationPath)
	if secondObservation.GrokHome == firstObservation.GrokHome {
		t.Fatalf("explicit resume reused first run Home: %s", secondObservation.GrokHome)
	}
	if secondObservation.ResumeID != nativeID || !secondObservation.RestoredUsable || secondObservation.RestoredState != "first-persisted-state" {
		t.Fatalf("second run could not use restored native state: %+v", secondObservation)
	}
	if !containsGrokOrderedArgs(secondObservation.Argv, "--resume", nativeID) {
		t.Fatalf("second run did not forward native resume id: %v", secondObservation.Argv)
	}
	if _, statErr := os.Stat(secondObservation.GrokHome); !os.IsNotExist(statErr) {
		t.Fatalf("second successful run Home was not removed: %v", statErr)
	}

	restoredHome := t.TempDir()
	if err := grok.RestoreNativeSessionSnapshot(forgeDataDir(), restoredHome, nativeID); err != nil {
		t.Fatal(err)
	}
	if state := readRestoredFakeGrokState(t, restoredHome, nativeID); state != "second-refreshed-state" {
		t.Fatalf("second run did not refresh durable native state: %q", state)
	}
}

func readFakeGrokObservation(t *testing.T, path string) fakeGrokObservation {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var observation fakeGrokObservation
	if err := json.Unmarshal(data, &observation); err != nil {
		t.Fatal(err)
	}
	return observation
}

func readRestoredFakeGrokState(t *testing.T, home, nativeID string) string {
	t.Helper()
	var updatesPath string
	err := filepath.WalkDir(filepath.Join(home, "sessions"), func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() && entry.Name() == nativeID {
			updatesPath = filepath.Join(path, "updates.jsonl")
			return filepath.SkipDir
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(updatesPath)
	if err != nil {
		t.Fatal(err)
	}
	state := ""
	for _, line := range strings.Split(strings.TrimSpace(string(data)), "\n") {
		var update map[string]string
		if err := json.Unmarshal([]byte(line), &update); err != nil {
			t.Fatal(err)
		}
		if update["state"] != "" {
			state = update["state"]
		}
	}
	return state
}

func readSnapshotTreeBytes(t *testing.T, root string) map[string]string {
	t.Helper()
	files := map[string]string{}
	if err := filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			return nil
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		relative, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		files[relative] = string(data)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	return files
}

func containsGrokOrderedArgs(args []string, wants ...string) bool {
	index := 0
	for _, arg := range args {
		if index < len(wants) && arg == wants[index] {
			index++
		}
	}
	return index == len(wants)
}
