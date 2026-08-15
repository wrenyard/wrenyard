package forge

import (
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/catalog"
)

func TestRemovedMCPStateFieldsDoNotRemain(t *testing.T) {
	for _, tc := range []struct {
		name   string
		typ    reflect.Type
		fields []string
	}{
		{
			name:   "direct plan input",
			typ:    reflect.TypeOf(directPlanInput{}),
			fields: []string{"MCPConfig", "Capabilities", "PersistedCapabilities", "PersistedCapabilityMCP"},
		},
		{
			name:   "client descriptor",
			typ:    reflect.TypeOf(catalog.Client{}),
			fields: []string{"HeadlessMCPPreapproval"},
		},
	} {
		for _, field := range tc.fields {
			if _, ok := tc.typ.FieldByName(field); ok {
				t.Fatalf("%s still carries removed MCP/capability state field %s", tc.name, field)
			}
		}
	}
}

func TestMCPIsUnknownCommandAndNoArtifactsRemain(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", "")

	for _, sub := range []string{"mcp"} {
		t.Run(sub, func(t *testing.T) {
			code := Run([]string{sub}, "forge")
			if code != 2 {
				t.Fatalf("forge %s should be an unknown command, got exit code %d", sub, code)
			}
		})
	}
	capPath := filepath.Join(home, ".config", "forge", "capabilities.json")
	if exists(capPath) {
		t.Fatalf("mcp as unknown should not materialize removed capability registry at %s", capPath)
	}
}

func TestAmbiguousMCPPrefixProducesExpectedError(t *testing.T) {
	for _, args := range [][]string{
		{"mcp"},
		{"mc"},
	} {
		args := args
		t.Run(strings.Join(args, " "), func(t *testing.T) {
			code := Run(args, "forge")
			if code != 2 {
				t.Fatalf("expected unknown command exit 2 for %q, got %d", args, code)
			}
		})
	}
}

func TestDoctorDoesNotReportCapabilityRegistry(t *testing.T) {
	repo := t.TempDir()
	home := t.TempDir()
	t.Setenv("FORGE_REPO_DIR", repo)
	isolateCodebuddyTestEnvironment(t, home)

	report := buildDoctorReport("")
	for _, adapter := range report["adapters"].([]string) {
		if adapter == "capabilities" {
			t.Fatal("doctor adapters should not include removed capability registry")
		}
	}
	for _, item := range report["checks"].([]map[string]interface{}) {
		if item["adapter"] == "capabilities" {
			t.Fatal("doctor checks should not include removed capability registry")
		}
	}
}
