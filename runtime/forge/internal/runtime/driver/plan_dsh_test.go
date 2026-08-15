package driver

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/dsh"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/catalog"
)

func dshPlanRequest(t *testing.T) PlanRequest {
	t.Helper()
	assets := dsh.DefaultRuntimePatchAssets()
	return PlanRequest{
		Spec: ProfileSpec{
			Name:   "dsh-zhipu",
			Client: "dsh",
			Env:    map[string]string{catalog.EnvDSHModel: "llm-pi-ai.zhipu-coding/glm-5.3"},
			Runtime: RuntimePreparation{
				HomeParent: t.TempDir(),
				HomeEnvVar: "DSH_HOME",
				Env:        map[string]string{"FORGE_DSH_ZHIPU_CODING_API_KEY": "secret-zhipu-token"},
				Files: []PreparedFile{
					{RelativePath: assets.Plugin.Filename, Data: []byte(assets.Plugin.Source), Mode: 0o600},
				},
			},
		},
		Prompt:     "do it",
		WorkDir:    t.TempDir(),
		Permission: catalog.PermissionEdit,
	}
}

func dshRequestWithDialect(t *testing.T) PlanRequest {
	t.Helper()
	req := dshPlanRequest(t)
	req.Spec.ClientDesc = catalog.Client{Dialect: catalog.DialectDSH}
	return req
}

func TestBuildPlanDSHHiddenAgentArgv(t *testing.T) {
	plan, err := BuildPlan(dshRequestWithDialect(t))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if plan.Dialect != catalog.DialectDSH {
		t.Fatalf("dialect=%q want dsh", plan.Dialect)
	}
	want := []string{"fdsh", "--forge-agent", "--", "do it"}
	if len(plan.Command) != len(want) {
		t.Fatalf("command=%v want %v", plan.Command, want)
	}
	for i := range want {
		if plan.Command[i] != want[i] {
			t.Fatalf("command=%v want %v", plan.Command, want)
		}
	}
}

func TestBuildPlanDSHIsolatedHomeAndAssets(t *testing.T) {
	req := dshRequestWithDialect(t)
	plan, err := BuildPlan(req)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	home := plan.Env["DSH_HOME"]
	if !strings.HasPrefix(home, req.Spec.Runtime.HomeParent) {
		t.Fatalf("DSH_HOME=%q must live under prepared parent %q", home, req.Spec.Runtime.HomeParent)
	}
	if plan.ConfigDir != home {
		t.Fatalf("ConfigDir=%q want DSH_HOME %q", plan.ConfigDir, home)
	}
	if len(plan.Resources) != 1 {
		t.Fatalf("resources=%#v want exactly one per-run home cleanup", plan.Resources)
	}
	if plan.Resources[0].OwnershipRoot != req.Spec.Runtime.HomeParent {
		t.Fatalf("ownership root=%q want %q", plan.Resources[0].OwnershipRoot, req.Spec.Runtime.HomeParent)
	}
	for _, rel := range []string{"patch.yaml", dsh.DefaultRuntimePatchAssets().Plugin.Filename} {
		if _, err := os.Stat(filepath.Join(home, rel)); err != nil {
			t.Fatalf("asset %q missing from DSH_HOME: %v", rel, err)
		}
	}
}

func TestBuildPlanDSHPermissionEnv(t *testing.T) {
	req := dshRequestWithDialect(t)
	req.Permission = catalog.PermissionYolo
	plan, err := BuildPlan(req)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if plan.Env[catalog.EnvDSHPermissionMode] != catalog.DSHPermissionMode(catalog.PermissionYolo) {
		t.Fatalf("DSH_PERMISSION_MODE=%q want %q", plan.Env[catalog.EnvDSHPermissionMode], catalog.DSHPermissionMode(catalog.PermissionYolo))
	}
	for _, arg := range plan.Command {
		if strings.HasPrefix(arg, "--permission") {
			t.Fatalf("permissions must be env-carried, never CLI flags: %q", arg)
		}
	}
}

