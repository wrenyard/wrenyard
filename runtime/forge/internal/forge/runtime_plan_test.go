package forge

import (
	"reflect"
	"strings"
	"testing"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/dsh"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/catalog"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/execution"
	profilepkg "github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/profile"
)

// TestDirectPlanDirsCreatedBeforeLaterStage verifies that when the credential
// stage passes, the CC config/job directories are created (a side effect that
// precedes command/model resolution) and no compatibility text leaks into the
// final plan error.
func TestDirectPlanDirsCreatedBeforeLaterStage(t *testing.T) {
	repo := t.TempDir()
	home := t.TempDir()
	t.Setenv("FORGE_REPO_DIR", repo)
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", "")
	t.Setenv("USERPROFILE", home)

	// Managed provider (kimi-coding) with auth injected: credential stage passes.
	setTestAuth(t, "kimi-coding", "token-kimi")

	_, err := buildDirectRunPlan(directPlanInput{Profile: "cc-kimi", Prompt: "work", CWD: t.TempDir()})

	// Directories must be created during the env stage, regardless of any later
	// command/model resolution error.
	if !dirExists(directCCConfigDir()) {
		t.Fatalf("CC config dir must be created before command/model stage")
	}
	if !dirExists(directCCJobDir()) {
		t.Fatalf("CC job dir must be created before command/model stage")
	}
	// Compatibility must remain internal: no compatibility text may surface.
	if err != nil && strings.Contains(err.Error(), "compatibility") {
		t.Fatalf("compatibility mode must not leak into final error: %v", err)
	}
	if err != nil && strings.Contains(err.Error(), "no credential for provider") {
		t.Fatalf("credential must not fail for managed provider with auth: %v", err)
	}
}

// dshTestEnv isolates forge data dir lookups for DSH wiring tests.
func dshTestEnv(t *testing.T) {
	t.Helper()
	t.Setenv("FORGE_REPO_DIR", t.TempDir())
	t.Setenv("HOME", t.TempDir())
	t.Setenv("XDG_CONFIG_HOME", "")
	t.Setenv("USERPROFILE", t.TempDir())
}

// TestPrepareDSHRuntimeProjection verifies the DSH wiring prepares an isolated
// per-run DSH_HOME, projects the selected profile model and the provider
// routes, injects the selected typed credential (token plus X-* context
// headers) only into the child env with every value marked sensitive, and
// never writes a literal secret into a generated asset.
func TestPrepareDSHRuntimeProjection(t *testing.T) {
	dshTestEnv(t)
	old := dshCredentialResolver
	dshCredentialResolver = func(providerID string) (dsh.TypedCredential, bool) {
		if providerID == "zhipu-coding" {
			return dsh.TypedCredential{
				Token: "test-provider-token",
				Headers: map[string]string{
					"Authorization": "Bearer test-provider-token",
					"X-Domain":      "acme",
					"X-User-Id":     "u-1",
				},
			}, true
		}
		return dsh.TypedCredential{}, false
	}
	t.Cleanup(func() { dshCredentialResolver = old })

	prep, err := prepareDSHRuntime(
		execution.ProfileDefinition{
			Name:   "dsh-zhipu",
			Client: "dsh",
			Env:    map[string]string{catalog.EnvDSHModel: "llm-pi-ai.zhipu-coding/glm-5.3"},
		},
		profilepkg.ResolvedProfile{
			Name:       "dsh-zhipu",
			Provider:   catalog.Provider{Name: "llm-pi-ai.zhipu-coding"},
			Credential: profilepkg.CredentialPlan{TargetEnv: "FORGE_DSH_ZHIPU_CODING_API_KEY", Value: "test-provider-token"},
		},
	)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if prep.HomeEnvVar != "DSH_HOME" {
		t.Fatalf("home env var=%q want DSH_HOME", prep.HomeEnvVar)
	}
	if !strings.HasSuffix(prep.HomeParent, "dsh") {
		t.Fatalf("home parent=%q must live under a dsh subdir", prep.HomeParent)
	}
	if prep.Env["FORGE_DSH_ZHIPU_CODING_API_KEY"] != "test-provider-token" {
		t.Fatalf("selected profile token must win: %q", prep.Env["FORGE_DSH_ZHIPU_CODING_API_KEY"])
	}
	if prep.Env["FORGE_DSH_ZHIPU_CODING_X_DOMAIN_SECRET"] != "acme" {
		t.Fatalf("typed header value must be injected: %q", prep.Env["FORGE_DSH_ZHIPU_CODING_X_DOMAIN_SECRET"])
	}
	if prep.Env["FORGE_DSH_ZHIPU_CODING_X_USER_ID_SECRET"] != "u-1" {
		t.Fatalf("typed header value must be injected: %q", prep.Env["FORGE_DSH_ZHIPU_CODING_X_USER_ID_SECRET"])
	}
	if _, ok := prep.Env["FORGE_DSH_ZHIPU_CODING_AUTHORIZATION_SECRET"]; ok {
		t.Fatal("Authorization must be handled only by apiKeyEnv")
	}
	wantKeys := []string{"FORGE_DSH_ZHIPU_CODING_API_KEY", "FORGE_DSH_ZHIPU_CODING_X_DOMAIN_SECRET", "FORGE_DSH_ZHIPU_CODING_X_USER_ID_SECRET"}
	if !reflect.DeepEqual(prep.SensitiveEnvKeys, wantKeys) {
		t.Fatalf("SensitiveEnvKeys = %v, want %v", prep.SensitiveEnvKeys, wantKeys)
	}

	var patchData []byte
	pluginPrepared := false
	for _, f := range prep.Files {
		if f.RelativePath == "patch.yaml" {
			patchData = f.Data
		}
		if strings.Contains(f.RelativePath, ".mjs") || strings.Contains(f.RelativePath, ".js") {
			pluginPrepared = true
		}
	}
	if len(patchData) == 0 {
		t.Fatal("no provider/runtime patch asset prepared")
	}
	patch := string(patchData)
	if !strings.Contains(patch, "- id: agent-default-model\n  config:\n    provider: llm-pi-ai.zhipu-coding\n    model: glm-5.3") {
		t.Fatalf("selected model must be projected into the loader overlay:\n%s", patch)
	}
	if !strings.Contains(patch, "- id: llm-pi-ai") || !strings.Contains(patch, "      zhipu-coding:") {
		t.Fatalf("provider routes must stay visible in the loader overlay:\n%s", patch)
	}
	if !strings.Contains(patch, "X-Domain: !!js process.env.FORGE_DSH_ZHIPU_CODING_X_DOMAIN_SECRET") {
		t.Fatalf("typed header must render as an unquoted env ref:\n%s", patch)
	}
	if strings.Contains(patch, "Authorization:") {
		t.Fatalf("Authorization must not appear as a header row:\n%s", patch)
	}
	if strings.Contains(patch, "forge-dsh-bridge") {
		t.Fatalf("prepared patch must stay bridge-free; the driver inserts the bridge at materialization:\n%s", patch)
	}
	if !pluginPrepared {
		t.Fatal("bridge plugin asset must be prepared")
	}
	for _, leak := range []string{"test-provider-token", "acme", "u-1", "Bearer "} {
		if strings.Contains(patch, leak) {
			t.Fatalf("generated assets must never contain a literal secret (%q):\n%s", leak, patch)
		}
	}
}

