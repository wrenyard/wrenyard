package cursor

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestAvailabilityAvailableModel(t *testing.T) {
	srv := newModelsServer(t, func(http.ResponseWriter, *http.Request) []byte {
		return []byte(`{"models":[{"name":"composer-1","supportsAgent":true}]}`)
	})
	got, err := (Reader{Endpoint: srv.URL, Token: "test-token"}).Availability()
	if err != nil {
		t.Fatalf("Availability: %v", err)
	}
	if got["composer-1"] != (Availability{Status: StatusAvailable}) {
		t.Fatalf("composer-1 = %#v, want available", got["composer-1"])
	}
}

func TestAvailabilityTeamSettingsBlockedThenUnblocked(t *testing.T) {
	calls := 0
	srv := newModelsServer(t, func(http.ResponseWriter, *http.Request) []byte {
		calls++
		if calls == 1 {
			return []byte(`{"models":[{"name":"arbitrary-team-model","reasonForZdrConsentBlock":"team_settings_blocked","supportsAgent":true}]}`)
		}
		return []byte(`{"models":[{"name":"arbitrary-team-model","supportsAgent":true}]}`)
	})
	reader := Reader{Endpoint: srv.URL, Token: "test-token"}
	first, err := reader.Availability()
	if err != nil {
		t.Fatalf("first Availability: %v", err)
	}
	if first["arbitrary-team-model"] != (Availability{Status: StatusBlocked, Reason: ReasonAdminBlocked}) {
		t.Fatalf("blocked = %#v, want admin_blocked", first["arbitrary-team-model"])
	}
	second, err := reader.Availability()
	if err != nil {
		t.Fatalf("second Availability: %v", err)
	}
	if second["arbitrary-team-model"] != (Availability{Status: StatusAvailable}) {
		t.Fatalf("unblocked = %#v, want available", second["arbitrary-team-model"])
	}
}

func TestAvailabilityExactAliases(t *testing.T) {
	srv := newModelsServer(t, func(http.ResponseWriter, *http.Request) []byte {
		return []byte(`{"models":[{
			"name":"primary-id",
			"serverModelName":"server-id",
			"legacySlugs":["legacy-id"],
			"idAliases":["alias-id"],
			"variants":[{"legacySlug":"variant-id","variantStringRepresentation":"primary-id[effort=high]"}],
			"supportsAgent":true
		}]}`)
	})
	got, err := (Reader{Endpoint: srv.URL, Token: "test-token"}).Availability()
	if err != nil {
		t.Fatalf("Availability: %v", err)
	}
	for _, id := range []string{"primary-id", "server-id", "legacy-id", "alias-id", "variant-id", "primary-id[effort=high]"} {
		if got[id] != (Availability{Status: StatusAvailable}) {
			t.Fatalf("%s = %#v, want available", id, got[id])
		}
	}
}

func TestAvailabilityDefaultOnFalseAndRetentionRemainAvailable(t *testing.T) {
	srv := newModelsServer(t, func(http.ResponseWriter, *http.Request) []byte {
		return []byte(`{"models":[{
			"name":"default-off",
			"defaultOn":false,
			"defaultDisabledInAdminAllowlist":true,
			"requiresDataRetention":true,
			"supportsAgent":true
		}]}`)
	})
	got, err := (Reader{Endpoint: srv.URL, Token: "test-token"}).Availability()
	if err != nil {
		t.Fatalf("Availability: %v", err)
	}
	if got["default-off"] != (Availability{Status: StatusAvailable}) {
		t.Fatalf("default-off = %#v, want available", got["default-off"])
	}
}

func TestAvailabilityDisabledAndUnsupportedBlock(t *testing.T) {
	srv := newModelsServer(t, func(http.ResponseWriter, *http.Request) []byte {
		return []byte(`{"models":[
			{"name":"disabled-model","degradationStatus":"DEGRADATION_STATUS_DISABLED","supportsAgent":true},
			{"name":"numeric-disabled","degradationStatus":2,"supportsAgent":true},
			{"name":"unknown-agent"},
			{"name":"no-agent","supportsAgent":false}
		]}`)
	})
	got, err := (Reader{Endpoint: srv.URL, Token: "test-token"}).Availability()
	if err != nil {
		t.Fatalf("Availability: %v", err)
	}
	if got["disabled-model"] != (Availability{Status: StatusBlocked, Reason: ReasonModelDisabled}) {
		t.Fatalf("disabled-model = %#v, want model_disabled", got["disabled-model"])
	}
	if got["no-agent"] != (Availability{Status: StatusBlocked, Reason: ReasonUnsupported}) {
		t.Fatalf("no-agent = %#v, want unsupported", got["no-agent"])
	}
	if got["numeric-disabled"].Status != StatusBlocked || got["unknown-agent"].Status != StatusUnknown {
		t.Fatal("numeric denial and missing capability must not admit a model")
	}
}

