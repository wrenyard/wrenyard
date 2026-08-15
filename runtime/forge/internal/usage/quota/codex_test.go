package quota

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"os/exec"
	"strings"
	"testing"
	"time"
)

// fakeCodexRPC is an in-memory pipe-based fake that replaces the
// codex app-server subprocess. It responds to initialize, initialized
// (noop), and account/rateLimits/read using newline-delimited JSON.
type fakeCodexRPC struct {
	t             *testing.T
	responses     map[string]json.RawMessage
	errors        map[string]string
	notifications map[string]json.RawMessage // method -> notification body to send before response
}

func (f *fakeCodexRPC) run(ctx context.Context, args []string) (codexAppServerProcess, error) {
	// clientWrite -> serverRead (client writes, server reads)
	// serverWrite -> clientRead (server writes, client reads)
	serverRead, clientWrite := io.Pipe()
	clientRead, serverWrite := io.Pipe()

	go func() {
		defer serverRead.Close()
		defer serverWrite.Close()

		scanner := bufio.NewScanner(serverRead)
		scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
		for scanner.Scan() {
			line := strings.TrimSpace(scanner.Text())
			if line == "" {
				continue
			}

			var req struct {
				ID     *int            `json:"id,omitempty"`
				Method string          `json:"method,omitempty"`
				Params json.RawMessage `json:"params,omitempty"`
			}
			if err := json.Unmarshal([]byte(line), &req); err != nil {
				continue
			}

			// Validate expected request shapes.

			// initialize must have clientInfo name/title/version.
			if req.Method == "initialize" && f.t != nil {
				var ip struct {
					ClientInfo struct {
						Name    string `json:"name"`
						Title   string `json:"title"`
						Version string `json:"version"`
					} `json:"clientInfo"`
				}
				if err := json.Unmarshal(req.Params, &ip); err != nil {
					f.t.Errorf("initialize params unmarshal: %v", err)
				} else if ip.ClientInfo.Name != "forge" || ip.ClientInfo.Title != "Forge" || ip.ClientInfo.Version != "0.0.0" {
					f.t.Errorf("initialize clientInfo = %+v, want {forge Forge 0.0.0}", ip.ClientInfo)
				}

				// Check that jsonrpc field is NOT present in the request.
				var rawMap map[string]json.RawMessage
				if err := json.Unmarshal([]byte(line), &rawMap); err == nil {
					if _, has := rawMap["jsonrpc"]; has {
						f.t.Error("initialize request must NOT include jsonrpc field")
					}
				}
			}

			// initialized must have no params field (omitted entirely).
			if req.Method == "initialized" && f.t != nil {
				var rawMap map[string]json.RawMessage
				if err := json.Unmarshal([]byte(line), &rawMap); err == nil {
					if _, has := rawMap["params"]; has {
						f.t.Error("initialized notification must NOT include params field")
					}
				}
			}

			// Notifications (no ID) must not receive a response.
			if req.ID == nil {
				continue
			}

			// account/rateLimits/read must have params: null.
			if req.Method == "account/rateLimits/read" && f.t != nil {
				if string(req.Params) != "null" {
					f.t.Errorf("account/rateLimits/read params = %s, want null", string(req.Params))
				}
			}

			// Send pre-response notification if configured.
			if notifBody, ok := f.notifications[req.Method]; ok {
				notif := struct {
					ID     *int            `json:"id,omitempty"`
					Method string          `json:"method,omitempty"`
					Params json.RawMessage `json:"params,omitempty"`
				}{
					Method: "$/progress",
					Params: notifBody,
				}
				nb, _ := json.Marshal(notif)
				nb = append(nb, '\n')
				serverWrite.Write(nb)
			}

			// Check for expected error.
			var respID *int
			if req.ID != nil {
				respID = &[]int{*req.ID}[0]
			}

			if errMsg, ok := f.errors[req.Method]; ok {
				resp := jsonrpcMessage{
					ID:    respID,
					Error: &jsonrpcError{Code: -32000, Message: errMsg},
				}
				b, _ := json.Marshal(resp)
				b = append(b, '\n')
				serverWrite.Write(b)
				continue
			}

			// Check for expected response.
			if respBody, ok := f.responses[req.Method]; ok {
				resp := jsonrpcMessage{
					ID:     respID,
					Result: respBody,
				}
				b, _ := json.Marshal(resp)
				b = append(b, '\n')
				serverWrite.Write(b)
				continue
			}

			// Unknown method — return method not found.
			resp := jsonrpcMessage{
				ID:    respID,
				Error: &jsonrpcError{Code: -32601, Message: "Method not found: " + req.Method},
			}
			b, _ := json.Marshal(resp)
			b = append(b, '\n')
			serverWrite.Write(b)
		}
	}()

	// Return a nil cmd (no real process) and the pipe ends.
	return codexAppServerProcess{stdout: clientRead, stdin: clientWrite, stderrBuf: nil}, nil
}

