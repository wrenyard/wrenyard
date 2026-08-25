package quota

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

const testDeepSeekToken = "deepseek-test-token-not-a-secret"

func deepseekTestServer(t *testing.T, handler http.HandlerFunc) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	return srv
}

func TestDeepSeekProviderSuccessMultiCurrency(t *testing.T) {
	srv := deepseekTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			t.Fatalf("method = %s, want GET", r.Method)
		}
		if auth := r.Header.Get("Authorization"); auth != "Bearer "+testDeepSeekToken {
			t.Fatalf("Authorization = %q, want Bearer token", auth)
		}
		if accept := r.Header.Get("Accept"); accept != "application/json" {
			t.Fatalf("Accept = %q, want application/json", accept)
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{
			"is_available": true,
			"balance_infos": [
				{"currency": "CNY", "total_balance": "120.50"},
				{"currency": "USD", "total_balance": "8.25"}
			]
		}`))
	})

	fixed := time.Date(2026, 8, 25, 12, 0, 0, 0, time.UTC)
	p := DeepSeekProvider{Token: testDeepSeekToken, URL: srv.URL, Now: func() time.Time { return fixed }}
	q, err := p.Fetch(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if q.Provider != "deepseek" {
		t.Fatalf("provider = %q, want deepseek", q.Provider)
	}
	if q.Source != "deepseek-balance" {
		t.Fatalf("source = %q, want deepseek-balance", q.Source)
	}
	if !q.FetchedAt.Equal(fixed) {
		t.Fatalf("FetchedAt = %v, want %v", q.FetchedAt, fixed)
	}
	if len(q.Balances) != 2 {
		t.Fatalf("balances = %#v, want 2 entries", q.Balances)
	}
	if q.Balances[0].Currency != "CNY" || q.Balances[0].Amount != "120.50" {
		t.Fatalf("balances[0] = %#v, want CNY 120.50", q.Balances[0])
	}
	if q.Balances[1].Currency != "USD" || q.Balances[1].Amount != "8.25" {
		t.Fatalf("balances[1] = %#v, want USD 8.25", q.Balances[1])
	}

	// Balances must not fabricate percentage windows or pace fields.
	if len(q.Windows) != 0 {
		t.Fatalf("expected no windows for balance-only quota, got %#v", q.Windows)
	}
	raw, err := json.Marshal(q)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), "pct") || strings.Contains(string(raw), "windows") {
		t.Fatalf("balance quota JSON must not fabricate percent/windows: %s", raw)
	}
	// Credential hygiene: token must never leak into quota JSON.
	if strings.Contains(string(raw), testDeepSeekToken) {
		t.Fatal("token leaked into quota JSON")
	}
}

func TestDeepSeekProviderSingleCurrency(t *testing.T) {
	srv := deepseekTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"is_available": true, "balance_infos": [{"currency": "usd", "total_balance": "3"}]}`))
	})

	p := DeepSeekProvider{Token: testDeepSeekToken, URL: srv.URL}
	q, err := p.Fetch(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	// currency is uppercased; amount preserved exactly.
	if len(q.Balances) != 1 || q.Balances[0].Currency != "USD" || q.Balances[0].Amount != "3" {
		t.Fatalf("balances = %#v, want USD 3", q.Balances)
	}
}

func TestDeepSeekProviderMissingToken(t *testing.T) {
	p := DeepSeekProvider{Token: "   "}
	_, err := p.Fetch(context.Background())
	if err == nil {
		t.Fatal("expected error when token is missing")
	}
	if strings.Contains(err.Error(), "token") == false {
		t.Fatalf("expected token error, got %v", err)
	}
}

func TestDeepSeekProviderNon2xx(t *testing.T) {
	srv := deepseekTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	})
	p := DeepSeekProvider{Token: testDeepSeekToken, URL: srv.URL}
	_, err := p.Fetch(context.Background())
	if err == nil {
		t.Fatal("expected error on non-2xx")
	}
	if !strings.Contains(err.Error(), "401") {
		t.Fatalf("expected status 401 in error, got %v", err)
	}
}

func TestDeepSeekProviderUnavailable(t *testing.T) {
	srv := deepseekTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"is_available": false, "balance_infos": [{"currency": "CNY", "total_balance": "10"}]}`))
	})
	p := DeepSeekProvider{Token: testDeepSeekToken, URL: srv.URL}
	_, err := p.Fetch(context.Background())
	if err == nil {
		t.Fatal("expected error when is_available is false")
	}
}

func TestDeepSeekProviderEmptyBalanceInfos(t *testing.T) {
	srv := deepseekTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"is_available": true, "balance_infos": []}`))
	})
	p := DeepSeekProvider{Token: testDeepSeekToken, URL: srv.URL}
	_, err := p.Fetch(context.Background())
	if err == nil {
		t.Fatal("expected error when balance_infos is empty")
	}
}

func TestDeepSeekProviderMalformedResponse(t *testing.T) {
	srv := deepseekTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		w.Write([]byte("<html>not json</html>"))
	})
	p := DeepSeekProvider{Token: testDeepSeekToken, URL: srv.URL}
	_, err := p.Fetch(context.Background())
	if err == nil {
		t.Fatal("expected error on malformed response")
	}
	if !strings.Contains(err.Error(), "malformed") {
		t.Fatalf("expected malformed error, got %v", err)
	}
}

func TestParseDeepSeekBalanceNegativeAmount(t *testing.T) {
	_, err := ParseDeepSeekBalance([]byte(`{"is_available": true, "balance_infos": [{"currency": "CNY", "total_balance": "-5"}]}`))
	if err == nil {
		t.Fatal("expected error on negative amount")
	}
}

func TestParseDeepSeekBalanceInvalidCurrency(t *testing.T) {
	_, err := ParseDeepSeekBalance([]byte(`{"is_available": true, "balance_infos": [{"currency": "XX", "total_balance": "5"}]}`))
	if err == nil {
		t.Fatal("expected error on invalid currency")
	}
}

func TestParseDeepSeekBalanceMalformedAmount(t *testing.T) {
	_, err := ParseDeepSeekBalance([]byte(`{"is_available": true, "balance_infos": [{"currency": "CNY", "total_balance": "1.2.3"}]}`))
	if err == nil {
		t.Fatal("expected error on malformed amount")
	}
}
