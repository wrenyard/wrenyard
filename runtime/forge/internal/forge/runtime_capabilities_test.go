package forge

import (
	"encoding/json"
	"os"
	"reflect"
	"strings"
	"testing"
)

func writeCapabilitiesManifest(t *testing.T, home, content string) {
	t.Helper()
	t.Setenv("HOME", home)
	configDir := userConfigDir()
	if err := os.MkdirAll(configDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(userCapabilitiesPath(), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestParseDirectRunAcceptsRepeatedCapabilityFlags(t *testing.T) {
	opts, err := parseDirectRunArgs([]string{
		"-p", "codex",
		"--cap", "browser-use",
		"--capability", "browser",
		"--cap=browser-use",
		"inspect",
	})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"browser-use", "browser", "browser-use"}
	if !reflect.DeepEqual(opts.Capabilities, want) {
		t.Fatalf("unexpected parsed capabilities: got %v want %v", opts.Capabilities, want)
	}
	if opts.Prompt != "inspect" {
		t.Fatalf("unexpected prompt: %q", opts.Prompt)
	}
}

func TestNormalizeCapabilityNamesDeduplicatesInArgumentOrder(t *testing.T) {
	got, err := normalizeCapabilityNames([]string{" Browser-Use ", "browser-use", "CUSTOM", "custom"})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"browser-use", "custom"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("unexpected normalized capabilities: got %v want %v", got, want)
	}
}

func TestCapabilityRegistryIgnoresGeneratedFromMetadata(t *testing.T) {
	home := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", "")
	t.Setenv("USERPROFILE", home)
	writeCapabilitiesManifest(t, home, `{"_generated_from":"forge test","Browser-Use":{"description":"Browser-Use","mcp_servers":{"browser-use":{"command":"npx"}}}}`)

	manifest, err := loadCapabilityManifest()
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := manifest["_generated_from"]; ok {
		t.Fatal("_generated_from metadata should not appear as a capability")
	}
	if _, ok := manifest["browser-use"]; !ok {
		t.Fatalf("browser-use capability missing: %#v", manifest)
	}
}

func TestCapabilityRegistryMergesUserOverlay(t *testing.T) {
	home := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", "")
	t.Setenv("USERPROFILE", home)
	writeCapabilitiesManifest(t, home, `{"_generated_from":"forge test","zeta":{"description":"Zeta","mcp_servers":{"zeta":{"command":"zeta"}}}}`)

	manifest, err := loadCapabilityManifest()
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := manifest["browser-use"]; !ok {
		t.Fatalf("embedded browser-use capability should remain when user overlay adds zeta: %#v", manifest)
	}
	if _, ok := manifest["zeta"]; !ok {
		t.Fatalf("user overlay zeta capability missing: %#v", manifest)
	}
	if _, ok := manifest["_generated_from"]; ok {
		t.Fatal("_generated_from metadata should not appear as a capability")
	}

	if err := os.WriteFile(userCapabilitiesPath(), []byte(`{"browser-use":{"description":"Custom Browser Use","mcp_servers":{"browser":{"command":"custom-browser","args":["--headless"]}}}}`), 0o644); err != nil {
		t.Fatal(err)
	}
	manifest, err = loadCapabilityManifest()
	if err != nil {
		t.Fatal(err)
	}
	pack := manifest["browser-use"]
	if _, ok := pack.MCPServers["browser"]; !ok {
		t.Fatalf("user overlay should replace embedded browser-use pack: %#v", pack)
	}
	if _, ok := pack.MCPServers["browser-use"]; ok {
		t.Fatalf("user overlay should replace, not deep-merge, embedded browser-use pack: %#v", pack)
	}
}

func TestResolveCapabilityPacksRejectsUnknownWithAvailableNames(t *testing.T) {
	home := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", "")
	t.Setenv("USERPROFILE", home)
	writeCapabilitiesManifest(t, home, `{"browser-use":{"description":"Browser Use","mcp_servers":{"browser-use":{"command":"npx"}}},"zeta":{"description":"Zeta","mcp_servers":{"zeta":{"command":"zeta"}}}}`)

	_, err := resolveCapabilityPacks([]string{"missing"})
	if err == nil {
		t.Fatal("expected unknown capability pack to fail")
	}
	for _, want := range []string{`unknown capability pack "missing"`, "available packs: browser-use, computer-use, git-history, notesmd, zeta"} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("expected error to contain %q, got %v", want, err)
		}
	}
}