// --- Provider tests ---

func TestCodexProviderBucketMapping(t *testing.T) {
	tests := []struct {
		provider string
		want     string
	}{
		{"codex", "codex"},
		{"codex-spark", "codex_bengalfox"},
		{"Codex-Spark", "codex_bengalfox"},
		{"CODEX_SPARK", "codex_bengalfox"},
		{"", "codex"},
	}
	for _, tc := range tests {
		p := CodexProvider{ProviderName: tc.provider}
		got := bucketForProvider(p.Name())
		if got != tc.want {
			t.Errorf("bucketForProvider(%q) = %q, want %q", tc.provider, got, tc.want)
		}
	}
}

func TestCodexProviderName(t *testing.T) {
	tests := []struct {
		name     string
		expected string
	}{
		{"codex", "codex"},
		{"codex-spark", "codex-spark"},
		{"", "codex"},
	}
	for _, tc := range tests {
		p := CodexProvider{ProviderName: tc.name}
		if got := p.Name(); got != tc.expected {
			t.Errorf("Name() = %q, want %q", got, tc.expected)
		}
	}
}

func TestCodexProviderConvertWindow(t *testing.T) {
	w := convertRateLimitWindow(&RateLimitWindow{
		UsedPercent:    float64Ptr(42),
		WindowDuration: float64Ptr(300),
		ResetsAt:       float64Ptr(1781114455),
	})
	if w == nil {
		t.Fatal("expected window, got nil")
	}
	if w.Pct != 42 {
		t.Fatalf("Pct = %f, want 42", w.Pct)
	}
	if w.WindowMinutes != 300 {
		t.Fatalf("WindowMinutes = %d, want 300", w.WindowMinutes)
	}
	if w.Name != "5h" {
		t.Fatalf("Name = %q, want 5h", w.Name)
	}
	if w.ResetsAt == nil || w.ResetsAt.Unix() != 1781114455 {
		t.Fatalf("ResetsAt = %v, want unix 1781114455", w.ResetsAt)
	}
}

func TestCodexProviderConvertWindowNoResetsAt(t *testing.T) {
	w := convertRateLimitWindow(&RateLimitWindow{
		UsedPercent:    float64Ptr(50),
		WindowDuration: float64Ptr(300),
	})
	if w == nil {
		t.Fatal("expected window")
	}
	if w.ResetsAt != nil {
		t.Fatal("expected nil ResetsAt")
	}
}

func TestCodexProviderConvertWindowNil(t *testing.T) {
	w := convertRateLimitWindow(nil)
	if w != nil {
		t.Fatal("expected nil window for nil input")
	}
}

func TestCodexProviderConvertWindowMissingUsedPercent(t *testing.T) {
	w := convertRateLimitWindow(&RateLimitWindow{
		WindowDuration: float64Ptr(300),
	})
	if w != nil {
		t.Fatal("expected nil window when UsedPercent missing")
	}
}

func TestCodexProviderConvertWindowDefaultWindowMinutes(t *testing.T) {
	w := convertRateLimitWindow(&RateLimitWindow{
		UsedPercent: float64Ptr(30),
	})
	if w == nil {
		t.Fatal("expected window")
	}
	if w.WindowMinutes != 300 {
		t.Fatalf("WindowMinutes = %d, want default 300", w.WindowMinutes)
	}
	if w.Name != "5h" {
		t.Fatalf("Name = %q, want 5h", w.Name)
	}
}

