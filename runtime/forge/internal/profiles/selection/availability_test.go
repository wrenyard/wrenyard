package selection

import (
	"testing"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/profiles/config"
)

// fakeDeps builds Dependencies backed entirely by explicit fakes. No real
// client binaries, manifests, credentials, or network are involved.
func fakeDeps(disabled map[string]bool, installed func(string) bool) Dependencies {
	return Dependencies{
		LoadForgeConfig: func() (config.Config, []string, error) {
			cfg := config.Config{Clients: map[string]config.Client{}}
			for client, isDisabled := range disabled {
				cfg.Clients[client] = config.Client{Enabled: !isDisabled}
			}
			return cfg, nil, nil
		},
		ClientInstalled: installed,
	}
}

func TestClientUsability(t *testing.T) {
	enabledAll := func(string) bool { return true }
	missingAll := func(string) bool { return false }

	tests := []struct {
		name      string
		client    string
		disabled  map[string]bool
		installed func(string) bool
		want      ClientEnabledReason
	}{
		{
			name:      "enabled client with installed binary is OK",
			client:    "codex",
			disabled:  map[string]bool{},
			installed: enabledAll,
			want:      ClientOK,
		},
		{
			name:      "config-disabled client is disabled by config",
			client:    "codex",
			disabled:  map[string]bool{"codex": true},
			installed: enabledAll,
			want:      ClientDisabledByConfig,
		},
		{
			name:      "enabled client with missing binary is binary missing",
			client:    "codex",
			disabled:  map[string]bool{},
			installed: missingAll,
			want:      ClientBinaryMissing,
		},
		{
			name:      "unconfigured client defaults to enabled and OK",
			client:    "unknown",
			disabled:  map[string]bool{},
			installed: enabledAll,
			want:      ClientOK,
		},
		{
			name:      "empty client stays OK even when binary lookup would fail",
			client:    "",
			disabled:  map[string]bool{},
			installed: missingAll,
			want:      ClientOK,
		},
		{
			name:      "nil install callback keeps config-only verdict",
			client:    "codex",
			disabled:  map[string]bool{},
			installed: nil,
			want:      ClientOK,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := ClientUsability(tt.client, fakeDeps(tt.disabled, tt.installed))
			if got != tt.want {
				t.Fatalf("ClientUsability(%q) = %q, want %q", tt.client, got, tt.want)
			}
		})
	}
}

func TestAvailableProfileNamesExcludesUnavailableClients(t *testing.T) {
	enabledAll := func(string) bool { return true }

	manifest := map[string]Profile{
		"ok":             {Name: "ok", Client: "codex"},
		"binary-missing": {Name: "binary-missing", Client: "grok"},
		"disabled":       {Name: "disabled", Client: "claude"},
		"empty-client":   {Name: "empty-client", Client: ""},
	}

	tests := []struct {
		name      string
		disabled  map[string]bool
		installed func(string) bool
		want      []string
	}{
		{
			name:      "all clients installed keeps every profile",
			disabled:  map[string]bool{},
			installed: enabledAll,
			want:      []string{"binary-missing", "disabled", "empty-client", "ok"},
		},
		{
			name:      "missing binary drops that profile",
			disabled:  map[string]bool{},
			installed: func(client string) bool { return client != "grok" },
			want:      []string{"disabled", "empty-client", "ok"},
		},
		{
			name:      "config-disabled client drops that profile",
			disabled:  map[string]bool{"claude": true},
			installed: enabledAll,
			want:      []string{"binary-missing", "empty-client", "ok"},
		},
		{
			name:      "nil install callback keeps config-only behavior",
			disabled:  map[string]bool{"claude": true},
			installed: nil,
			want:      []string{"binary-missing", "empty-client", "ok"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := AvailableProfileNames(manifest, fakeDeps(tt.disabled, tt.installed))
			if len(got) != len(tt.want) {
				t.Fatalf("AvailableProfileNames() = %v, want %v", got, tt.want)
			}
			for i := range tt.want {
				if got[i] != tt.want[i] {
					t.Fatalf("AvailableProfileNames() = %v, want %v", got, tt.want)
				}
			}
		})
	}
}
