package quota

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type bufferWriteCloser struct{ io.Writer }

func (bufferWriteCloser) Close() error { return nil }

func superGrokProcess(responses ...string) (codexAppServerProcess, *bytes.Buffer) {
	requests := &bytes.Buffer{}
	return codexAppServerProcess{
		stdout: strings.NewReader(strings.Join(responses, "\n") + "\n"),
		stdin:  bufferWriteCloser{Writer: requests},
	}, requests
}

func TestSuperGrokMissingLoginIsConfigurationMissing(t *testing.T) {
	queried := false
	provider := SuperGrokProvider{
		ResolveAuthSources: func() []string { return nil },
		RunRPC: func(context.Context, string) (codexAppServerProcess, error) {
			queried = true
			return codexAppServerProcess{}, errors.New("must not run")
		},
	}
	_, err := provider.Fetch(context.Background())
	if queried {
		t.Fatal("missing login must not start the Grok ACP process")
	}
	var statusErr *QuotaStatusError
	if !errors.As(err, &statusErr) || statusErr.Code != QuotaCodeConfigurationMissing {
		t.Fatalf("missing login error = %#v, want %s", err, QuotaCodeConfigurationMissing)
	}
}

func TestSuperGrokMissingClientIsConfigurationMissing(t *testing.T) {
	provider := SuperGrokProvider{
		ResolveAuthSources: func() []string { return []string{"/tmp/grok/auth.json"} },
		RunRPC: func(context.Context, string) (codexAppServerProcess, error) {
			return codexAppServerProcess{}, exec.ErrNotFound
		},
	}
	_, err := provider.Fetch(context.Background())
	var statusErr *QuotaStatusError
	if !errors.As(err, &statusErr) || statusErr.Code != QuotaCodeConfigurationMissing {
		t.Fatalf("missing client error = %#v, want %s", err, QuotaCodeConfigurationMissing)
	}
}

func TestSuperGrokAuthRequiredIsNotLoggedIn(t *testing.T) {
	proc, _ := superGrokProcess(
		`{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1}}`,
		`{"jsonrpc":"2.0","id":2,"error":{"code":-32000,"message":"Authentication required"}}`,
	)
	provider := SuperGrokProvider{
		ResolveAuthSources: func() []string { return []string{"/tmp/grok/auth.json"} },
		RunRPC:             func(context.Context, string) (codexAppServerProcess, error) { return proc, nil },
	}
	_, err := provider.Fetch(context.Background())
	var statusErr *QuotaStatusError
	if !errors.As(err, &statusErr) || statusErr.Code != QuotaCodeAuthenticationRequired {
		t.Fatalf("expired login error = %#v, want %s", err, QuotaCodeAuthenticationRequired)
	}
	if strings.Contains(err.Error(), "-32000") || strings.Contains(err.Error(), "Authentication required") {
		t.Fatalf("raw ACP error leaked through friendly status: %v", err)
	}
}

func TestSuperGrokBillingFailureIsQuotaQueryFailure(t *testing.T) {
	proc, _ := superGrokProcess(
		`{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1}}`,
		`{"jsonrpc":"2.0","id":2,"error":{"code":-32603,"message":"Internal error","data":"Billing service error: HTTP 503"}}`,
	)
	provider := SuperGrokProvider{
		ResolveAuthSources: func() []string { return []string{"/tmp/grok/auth.json"} },
		RunRPC:             func(context.Context, string) (codexAppServerProcess, error) { return proc, nil },
	}
	_, err := provider.Fetch(context.Background())
	var statusErr *QuotaStatusError
	if !errors.As(err, &statusErr) || statusErr.Code != QuotaCodeQueryFailed {
		t.Fatalf("billing failure error = %#v, want %s", err, QuotaCodeQueryFailed)
	}
	if strings.Contains(err.Error(), "HTTP 503") || strings.Contains(err.Error(), "Internal error") {
		t.Fatalf("raw billing error leaked through friendly status: %v", err)
	}
}

func TestSuperGrokFetchUsesOfficialACPAndProjectsCredits(t *testing.T) {
	proc, requests := superGrokProcess(
		`{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1}}`,
		`{"jsonrpc":"2.0","id":2,"result":{"config":{"creditUsagePercent":42.5,"currentPeriod":{"type":"USAGE_PERIOD_TYPE_WEEKLY","start":"2026-08-24T00:00:00Z","end":"2026-08-31T00:00:00Z"},"prepaidBalance":{"val":1250}},"subscriptionTier":"SuperGrok Heavy"}}`,
	)
	authPath := filepath.Join(t.TempDir(), "auth.json")
	provider := SuperGrokProvider{
		ResolveAuthSources: func() []string { return []string{authPath} },
		RunRPC: func(_ context.Context, grokHome string) (codexAppServerProcess, error) {
			if grokHome != filepath.Dir(authPath) {
				t.Fatalf("GROK_HOME = %q, want %q", grokHome, filepath.Dir(authPath))
			}
			return proc, nil
		},
	}
	got, err := provider.Fetch(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if got.Provider != "super-grok" || got.Source != "grok-acp-billing" {
		t.Fatalf("identity = provider %q source %q", got.Provider, got.Source)
	}
	if len(got.Windows) != 1 {
		t.Fatalf("windows = %#v", got.Windows)
	}
	window := got.Windows[0]
	if window.Name != "7d" || window.Pct != 42.5 || window.WindowMinutes != 7*24*60 {
		t.Fatalf("window = %#v", window)
	}
	wantReset := time.Date(2026, 8, 31, 0, 0, 0, 0, time.UTC)
	if window.ResetsAt == nil || !window.ResetsAt.Equal(wantReset) {
		t.Fatalf("reset = %v, want %v", window.ResetsAt, wantReset)
	}
	if len(got.Balances) != 1 || got.Balances[0] != (MoneyBalance{Currency: "USD", Amount: "12.50"}) {
		t.Fatalf("balances = %#v", got.Balances)
	}

	lines := strings.Split(strings.TrimSpace(requests.String()), "\n")
	if len(lines) != 2 {
		t.Fatalf("ACP requests = %q", requests.String())
	}
	var initialize, billing map[string]any
	if err := json.Unmarshal([]byte(lines[0]), &initialize); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal([]byte(lines[1]), &billing); err != nil {
		t.Fatal(err)
	}
	if initialize["method"] != "initialize" {
		t.Fatalf("initialize method = %v", initialize["method"])
	}
	if billing["method"] != "_x.ai/billing" {
		t.Fatalf("billing method = %v, want _x.ai/billing", billing["method"])
	}
	if params, ok := billing["params"]; ok && params != nil {
		t.Fatalf("billing params must be omitted or null, got %#v", params)
	}
}

func TestSuperGrokLegacyBillingFallsBackToUsedAndLimit(t *testing.T) {
	proc, _ := superGrokProcess(
		`{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1}}`,
		`{"jsonrpc":"2.0","id":2,"result":{"config":{"monthlyLimit":{"val":2000},"used":{"val":500},"billingPeriodStart":"2026-08-01T00:00:00Z","billingPeriodEnd":"2026-09-01T00:00:00Z"}}}`,
	)
	provider := SuperGrokProvider{
		ResolveAuthSources: func() []string { return []string{"/tmp/grok/auth.json"} },
		RunRPC:             func(context.Context, string) (codexAppServerProcess, error) { return proc, nil },
	}
	got, err := provider.Fetch(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Windows) != 1 || got.Windows[0].Name != "1mo" || got.Windows[0].Pct != 25 {
		t.Fatalf("legacy window = %#v", got.Windows)
	}
}