func TestCodexProviderConvertWindowEmptyWindowDuration(t *testing.T) {
	w := convertRateLimitWindow(&RateLimitWindow{
		UsedPercent:    float64Ptr(30),
		WindowDuration: float64Ptr(0),
	})
	if w == nil {
		t.Fatal("expected window")
	}
	if w.WindowMinutes != 300 {
		t.Fatalf("WindowMinutes = %d, want default 300", w.WindowMinutes)
	}
}

// --- Fetch tests with fake RPC ---

func codexResponseFor(provider string, primaryPct, secondaryPct float64, planID string) json.RawMessage {
	now := time.Now().Add(2 * time.Hour).Unix()
	resp := GetAccountRateLimitsResponse{
		RateLimitsByLimitID: map[string]RateLimitsEntry{
			bucketForProvider(provider): {
				Primary:   &RateLimitWindow{UsedPercent: &primaryPct, WindowDuration: float64Ptr(300), ResetsAt: float64Ptr(float64(now))},
				Secondary: &RateLimitWindow{UsedPercent: &secondaryPct, WindowDuration: float64Ptr(10080), ResetsAt: float64Ptr(float64(now + 3600))},
				PlanType:  planID,
				LimitID:   bucketForProvider(provider),
			},
		},
	}
	raw, _ := json.Marshal(resp)
	return raw
}

func TestCodexProviderFetchCodex(t *testing.T) {
	fake := &fakeCodexRPC{
		t: t,
		responses: map[string]json.RawMessage{
			"initialize":              json.RawMessage(`{"capabilities":{}}`),
			"account/rateLimits/read": codexResponseFor("codex", 12, 96, "prolite"),
		},
	}
	p := CodexProvider{ProviderName: "codex", RunRPC: fake.run}
	q, err := p.Fetch(context.Background())
	if err != nil {
		t.Fatalf("Fetch failed: %v", err)
	}
	if len(q.Windows) != 2 {
		t.Fatalf("expected 2 windows, got %d", len(q.Windows))
	}
	if q.Windows[0].Pct != 12 {
		t.Fatalf("primary Pct = %f, want 12", q.Windows[0].Pct)
	}
	if q.Windows[1].Pct != 96 {
		t.Fatalf("secondary Pct = %f, want 96", q.Windows[1].Pct)
	}
	if q.Provider != "codex" {
		t.Fatalf("Provider = %q, want codex", q.Provider)
	}
	if q.Source != "codex-app-server" {
		t.Fatalf("Source = %q, want codex-app-server", q.Source)
	}
	if q.FetchedAt.IsZero() {
		t.Fatal("FetchedAt should be set")
	}
	if !strings.Contains(q.Message, "prolite") {
		t.Fatalf("Message = %q, want prolite", q.Message)
	}
}

func TestCodexProviderFetchCodexSpark(t *testing.T) {
	fake := &fakeCodexRPC{
		t: t,
		responses: map[string]json.RawMessage{
			"initialize":              json.RawMessage(`{"capabilities":{}}`),
			"account/rateLimits/read": codexResponseFor("codex-spark", 66, 0, "pro"),
		},
	}
	p := CodexProvider{ProviderName: "codex-spark", RunRPC: fake.run}
	q, err := p.Fetch(context.Background())
	if err != nil {
		t.Fatalf("Fetch failed: %v", err)
	}
	if len(q.Windows) != 2 {
		t.Fatalf("expected 2 windows, got %d", len(q.Windows))
	}
	if q.Windows[0].Pct != 66 {
		t.Fatalf("primary Pct = %f, want 66", q.Windows[0].Pct)
	}
	if q.Provider != "codex-spark" {
		t.Fatalf("Provider = %q, want codex-spark", q.Provider)
	}
	if q.Source != "codex-app-server" {
		t.Fatalf("Source = %q, want codex-app-server", q.Source)
	}
}