func TestBuildPlanDSHEnvironmentSafety(t *testing.T) {
	req := dshRequestWithDialect(t)
	plan, err := BuildPlan(req)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// The launch-time credential value lives only in the child env.
	if plan.Env["FORGE_DSH_ZHIPU_CODING_API_KEY"] != "secret-zhipu-token" {
		t.Fatalf("credential env missing: %q", plan.Env["FORGE_DSH_ZHIPU_CODING_API_KEY"])
	}
	for _, arg := range plan.Command {
		if strings.Contains(arg, "secret-zhipu-token") {
			t.Fatalf("credential leaked into argv: %q", arg)
		}
	}
	patch, err := os.ReadFile(filepath.Join(plan.Env["DSH_HOME"], "patch.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	patchText := string(patch)
	if strings.Contains(patchText, "secret-zhipu-token") {
		t.Fatal("patch must never contain a literal credential value")
	}
	if !strings.Contains(patchText, "FORGE_DSH_ZHIPU_CODING_API_KEY") {
		t.Fatal("patch must reference the credential env name only")
	}
	if !strings.HasPrefix(patchText, "# forge dsh patch (generated; secret-free)\n- id: llm-pi-ai\n") {
		t.Fatalf("background patch must be a real loader overlay array:\n%s", patchText)
	}
	if !strings.Contains(patchText, "apiKeyEnv: FORGE_DSH_ZHIPU_CODING_API_KEY") {
		t.Fatalf("background patch must reference the credential env name:\n%s", patchText)
	}
	bridgePath := filepath.Join(plan.Env["DSH_HOME"], dsh.DefaultRuntimePatchAssets().Plugin.Filename)
	if !strings.Contains(patchText, "- insert:\n    id: forge-dsh-bridge\n    name: "+strconv.Quote(bridgePath)) {
		t.Fatalf("bridge insert must name the exact absolute materialized plugin path %q:\n%s", bridgePath, patchText)
	}
	if _, err := os.Stat(bridgePath); err != nil {
		t.Fatalf("bridge plugin must exist at the inserted absolute path: %v", err)
	}
}

func TestBuildPlanDSHCapabilityMCPProjection(t *testing.T) {
	req := dshRequestWithDialect(t)
	req.Capabilities = []string{"git-history"}
	req.ResolveCapabilities = func(names []string) (CapabilityResult, error) {
		return CapabilityResult{Tools: CapabilityTools{MCP: []CapabilityServer{
			{Name: "ure", Command: "ure", Args: []string{"serve"}, Env: map[string]string{"X_TAI_IDENTITY": "id"}},
		}}}, nil
	}
	plan, err := BuildPlan(req)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	patch, err := os.ReadFile(filepath.Join(plan.Env["DSH_HOME"], "patch.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	patchText := string(patch)
	if !strings.Contains(patchText, "- insert:\n    id: \"@deepseek-ai/dsh-mcp-client\"\n    serverName: ure\n    transport: stdio") {
		t.Fatalf("MCP capability must project as an inserted client row:\n%s", patchText)
	}
	if !strings.Contains(patchText, "X_TAI_IDENTITY: id") {
		t.Fatalf("MCP env override must be projected:\n%s", patchText)
	}
}

func TestBuildPlanDSHCapabilityUnsupportedFailsLoudly(t *testing.T) {
	req := dshRequestWithDialect(t)
	req.Capabilities = []string{"my-tools"}
	req.ResolveCapabilities = func(names []string) (CapabilityResult, error) {
		return CapabilityResult{Tools: CapabilityTools{Cap: []string{"builtin-tool"}}}, nil
	}
	_, err := BuildPlan(req)
	if err == nil {
		t.Fatal("expected unsupported capability error")
	}
	if !strings.Contains(err.Error(), "only mcp") {
		t.Fatalf("error=%q want loud only-mcp rejection", err.Error())
	}
}

func TestBuildPlanDSHResumeRejectedLoudly(t *testing.T) {
	req := dshRequestWithDialect(t)
	req.ResumeSessionID = "sess-1"
	_, err := BuildPlan(req)
	if err == nil {
		t.Fatal("expected resume rejection")
	}
	if !strings.Contains(err.Error(), "resume") {
		t.Fatalf("error=%q want loud resume rejection", err.Error())
	}
}
