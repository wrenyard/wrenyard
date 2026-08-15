package manifest

import (
	"testing"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/profiles/config"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/catalog"
)

// TestCustomDSHProfileCompilesDSHModelEnv verifies that a custom
// client:dsh recipe compiles to DSH_MODEL=<provider>/<model> and launches
// the fdsh executable.
func TestCustomDSHProfileCompilesDSHModelEnv(t *testing.T) {
	deps := LoadDeps{
		Recipes: map[string]config.ProfileRecipe{
			"my-dsh": {Client: "dsh", Provider: "zhipu-coding", Model: "glm-5.3", Description: "dsh coding"},
		},
		Registry: catalog.DefaultRegistry(),
	}
	m, err := LoadManifest(deps)
	if err != nil {
		t.Fatal(err)
	}
	profile, ok := m.Profiles["my-dsh"]
	if !ok {
		t.Fatalf("custom profile my-dsh missing from %v", m.OrderedIDs)
	}
	if got := profile.Env[catalog.EnvDSHModel]; got != "zhipu-coding/glm-5.3" {
		t.Fatalf("DSH_MODEL = %q, want zhipu-coding/glm-5.3", got)
	}
	if command := profile.Launcher["command"]; command != "fdsh" {
		t.Fatalf("launcher command = %v, want fdsh", command)
	}
}

// TestNoBuiltinDSHProfile verifies no built-in DSH profile was added in this
// release; the profile foundation is in place for a later release.
func TestNoBuiltinDSHProfile(t *testing.T) {
	for _, id := range List() {
		if id == "dsh" {
			t.Fatalf("built-in dsh profile must not be added in this release: %v", List())
		}
	}
	if _, ok := BuiltinManifest().Profiles["dsh"]; ok {
		t.Fatal("built-in dsh profile must not exist")
	}
}