func TestCodexProviderFetchMissingRateLimitsByLimitId(t *testing.T) {
	fake := &fakeCodexRPC{
		t: t,
		responses: map[string]json.RawMessage{
			"initialize":              json.RawMessage(`{"capabilities":{}}`),
			"account/rateLimits/read": json.RawMessage(`{}`),
		},
	}
	p := CodexProvider{ProviderName: "codex", RunRPC: fake.run}
	_, err := p.Fetch(context.Background())
	if err == nil || !strings.Contains(err.Error(), "rateLimitsByLimitId is empty") {
		t.Fatalf("expected 'rateLimitsByLimitId is empty' error, got %v", err)
	}
}

func TestCodexProviderFetchMissingBucket(t *testing.T) {
	fake := &fakeCodexRPC{
		t: t,
		responses: map[string]json.RawMessage{
			"initialize": json.RawMessage(`{"capabilities":{}}`),
			"account/rateLimits/read": func() json.RawMessage {
				resp := GetAccountRateLimitsResponse{
					RateLimitsByLimitID: map[string]RateLimitsEntry{
						"other_bucket": {},
					},
				}
				raw, _ := json.Marshal(resp)
				return raw
			}(),
		},
	}
	p := CodexProvider{ProviderName: "codex", RunRPC: fake.run}
	_, err := p.Fetch(context.Background())
	if err == nil || !strings.Contains(err.Error(), "bucket") || !strings.Contains(err.Error(), "not found") {
		t.Fatalf("expected 'bucket not found' error, got %v", err)
	}
}

func TestCodexProviderFetchMalformedWindows(t *testing.T) {
	fake := &fakeCodexRPC{
		t: t,
		responses: map[string]json.RawMessage{
			"initialize": json.RawMessage(`{"capabilities":{}}`),
			"account/rateLimits/read": func() json.RawMessage {
				resp := GetAccountRateLimitsResponse{
					RateLimitsByLimitID: map[string]RateLimitsEntry{
						"codex": {
							Primary: &RateLimitWindow{UsedPercent: nil}, // missing usedPercent -> nil window
						},
					},
				}
				raw, _ := json.Marshal(resp)
				return raw
			}(),
		},
	}
	p := CodexProvider{ProviderName: "codex", RunRPC: fake.run}
	_, err := p.Fetch(context.Background())
	if err == nil || !strings.Contains(err.Error(), "no rate limit windows") {
		t.Fatalf("expected 'no rate limit windows' error, got %v", err)
	}
}

func TestCodexProviderFetchRPCCallError(t *testing.T) {
	fake := &fakeCodexRPC{
		t: t,
		errors: map[string]string{
			"account/rateLimits/read": "unauthorized",
		},
		responses: map[string]json.RawMessage{
			"initialize": json.RawMessage(`{"capabilities":{}}`),
		},
	}
	p := CodexProvider{ProviderName: "codex", RunRPC: fake.run}
	_, err := p.Fetch(context.Background())
	if err == nil || !strings.Contains(err.Error(), "JSON-RPC error") || !strings.Contains(err.Error(), "unauthorized") {
		t.Fatalf("expected JSON-RPC error with 'unauthorized', got %v", err)
	}
}

func TestCodexProviderFetchInitializeError(t *testing.T) {
	fake := &fakeCodexRPC{
		t: t,
		errors: map[string]string{
			"initialize": "server error",
		},
	}
	p := CodexProvider{ProviderName: "codex", RunRPC: fake.run}
	_, err := p.Fetch(context.Background())
	if err == nil || !strings.Contains(err.Error(), "initialize") {
		t.Fatalf("expected initialize error, got %v", err)
	}
}

func TestCodexProviderFetchContextCancelled(t *testing.T) {
	fake := &fakeCodexRPC{
		t: t,
		responses: map[string]json.RawMessage{
			"initialize":              json.RawMessage(`{"capabilities":{}}`),
			"account/rateLimits/read": codexResponseFor("codex", 10, 20, "pro"),
		},
	}
	p := CodexProvider{ProviderName: "codex", RunRPC: fake.run}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := p.Fetch(ctx)
	if err == nil {
		t.Fatal("expected error from cancelled context")
	}
}