func TestResolveCapabilityPacksRejectsEmptyPack(t *testing.T) {
	home := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", "")
	t.Setenv("USERPROFILE", home)
	writeCapabilitiesManifest(t, home, `{"empty":{"description":"Empty","mcp_servers":{}}}`)

	_, err := resolveCapabilityPacks([]string{"empty"})
	if err == nil {
		t.Fatal("expected empty capability pack to fail")
	}
	if !strings.Contains(err.Error(), `capability pack "empty" does not define any tool, Bash, or MCP contributions`) {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestNotesmdCapabilityContributesOnlyBashScope(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("XDG_CONFIG_HOME", "")

	result, err := resolveCapabilityPacks([]string{"notesmd"})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Tools.Cap) != 0 || len(result.Tools.MCP) != 0 {
		t.Fatalf("notesmd must not contribute tool or MCP entries: %+v", result.Tools)
	}
	if len(result.BashGate.Cap) != 1 || result.BashGate.Cap[0].Pattern != "notesmd-cli *" {
		t.Fatalf("notesmd Bash capability = %+v, want only notesmd-cli *", result.BashGate.Cap)
	}
}

func TestCapabilityManifestBashGrammarRejectsInvalidAndPreservesSafeControls(t *testing.T) {
	for _, pattern := range []string{
		"*", "foo*", "foo * bar", "foo * *", "foo **",
		"foo | bar", "foo > out", "foo $(bar)", "foo \"bar\"", "foo\nbar",
	} {
		t.Run(pattern, func(t *testing.T) {
			home := t.TempDir()
			t.Setenv("XDG_CONFIG_HOME", "")
			t.Setenv("USERPROFILE", home)
			manifest := map[string]any{
				"invalid": map[string]any{"bash": map[string]any{"cap": []string{pattern}}},
			}
			data, err := json.Marshal(manifest)
			if err != nil {
				t.Fatal(err)
			}
			writeCapabilitiesManifest(t, home, string(data))
			if _, err := resolveCapabilityPacks([]string{"invalid"}); err == nil || !strings.Contains(err.Error(), "unsafe capability Bash rule") {
				t.Fatalf("manifest rule %q error = %v", pattern, err)
			}
		})
	}

	for _, pattern := range []string{"notesmd-cli *", "notesmd-cli list"} {
		t.Run("safe/"+pattern, func(t *testing.T) {
			home := t.TempDir()
			t.Setenv("XDG_CONFIG_HOME", "")
			t.Setenv("USERPROFILE", home)
			manifest := map[string]any{
				"safe": map[string]any{"bash": map[string]any{"cap": []string{pattern}}},
			}
			data, err := json.Marshal(manifest)
			if err != nil {
				t.Fatal(err)
			}
			writeCapabilitiesManifest(t, home, string(data))
			result, err := resolveCapabilityPacks([]string{"safe"})
			if err != nil {
				t.Fatal(err)
			}
			if len(result.BashGate.Cap) != 1 || result.BashGate.Cap[0].Pattern != pattern {
				t.Fatalf("safe manifest rule = %+v, want %q", result.BashGate.Cap, pattern)
			}
		})
	}
}

func TestResolveCapabilityPacksRejectsLegacyPlaywrightId(t *testing.T) {
	home := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", "")
	t.Setenv("USERPROFILE", home)
	t.Setenv("HOME", home)

	// playwright is no longer in the embedded registry; must be unknown.
	_, err := resolveCapabilityPacks([]string{"playwright"})
	if err == nil {
		t.Fatal("expected legacy playwright capability pack to be unknown")
	}
	for _, want := range []string{`unknown capability pack "playwright"`, "available packs: browser-use, computer-use, git-history, notesmd"} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("expected error to contain %q, got %v", want, err)
		}
	}
}

func TestGitHistoryCapabilityContributesOnlyNarrowBashScope(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("XDG_CONFIG_HOME", "")

	result, err := resolveCapabilityPacks([]string{"git-history"})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Tools.Cap) != 0 || len(result.Tools.MCP) != 0 {
		t.Fatalf("git-history must not contribute tool or MCP entries: %+v", result.Tools)
	}
	want := []string{
		"git --no-optional-locks log --oneline *",
		"git --no-optional-locks show --name-only *",
		"git --no-optional-locks show --stat *",
	}
	got := make([]string, len(result.BashGate.Cap))
	for i, rule := range result.BashGate.Cap {
		got[i] = rule.Pattern
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("git-history Bash capability = %v, want exactly %v", got, want)
	}
}

func TestDirectCapabilityCodexInjectsConfigArgsFromEmbeddedRegistry(t *testing.T) {
	home := t.TempDir()
	t.Setenv("FORGE_REPO_DIR", t.TempDir())
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("XDG_CONFIG_HOME", "")
	t.Setenv("XDG_DATA_HOME", t.TempDir())

	plan, err := buildDirectRunPlanWithCapabilities(directPlanInput{Profile: "codex-sol", Prompt: "inspect", CWD: t.TempDir()}, []string{"Browser-Use", "browser-use"})
	if err != nil {
		t.Fatal(err)
	}

	// Assert source-owned model from the builtin codex-sol profile.
	if !containsOrdered(plan.Command, "--model", "gpt-5.6-sol") {
		t.Fatalf("codex-sol should use model gpt-5.6-sol, got command: %v", plan.Command)
	}

	for _, want := range []string{
		`mcp_servers.browser-use.command="npx"`,
		`mcp_servers.browser-use.args=["-y","@playwright/mcp@latest"]`,
		`mcp_servers.browser-use.startup_timeout_sec=120`,
	} {
		if !contains(plan.Command, want) {
			t.Fatalf("codex capability injection missing %q: %v", want, plan.Command)
		}
	}
	if countArg(plan.Command, `mcp_servers.browser-use.command="npx"`) != 1 {
		t.Fatalf("duplicate capability should be removed, command: %v", plan.Command)
	}

	// Assert computer-use pack also resolves from the embedded registry.
	planCU, err := buildDirectRunPlanWithCapabilities(directPlanInput{Profile: "codex-sol", Prompt: "compute", CWD: t.TempDir()}, []string{"computer-use"})
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		`mcp_servers.computer-use.command="cua-driver"`,
		`mcp_servers.computer-use.args=["mcp"]`,
		`mcp_servers.computer-use.startup_timeout_sec=120`,
	} {
		if !contains(planCU.Command, want) {
			t.Fatalf("codex computer-use injection missing %q: %v", want, planCU.Command)
		}
	}
	if plan.Command[len(plan.Command)-1] != "-" {
		t.Fatalf("codex stdin prompt marker must remain last, got %v", plan.Command)
	}
	if exists(userCapabilitiesPath()) {
		t.Fatalf("embedded capability lookup must not materialize %s", userCapabilitiesPath())
	}
}

func countArg(args []string, target string) int {
	count := 0
	for _, arg := range args {
		if arg == target {
			count++
		}
	}
	return count
}
