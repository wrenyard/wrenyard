package driver

import (
	"strings"
	"testing"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/catalog"
)

func cursorPlanRequest(t *testing.T, mode catalog.PermissionMode) PlanRequest {
	t.Helper()
	return PlanRequest{
		Spec: ProfileSpec{
			Name: "cur-composer",
			Env:  map[string]string{catalog.EnvCursorModel: "composer-2.5"},
			ClientDesc: catalog.Client{
				Name:              "cursor",
				Dialect:           catalog.DialectCursor,
				Binary:            catalog.BinarySpec{Name: "go"},
				PermissionAdapter: catalog.PermissionAdapterCursor,
				ResumeFlag:        catalog.ResumeFlagLong,
			},
			CredentialTarget: "CURSOR_AUTH_TOKEN",
			CredentialValue:  "desktop-token-value",
		},
		Prompt:     "fix the build",
		WorkDir:    t.TempDir(),
		Permission: mode,
	}
}

func TestCursorPlanUsesCanonicalExecutableAndFlags(t *testing.T) {
	req := cursorPlanRequest(t, catalog.PermissionEdit)
	plan, err := buildCursorPlan(req)
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.Command) == 0 || !strings.HasSuffix(plan.Command[0], "/go") && plan.Command[0] != "go" {
		t.Fatalf("cursor plan must invoke the canonical cursor-agent binary, got %v", plan.Command)
	}
	if !containsOrderedArgs(plan.Command, "-p", "--output-format", "stream-json", "--trust", "--model", "composer-2.5") {
		t.Fatalf("cursor plan missing fixed flags: %v", plan.Command)
	}
	if !containsArg(plan.Command, req.Prompt) {
		t.Fatalf("cursor plan must carry the prompt positionally: %v", plan.Command)
	}
	if plan.Dialect != catalog.DialectCursor {
		t.Fatalf("dialect = %v, want cursor", plan.Dialect)
	}
}

func TestCursorPlanAllPermissionModes(t *testing.T) {
	for _, tc := range []struct {
		mode  catalog.PermissionMode
		flags []string
	}{
		{catalog.PermissionReadonly, []string{"--mode", "plan", "--force", "--sandbox", "enabled"}},
		{catalog.PermissionEdit, []string{"--force", "--sandbox", "enabled"}},
		{catalog.PermissionYolo, []string{"--force", "--sandbox", "disabled"}},
	} {
		t.Run(string(tc.mode), func(t *testing.T) {
			plan, err := buildCursorPlan(cursorPlanRequest(t, tc.mode))
			if err != nil {
				t.Fatal(err)
			}
			for _, f := range tc.flags {
				if !containsArg(plan.Command, f) {
					t.Fatalf("mode %s missing flag %q: %v", tc.mode, f, plan.Command)
				}
			}
		})
	}
}

func TestCursorPlanAuthTokenOnlyThroughChildEnv(t *testing.T) {
	plan, err := buildCursorPlan(cursorPlanRequest(t, catalog.PermissionEdit))
	if err != nil {
		t.Fatal(err)
	}
	if plan.Env["CURSOR_AUTH_TOKEN"] != "desktop-token-value" {
		t.Fatalf("CURSOR_AUTH_TOKEN = %q, want desktop-token-value", plan.Env["CURSOR_AUTH_TOKEN"])
	}
	for _, arg := range plan.Command {
		if strings.Contains(arg, "desktop-token-value") {
			t.Fatalf("auth token leaked into argv: %v", plan.Command)
		}
	}
}

func TestCursorPlanResumeUsesNativeFlag(t *testing.T) {
	req := cursorPlanRequest(t, catalog.PermissionEdit)
	req.ResumeSessionID = "sess_123"
	plan, err := buildCursorPlan(req)
	if err != nil {
		t.Fatal(err)
	}
	if !containsOrderedArgs(plan.Command, "--resume", "sess_123") {
		t.Fatalf("resume flag missing: %v", plan.Command)
	}
}

func TestCursorPlanRejectsCapabilities(t *testing.T) {
	req := cursorPlanRequest(t, catalog.PermissionEdit)
	req.Capabilities = []string{"some-pack"}
	_, err := buildCursorPlan(req)
	if err == nil {
		t.Fatalf("expected capability rejection, got nil")
	}
}

func TestCursorPlanMissingModelFails(t *testing.T) {
	req := cursorPlanRequest(t, catalog.PermissionEdit)
	delete(req.Spec.Env, catalog.EnvCursorModel)
	_, err := buildCursorPlan(req)
	if err == nil {
		t.Fatalf("expected missing-model error, got nil")
	}
}

func TestCursorPlanMissingBinaryFails(t *testing.T) {
	req := cursorPlanRequest(t, catalog.PermissionEdit)
	req.Spec.ClientDesc.Binary = catalog.BinarySpec{Name: "definitely-not-a-real-cursor-agent-binary"}
	_, err := buildCursorPlan(req)
	if err == nil {
		t.Fatalf("expected missing-binary error, got nil")
	}
}