func TestCodexProviderFetchNotificationSkipped(t *testing.T) {
	fake := &fakeCodexRPC{
		t: t,
		responses: map[string]json.RawMessage{
			"initialize": json.RawMessage(`{"capabilities":{}}`),
			"account/rateLimits/read": func() json.RawMessage {
				resp := GetAccountRateLimitsResponse{
					RateLimitsByLimitID: map[string]RateLimitsEntry{
						"codex": {
							Primary:   &RateLimitWindow{UsedPercent: float64Ptr(50), WindowDuration: float64Ptr(300)},
							Secondary: &RateLimitWindow{UsedPercent: float64Ptr(75), WindowDuration: float64Ptr(10080)},
							PlanType:  "pro",
							LimitID:   "codex",
						},
					},
				}
				raw, _ := json.Marshal(resp)
				return raw
			}(),
		},
		// Inject a $/progress notification before the account/rateLimits/read response.
		notifications: map[string]json.RawMessage{
			"account/rateLimits/read": json.RawMessage(`{"progress":50}`),
		},
	}
	p := CodexProvider{ProviderName: "codex", RunRPC: fake.run}
	q, err := p.Fetch(context.Background())
	if err != nil {
		t.Fatalf("Fetch failed: %v", err)
	}
	if len(q.Windows) != 2 {
		t.Fatalf("expected 2 windows, got %d", len(q.Windows))
	}
	if q.Windows[0].Pct != 50 {
		t.Fatalf("primary Pct = %f, want 50", q.Windows[0].Pct)
	}
}

func TestCodexProviderFetchMissingExecutable(t *testing.T) {
	p := CodexProvider{
		ProviderName: "codex",
		RunRPC: func(ctx context.Context, args []string) (codexAppServerProcess, error) {
			return codexAppServerProcess{}, exec.ErrNotFound
		},
	}
	_, err := p.Fetch(context.Background())
	if err == nil || !strings.Contains(err.Error(), "codex executable not found") {
		t.Fatalf("expected 'codex executable not found' error, got %v", err)
	}
}

func TestCodexProviderFetchEOF(t *testing.T) {
	fake := &fakeCodexRPC{
		t: t,
		responses: map[string]json.RawMessage{
			"initialize": json.RawMessage(`{"capabilities":{}}`),
		},
		// No account/rateLimits/read response — connection will close.
	}
	p := CodexProvider{ProviderName: "codex", RunRPC: fake.run}
	_, err := p.Fetch(context.Background())
	if err == nil {
		t.Fatal("expected error from EOF after initialize")
	}
}

// --- limitWriter tests ---

func TestLimitWriterBoundedCapacity(t *testing.T) {
	var buf bytes.Buffer
	lw := &limitWriter{w: &buf, limit: 10}

	// Write 5 bytes: fits within capacity, returns 5, stores 5.
	n, err := lw.Write([]byte("hello"))
	if err != nil {
		t.Fatalf("first write: unexpected error: %v", err)
	}
	if n != 5 {
		t.Fatalf("first write: n = %d, want 5", n)
	}
	if buf.String() != "hello" {
		t.Fatalf("first write: buf = %q, want hello", buf.String())
	}

	// Write 10 bytes: only 5 remaining capacity, stores 5, reports 10.
	n, err = lw.Write([]byte("ABCDEFGHIJ"))
	if err != nil {
		t.Fatalf("second write: unexpected error: %v", err)
	}
	if n != 10 {
		t.Fatalf("second write: n = %d, want 10 (original length)", n)
	}
	if buf.String() != "helloABCDE" {
		t.Fatalf("second write: buf = %q, want helloABCDE", buf.String())
	}

	// Write 3 more bytes: capacity exhausted, reports 3, stores nothing.
	n, err = lw.Write([]byte("XYZ"))
	if err != nil {
		t.Fatalf("third write: unexpected error: %v", err)
	}
	if n != 3 {
		t.Fatalf("third write: n = %d, want 3", n)
	}
	if buf.String() != "helloABCDE" {
		t.Fatalf("third write: buf should be unchanged = %q", buf.String())
	}
}

// --- Helper ---

func float64Ptr(v float64) *float64 { return &v }
