package doctor

import (
	"errors"
	"testing"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/profiles/config"
)

// These tests exercise the focused `clients` doctor target. They prove that a
// clients-only report carries enabled/installed status for every catalog and
// config client, that unrelated checker hooks are never invoked for this
// target, and that a config load error is a report failure.

func clientsTargetDeps(t *testing.T, catalogIDs []string) (Dependencies, *[]string) {
	t.Helper()
	calls := &[]string{}
	cfg := config.Config{Clients: map[string]config.Client{
		"claude": {Enabled: true},
		"codex":  {Enabled: true},
	}}
	ids := catalogIDs
	deps := Dependencies{
		UserHome: func() string { return t.TempDir() },
		LoadForgeConfig: func() (config.Config, []string, error) {
			return cfg, nil, nil
		},
		ClientInstalled: func(id string) bool { *calls = append(*calls, "ClientInstalled:"+id); return true },
		ClientIDs:       func() []string { return ids },
		// Unrelated checker hooks record any accidental invocation so the test
		// can assert the clients target never runs them.
		ReadFile: func(string) ([]byte, error) {
			*calls = append(*calls, "ReadFile")
			return nil, errors.New("unexpected")
		},
		ReadText: func(string) string { *calls = append(*calls, "ReadText"); return "" },
		ReadSecretsFile: func(string) map[string]interface{} {
			*calls = append(*calls, "ReadSecretsFile")
			return nil
		},
	}
	return deps, calls
}

func clientsOnlyReport(t *testing.T, target string, deps Dependencies) map[string]interface{} {
	t.Helper()
	report := BuildReport(deps, target)
	checks, ok := report["checks"].([]map[string]interface{})
	if !ok {
		t.Fatalf("report checks missing or wrong type: %#v", report["checks"])
	}
	if len(checks) != 1 {
		t.Fatalf("clients target must emit exactly one check group, got %d: %#v", len(checks), checks)
	}
	if checks[0]["adapter"] != "clients" {
		t.Fatalf("expected only clients adapter, got %v", checks[0]["adapter"])
	}
	return report
}

func TestClientsTargetReportsEnabledAndInstalledForAllClients(t *testing.T) {
	catalogIDs := []string{"claude", "codex", "grok"}
	deps, calls := clientsTargetDeps(t, catalogIDs)
	report := clientsOnlyReport(t, "clients", deps)

	checks := report["checks"].([]map[string]interface{})
	details, ok := checks[0]["details"].(map[string]interface{})
	if !ok {
		t.Fatalf("clients check details missing: %#v", checks[0])
	}
	// Config clients (claude, codex) plus catalog clients (claude, codex, grok)
	// union to all catalog and config clients.
	for _, id := range catalogIDs {
		entry, ok := details[id].(map[string]interface{})
		if !ok {
			t.Fatalf("client %q missing from details: %#v", id, details)
		}
		if entry["enabled"] != true {
			t.Fatalf("client %q enabled=%v want true", id, entry["enabled"])
		}
		if entry["installed"] != true {
			t.Fatalf("client %q installed=%v want true", id, entry["installed"])
		}
	}

	// No unrelated checker hooks may run for the clients-only target.
	for _, call := range *calls {
		switch call {
		case "ClientInstalled:claude", "ClientInstalled:codex", "ClientInstalled:grok":
		default:
			t.Fatalf("unrelated hook %q ran for clients target; calls=%v", call, *calls)
		}
	}
}

func TestClientsTargetConfigErrorIsReportFailure(t *testing.T) {
	deps := Dependencies{
		LoadForgeConfig: func() (config.Config, []string, error) {
			return config.Config{}, nil, errors.New("boom")
		},
		ClientInstalled: func(string) bool { return true },
	}
	report := BuildReport(deps, "clients")
	if report["ok"] != false {
		t.Fatalf("config load error must fail the report, ok=%v", report["ok"])
	}
	checks := report["checks"].([]map[string]interface{})
	if len(checks) != 1 || checks[0]["adapter"] != "clients" || checks[0]["status"] != "error" {
		t.Fatalf("expected a single failing clients check, got %#v", checks)
	}
}