func TestAvailabilityMissingMalformedTimeoutSanitizeErrors(t *testing.T) {
	token := "super-secret-cursor-token"
	t.Run("missing models", func(t *testing.T) {
		srv := newModelsServer(t, func(http.ResponseWriter, *http.Request) []byte {
			return []byte(`{"ok":true}`)
		}, token)
		_, err := (Reader{Endpoint: srv.URL, Token: token}).Availability()
		if err == nil {
			t.Fatal("expected error for missing models")
		}
		assertSanitizedError(t, err, token, srv.URL)
	})
	t.Run("malformed json", func(t *testing.T) {
		srv := newModelsServer(t, func(http.ResponseWriter, *http.Request) []byte {
			return []byte(`{"models":`)
		}, token)
		_, err := (Reader{Endpoint: srv.URL, Token: token}).Availability()
		if err == nil {
			t.Fatal("expected error for malformed json")
		}
		assertSanitizedError(t, err, token, srv.URL)
	})
	t.Run("timeout", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			assertAvailabilityRequest(t, r, token)
			time.Sleep(200 * time.Millisecond)
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{"models":[]}`))
		}))
		t.Cleanup(srv.Close)
		_, err := (Reader{Endpoint: srv.URL, Token: token, Timeout: 20 * time.Millisecond}).Availability()
		if err == nil {
			t.Fatal("expected timeout")
		}
		assertSanitizedError(t, err, token, srv.URL)
	})
	t.Run("http error body", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			assertAvailabilityRequest(t, r, token)
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"error":"invalid token super-secret-cursor-token"}`))
		}))
		t.Cleanup(srv.Close)
		_, err := (Reader{Endpoint: srv.URL, Token: token}).Availability()
		if err == nil {
			t.Fatal("expected error")
		}
		assertSanitizedError(t, err, token, srv.URL)
	})
}

func TestAvailabilityConflictingDuplicatesAreConservative(t *testing.T) {
	srv := newModelsServer(t, func(http.ResponseWriter, *http.Request) []byte {
		return []byte(`{"models":[
			{"name":"shared-id","supportsAgent":true},
			{"name":"other","idAliases":["shared-id"],"reasonForZdrConsentBlock":"team_settings_blocked"}
		]}`)
	})
	got, err := (Reader{Endpoint: srv.URL, Token: "test-token"}).Availability()
	if err != nil {
		t.Fatalf("Availability: %v", err)
	}
	if got["shared-id"].Status != StatusBlocked || got["shared-id"].Reason != ReasonAdminBlocked {
		t.Fatalf("shared-id = %#v, want blocked admin_blocked", got["shared-id"])
	}
}

func newModelsServer(t *testing.T, body func(http.ResponseWriter, *http.Request) []byte, tokens ...string) *httptest.Server {
	t.Helper()
	token := "test-token"
	if len(tokens) > 0 {
		token = tokens[0]
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assertAvailabilityRequest(t, r, token)
		payload := body(w, r)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(payload)
	}))
	t.Cleanup(srv.Close)
	return srv
}

func assertAvailabilityRequest(t *testing.T, r *http.Request, token string) {
	t.Helper()
	if r.Method != http.MethodPost {
		t.Fatalf("method = %s, want POST", r.Method)
	}
	if r.Header.Get("Content-Type") != "application/json" {
		t.Fatalf("Content-Type = %q", r.Header.Get("Content-Type"))
	}
	if r.Header.Get("Connect-Protocol-Version") != "1" {
		t.Fatalf("Connect-Protocol-Version = %q", r.Header.Get("Connect-Protocol-Version"))
	}
	if got := r.Header.Get("Authorization"); got != "Bearer "+token {
		t.Fatalf("Authorization = %q", got)
	}
	raw, err := io.ReadAll(r.Body)
	if err != nil {
		t.Fatalf("read body: %v", err)
	}
	var payload map[string]bool
	if err := json.Unmarshal(raw, &payload); err != nil {
		t.Fatalf("request json: %v", err)
	}
	if !payload["useModelParameters"] || !payload["includeHiddenModels"] || !payload["doNotUseMarkdown"] {
		t.Fatalf("request payload = %#v", payload)
	}
}

func assertSanitizedError(t *testing.T, err error, token, url string) {
	t.Helper()
	msg := err.Error()
	if strings.Contains(msg, token) {
		t.Fatalf("error leaked token: %v", err)
	}
	if strings.Contains(msg, url) {
		t.Fatalf("error leaked endpoint: %v", err)
	}
	if strings.Contains(msg, "{") || strings.Contains(msg, "invalid token") {
		t.Fatalf("error leaked body: %v", err)
	}
}