// TestPrepareDSHRuntimeMissingCredentialKeepsRoutesVisible verifies routes stay
// visible without credentials: a profile with no credential value injects no
// child env while the provider rows and their env-name references remain in the
// generated patch.
func TestPrepareDSHRuntimeMissingCredentialKeepsRoutesVisible(t *testing.T) {
	dshTestEnv(t)
	prep, err := prepareDSHRuntime(
		execution.ProfileDefinition{
			Name:   "dsh-zhipu",
			Client: "dsh",
			Env:    map[string]string{catalog.EnvDSHModel: "llm-pi-ai.zhipu-coding/glm-5.3"},
		},
		profilepkg.ResolvedProfile{
			Name:       "dsh-zhipu",
			Provider:   catalog.Provider{Name: "llm-pi-ai.zhipu-coding"},
			Credential: profilepkg.CredentialPlan{},
		},
	)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if _, ok := prep.Env["FORGE_DSH_ZHIPU_CODING_API_KEY"]; ok {
		t.Fatal("missing credential must not inject a child env value")
	}
	var patchData []byte
	for _, f := range prep.Files {
		if f.RelativePath == "patch.yaml" {
			patchData = f.Data
		}
	}
	patch := string(patchData)
	if !strings.Contains(patch, "- id: llm-pi-ai") {
		t.Fatalf("provider row must stay visible without credentials:\n%s", patch)
	}
	if !strings.Contains(patch, "      zhipu-coding:") {
		t.Fatalf("zhipu-coding route must stay visible without credentials:\n%s", patch)
	}
	if !strings.Contains(patch, "apiKeyEnv: FORGE_DSH_ZHIPU_CODING_API_KEY") {
		t.Fatalf("route must reference the scrubbed env name:\n%s", patch)
	}
}

func TestParseAgentPermissionModeAliasNormalization(t *testing.T) {
	tests := []struct {
		raw       string
		want      catalog.PermissionMode
		wantError bool
	}{
		{"full", catalog.PermissionYolo, false},     // deprecated alias → yolo
		{"standard", catalog.PermissionYolo, false}, // deprecated alias → yolo
		{"exec", catalog.PermissionYolo, false},     // deprecated alias → yolo
		{"edit", catalog.PermissionEdit, false},
		{"readonly", catalog.PermissionReadonly, false},
		{"yolo", catalog.PermissionYolo, false},
		{"", catalog.PermissionEdit, false},
		{"invalid", catalog.PermissionEdit, true},
	}

	for _, tt := range tests {
		t.Run("parseAgentPerm_"+tt.raw, func(t *testing.T) {
			got, err := parseDirectPermissionMode(tt.raw)
			if got != tt.want {
				t.Errorf("parseDirectPermissionMode(%q) = %q, want %q", tt.raw, got, tt.want)
			}
			if (err != nil) != tt.wantError {
				t.Errorf("parseDirectPermissionMode(%q) error = %v, wantError = %v", tt.raw, err, tt.wantError)
			}
		})
	}
}
