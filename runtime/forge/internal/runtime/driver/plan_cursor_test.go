package driver

import (
	"path/filepath"
	"reflect"
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

// TestCursorPlanPermissionModesForPlatform exercises the production permission
// helper for every simulated platform, so Windows-specific refusals and the
// catalog-sourced non-Windows shapes are asserted on any host.
func TestCursorPlanPermissionModesForPlatform(t *testing.T) {
	for _, tc := range []struct {
		goos    string
		mode    catalog.PermissionMode
		want    []string
		wantErr bool
	}{
		{goos: "windows", mode: catalog.PermissionReadonly, want: []string{"--mode", "plan", "--force", "--sandbox", "disabled"}},
		{goos: "windows", mode: catalog.PermissionEdit, wantErr: true},
		{goos: "windows", mode: catalog.PermissionYolo, want: []string{"--force", "--sandbox", "disabled"}},
		{goos: "linux", mode: catalog.PermissionReadonly, want: []string{"--mode", "plan", "--force", "--sandbox", "enabled"}},
		{goos: "linux", mode: catalog.PermissionEdit, want: []string{"--force", "--sandbox", "enabled"}},
		{goos: "linux", mode: catalog.PermissionYolo, want: []string{"--force", "--sandbox", "disabled"}},
		{goos: "darwin", mode: catalog.PermissionReadonly, want: []string{"--mode", "plan", "--force", "--sandbox", "enabled"}},
		{goos: "darwin", mode: catalog.PermissionEdit, want: []string{"--force", "--sandbox", "enabled"}},
		{goos: "darwin", mode: catalog.PermissionYolo, want: []string{"--force", "--sandbox", "disabled"}},
	} {
		t.Run(tc.goos+"/"+string(tc.mode), func(t *testing.T) {
			got, err := cursorPermissionArgs("cur-composer", tc.mode, tc.goos)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("%s %s must refuse to plan without --sandbox enabled, got args %v", tc.goos, tc.mode, got)
				}
				if len(got) != 0 {
					t.Fatalf("%s %s must not emit args on failure, got %v", tc.goos, tc.mode, got)
				}
				if !strings.Contains(strings.ToLower(err.Error()), "sandbox") {
					t.Fatalf("%s %s error must name the sandbox limitation, got %v", tc.goos, tc.mode, err)
				}
				return
			}
			if err != nil {
				t.Fatalf("cursorPermissionArgs(%s, %s): %v", tc.goos, tc.mode, err)
			}
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("%s %s permission args = %v, want %v", tc.goos, tc.mode, got, tc.want)
			}
		})
	}
}

func TestCursorPlanUsesCanonicalExecutableAndFlags(t *testing.T) {
	req := cursorPlanRequest(t, catalog.PermissionReadonly)
	plan, err := buildCursorPlan(req)
	if err != nil {
		t.Fatal(err)
	}
	// The canonical executable is "go" on every platform; Windows resolves it
	// as go.exe, so compare the extension-stripped base name.
	if len(plan.Command) == 0 || strings.TrimSuffix(filepath.Base(plan.Command[0]), ".exe") != "go" {
		t.Fatalf("cursor plan must invoke the canonical cursor-agent binary, got %v", plan.Command)
	}
	if !containsOrderedArgs(plan.Command, "-p", "--output-format", "stream-json", "--trust", "--model", "composer-2.5") {
		t.Fatalf("cursor plan missing fixed flags: %v", plan.Command)
	}
	if containsArg(plan.Command, req.Prompt) {
		t.Fatalf("cursor prompt must not be exposed through argv: %v", plan.Command)
	}
	if got := readCommandStdin(t, plan.Stdin); got != req.Prompt {
		t.Fatalf("cursor stdin prompt = %q, want %q", got, req.Prompt)
	}
	if plan.Dialect != catalog.DialectCursor {
		t.Fatalf("dialect = %v, want cursor", plan.Dialect)
	}
}

func TestCursorPlanAuthTokenOnlyThroughChildEnv(t *testing.T) {
	plan, err := buildCursorPlan(cursorPlanRequest(t, catalog.PermissionReadonly))
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
	req := cursorPlanRequest(t, catalog.PermissionReadonly)
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
	req := cursorPlanRequest(t, catalog.PermissionReadonly)
	req.Capabilities = []string{"some-pack"}
	_, err := buildCursorPlan(req)
	if err == nil {
		t.Fatalf("expected capability rejection, got nil")
	}
}

func TestCursorPlanMissingModelFails(t *testing.T) {
	req := cursorPlanRequest(t, catalog.PermissionReadonly)
	delete(req.Spec.Env, catalog.EnvCursorModel)
	_, err := buildCursorPlan(req)
	if err == nil {
		t.Fatalf("expected missing-model error, got nil")
	}
}

func TestCursorPlanMissingBinaryFails(t *testing.T) {
	req := cursorPlanRequest(t, catalog.PermissionReadonly)
	req.Spec.ClientDesc.Binary = catalog.BinarySpec{Name: "definitely-not-a-real-cursor-agent-binary"}
	_, err := buildCursorPlan(req)
	if err == nil {
		t.Fatalf("expected missing-binary error, got nil")
	}
}
