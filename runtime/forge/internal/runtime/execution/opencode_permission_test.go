package execution

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"testing"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/bashgate"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/catalog"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/protocol"
)

func TestOpenCodePerRunPermissionConfigIsObservedAndCleanedOnCompletion(t *testing.T) {
	for _, success := range []bool{true, false} {
		name := "failure"
		if success {
			name = "success"
		}
		t.Run(name, func(t *testing.T) {
			d := newFakeDeps(t)
			var observedHome string
			d.Dependencies.Runner = func(_ context.Context, request AttemptRequest) ChildResult {
				observedHome = request.Plan.ConfigDir
				if info, err := os.Stat(observedHome); err != nil || !info.IsDir() {
					t.Fatalf("OpenCode per-run config was not materialized before launch: %v", err)
				}
				var config struct {
					Permission map[string]interface{} `json:"permission"`
				}
				base, readErr := os.ReadFile(request.Plan.Env["OPENCODE_CONFIG"])
				if readErr != nil {
					t.Fatalf("read launched OpenCode config: %v", readErr)
				}
				if err := json.Unmarshal(base, &config); err != nil {
					t.Fatalf("decode launched OpenCode config: %v", err)
				}
				if config.Permission["read"] != "allow" || config.Permission["edit"] != "allow" || config.Permission["task"] == "allow" || config.Permission["*"] != "deny" {
					t.Fatalf("launched edit-mode permission config = %#v", config.Permission)
				}
				if request.Plan.Env["XDG_CONFIG_HOME"] != observedHome || request.Plan.Env["OPENCODE_CONFIG_DIR"] != observedHome {
					t.Fatalf("launched OpenCode config paths = %#v", request.Plan.Env)
				}
				bashPermission, ok := config.Permission["bash"].(map[string]interface{})
				if !ok || len(bashPermission) != 1 || bashPermission["*"] != "deny" {
					t.Fatalf("launched OpenCode bootstrap Bash permission = %#v", config.Permission["bash"])
				}
				if request.Plan.Env[bashgate.ModeEnv] != string(bashgate.ClientOpenCode) || request.Plan.Env[bashgate.OpenCodeBashPermissionEnv] == "" {
					t.Fatalf("launched OpenCode BashGate env = %#v", request.Plan.Env)
				}
				if success {
					return ChildResult{Status: "done", ExitCode: 0, Events: doneEvent("ok")}
				}
				return ChildResult{Status: "failed", ExitCode: 7, Events: []protocol.Event{{
					Type: protocol.EventRunFinished,
					Data: map[string]any{"status": "failed", "exit_code": 7},
				}}}
			}

			result, err := Execute(Request{
				ProfileName: "oc", Prompt: "inspect", WorkDir: tempDir(t),
				Permission: catalog.PermissionEdit,
			}, d.Dependencies, &bytes.Buffer{}, &bytes.Buffer{})
			if success && (err != nil || result.Status != "done") {
				t.Fatalf("successful OpenCode execution = %+v err=%v", result, err)
			}
			if !success && result.Status == "done" {
				t.Fatalf("failed OpenCode child reported success: %+v", result)
			}
			if observedHome == "" {
				t.Fatal("OpenCode runner was not called")
			}
			_, statErr := os.Stat(observedHome)
			if success && !os.IsNotExist(statErr) {
				t.Fatalf("successful OpenCode per-run config was not cleaned: %v", statErr)
			}
			if !success && statErr != nil {
				t.Fatalf("abnormal OpenCode run did not retain per-run config: %v", statErr)
			}
		})
	}
}
