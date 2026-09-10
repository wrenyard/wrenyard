package quota

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"os/exec"
	"strings"
	"sync/atomic"
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

func TestChatGPTProviderName(t *testing.T) {
	p := ChatGPTProvider{}
	if got := p.Name(); got != "chatgpt" {
		t.Fatalf("Name() = %q, want chatgpt", got)
	}
}

func TestChatGPTProviderConvertWindow(t *testing.T) {
	w := convertRateLimitWindow(&RateLimitWindow{
		UsedPercent:    float64Ptr(42),
		WindowDuration: float64Ptr(300),
		ResetsAt:       float64Ptr(1781114455),
	}, "5h")
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

func TestChatGPTProviderConvertWindowNoResetsAt(t *testing.T) {
	w := convertRateLimitWindow(&RateLimitWindow{
		UsedPercent:    float64Ptr(50),
		WindowDuration: float64Ptr(300),
	}, "5h")
	if w == nil {
		t.Fatal("expected window")
	}
	if w.ResetsAt != nil {
		t.Fatal("expected nil ResetsAt")
	}
}

func TestChatGPTProviderConvertWindowNil(t *testing.T) {
	w := convertRateLimitWindow(nil, "5h")
	if w != nil {
		t.Fatal("expected nil window for nil input")
	}
}

func TestChatGPTProviderConvertWindowMissingUsedPercent(t *testing.T) {
	w := convertRateLimitWindow(&RateLimitWindow{
		WindowDuration: float64Ptr(300),
	}, "5h")
	if w != nil {
		t.Fatal("expected nil window when UsedPercent missing")
	}
}

func TestChatGPTProviderConvertWindowMissingDuration(t *testing.T) {
	w := convertRateLimitWindow(&RateLimitWindow{
		UsedPercent: float64Ptr(30),
	}, "5h")
	if w != nil {
		t.Fatal("expected nil window when WindowDuration missing (no fabricated default)")
	}
}

func TestChatGPTProviderConvertWindowEmptyWindowDuration(t *testing.T) {
	w := convertRateLimitWindow(&RateLimitWindow{
		UsedPercent:    float64Ptr(30),
		WindowDuration: float64Ptr(0),
	}, "7d")
	if w != nil {
		t.Fatal("expected nil window for zero WindowDuration")
	}
}

// --- Fetch tests with fake RPC ---

func newFakeRPC(t *testing.T, responses map[string]json.RawMessage) *fakeCodexRPC {
	return &fakeCodexRPC{t: t, responses: responses}
}

// chatGPTResponseOnce builds one account/rateLimits/read response containing
// the regular codex bucket plus an optional codex_bengalfox (Spark) bucket.
func chatGPTResponseOnce(codex, spark map[string]RateLimitsEntry, planType string) json.RawMessage {
	now := time.Now().Add(2 * time.Hour).Unix()
	byID := map[string]RateLimitsEntry{
		"codex": {
			Primary:   &RateLimitWindow{UsedPercent: float64Ptr(12), WindowDuration: float64Ptr(300), ResetsAt: float64Ptr(float64(now))},
			Secondary: &RateLimitWindow{UsedPercent: float64Ptr(96), WindowDuration: float64Ptr(10080), ResetsAt: float64Ptr(float64(now + 3600))},
			PlanType:  planType,
			LimitID:   "codex",
		},
	}
	for id, e := range codex {
		byID[id] = e
	}
	for id, e := range spark {
		byID[id] = e
	}
	resp := GetAccountRateLimitsResponse{RateLimitsByLimitID: byID}
	raw, _ := json.Marshal(resp)
	return raw
}

// chatGPTResponseBuckets marshals a response from explicit buckets, used by
// targeted classification tests.
func chatGPTResponseBuckets(buckets map[string]RateLimitsEntry) json.RawMessage {
	resp := GetAccountRateLimitsResponse{RateLimitsByLimitID: buckets}
	raw, _ := json.Marshal(resp)
	return raw
}

// TestChatGPTProviderFetchProWeeklyInPrimaryClassification covers the real
// local Pro RPC shape: the weekly window is delivered in the primary slot
// (windowDurationMins=10080) with no secondary. Classification must follow the
// actual duration, yielding 7d and marking 5h not applicable.
func TestChatGPTProviderFetchProWeeklyInPrimaryClassification(t *testing.T) {
	fake := newFakeRPC(t, map[string]json.RawMessage{
		"initialize": json.RawMessage(`{"capabilities":{}}`),
		"account/rateLimits/read": chatGPTResponseBuckets(map[string]RateLimitsEntry{
			"codex": {
				Primary:  &RateLimitWindow{UsedPercent: float64Ptr(36), WindowDuration: float64Ptr(10080)},
				PlanType: "pro",
				LimitID:  "codex",
			},
		}),
	})
	chatGPTRunRPC = fake.run
	t.Cleanup(func() { chatGPTRunRPC = nil })

	q, err := ChatGPTProvider{}.Fetch(context.Background())
	if err != nil {
		t.Fatalf("Fetch failed: %v", err)
	}
	if len(q.Windows) != 1 || q.Windows[0].Name != "7d" {
		t.Fatalf("windows = %#v, want only 7d", q.Windows)
	}
	if q.Windows[0].WindowMinutes != 10080 || q.Windows[0].Pct != 36 {
		t.Fatalf("window = %#v, want 10080min pct 36", q.Windows[0])
	}
	if len(q.NotApplicableWindows) != 1 || q.NotApplicableWindows[0] != "5h" {
		t.Fatalf("NotApplicableWindows = %#v, want [5h]", q.NotApplicableWindows)
	}
}

func TestChatGPTProviderFetchPlusWeeklyOnlyDoesNotProve5hAbsent(t *testing.T) {
	fake := newFakeRPC(t, map[string]json.RawMessage{
		"initialize": json.RawMessage(`{"capabilities":{}}`),
		"account/rateLimits/read": chatGPTResponseBuckets(map[string]RateLimitsEntry{
			"codex": {
				Primary:  &RateLimitWindow{UsedPercent: float64Ptr(36), WindowDuration: float64Ptr(10080)},
				PlanType: "plus",
				LimitID:  "codex",
			},
		}),
	})
	chatGPTRunRPC = fake.run
	t.Cleanup(func() { chatGPTRunRPC = nil })

	q, err := ChatGPTProvider{}.Fetch(context.Background())
	if err != nil {
		t.Fatalf("Fetch failed: %v", err)
	}
	if len(q.Windows) != 1 || q.Windows[0].Name != "7d" {
		t.Fatalf("windows = %#v, want only 7d", q.Windows)
	}
	if q.Windows[0].WindowMinutes != 10080 || q.Windows[0].Pct != 36 {
		t.Fatalf("window = %#v, want 10080min pct 36", q.Windows[0])
	}
	if len(q.NotApplicableWindows) != 0 {
		t.Fatalf("NotApplicableWindows = %#v, want no nonapplicability marker", q.NotApplicableWindows)
	}
}

// TestChatGPTProviderFetchSparkWeeklyOnlyKeepsSparkPool verifies that a Spark
// bucket delivering only a 10080 window is classified as spark-7d and marks
// spark-5h nonapplicable from Spark's own evidence (not the regular bucket).
func TestChatGPTProviderFetchSparkWeeklyOnlyKeepsSparkPool(t *testing.T) {
	fake := newFakeRPC(t, map[string]json.RawMessage{
		"initialize": json.RawMessage(`{"capabilities":{}}`),
		"account/rateLimits/read": chatGPTResponseBuckets(map[string]RateLimitsEntry{
			"codex": {
				Primary:   &RateLimitWindow{UsedPercent: float64Ptr(12), WindowDuration: float64Ptr(300)},
				Secondary: &RateLimitWindow{UsedPercent: float64Ptr(96), WindowDuration: float64Ptr(10080)},
				PlanType:  "pro",
				LimitID:   "codex",
			},
			"codex_bengalfox": {
				Primary:  &RateLimitWindow{UsedPercent: float64Ptr(44), WindowDuration: float64Ptr(10080)},
				PlanType: "pro",
				LimitID:  "codex_bengalfox",
			},
		}),
	})
	chatGPTRunRPC = fake.run
	t.Cleanup(func() { chatGPTRunRPC = nil })

	q, err := ChatGPTProvider{}.Fetch(context.Background())
	if err != nil {
		t.Fatalf("Fetch failed: %v", err)
	}
	wantNames := []string{"5h", "7d", "spark-7d"}
	if len(q.Windows) != len(wantNames) {
		t.Fatalf("windows = %#v, want %v", q.Windows, wantNames)
	}
	for i, name := range wantNames {
		if q.Windows[i].Name != name {
			t.Fatalf("window[%d].Name = %q, want %q", i, q.Windows[i].Name, name)
		}
	}
	// Spark has no 5h of its own, so spark-5h is nonapplicable; the regular
	// bucket is complete, so plain 5h is not.
	if len(q.NotApplicableWindows) != 1 || q.NotApplicableWindows[0] != "spark-5h" {
		t.Fatalf("NotApplicableWindows = %#v, want [spark-5h]", q.NotApplicableWindows)
	}
}

// TestChatGPTProviderFetchSparkIndependentAndMalformedNoFalseAbsence covers
// two properties at once: Spark keeping both of its pools (300 and 10080) and
// a malformed/unknown present window never producing a false absence marker.
func TestChatGPTProviderFetchSparkIndependentAndMalformedNoFalseAbsence(t *testing.T) {
	// Case A: both duration pools present on Spark => both spark pools kept,
	// no nonapplicable markers anywhere.
	fake := newFakeRPC(t, map[string]json.RawMessage{
		"initialize": json.RawMessage(`{"capabilities":{}}`),
		"account/rateLimits/read": chatGPTResponseBuckets(map[string]RateLimitsEntry{
			"codex": {
				Primary:   &RateLimitWindow{UsedPercent: float64Ptr(12), WindowDuration: float64Ptr(300)},
				Secondary: &RateLimitWindow{UsedPercent: float64Ptr(96), WindowDuration: float64Ptr(10080)},
				PlanType:  "pro",
				LimitID:   "codex",
			},
			"codex_bengalfox": {
				Primary:   &RateLimitWindow{UsedPercent: float64Ptr(66), WindowDuration: float64Ptr(300)},
				Secondary: &RateLimitWindow{UsedPercent: float64Ptr(10), WindowDuration: float64Ptr(10080)},
				PlanType:  "pro",
				LimitID:   "codex_bengalfox",
			},
		}),
	})
	chatGPTRunRPC = fake.run
	t.Cleanup(func() { chatGPTRunRPC = nil })

	q, err := ChatGPTProvider{}.Fetch(context.Background())
	if err != nil {
		t.Fatalf("Fetch failed: %v", err)
	}
	wantNames := []string{"5h", "7d", "spark-5h", "spark-7d"}
	if len(q.Windows) != len(wantNames) {
		t.Fatalf("windows = %#v, want %v", q.Windows, wantNames)
	}
	for i, name := range wantNames {
		if q.Windows[i].Name != name {
			t.Fatalf("window[%d].Name = %q, want %q", i, q.Windows[i].Name, name)
		}
	}
	if len(q.NotApplicableWindows) != 0 {
		t.Fatalf("NotApplicableWindows = %#v, want empty", q.NotApplicableWindows)
	}

	// Case B: a Pro bucket whose only present window has a valid usedPercent
	// but an unknown duration. The unknown duration must not become a known
	// pool, and must not be taken as evidence of absence — so no 5h marker.
	fakeB := newFakeRPC(t, map[string]json.RawMessage{
		"initialize": json.RawMessage(`{"capabilities":{}}`),
		"account/rateLimits/read": chatGPTResponseBuckets(map[string]RateLimitsEntry{
			"codex": {
				Primary:   &RateLimitWindow{UsedPercent: float64Ptr(36), WindowDuration: float64Ptr(1440)},
				Secondary: &RateLimitWindow{UsedPercent: float64Ptr(20), WindowDuration: float64Ptr(10080)},
				PlanType:  "pro",
				LimitID:   "codex",
			},
		}),
	})
	chatGPTRunRPC = fakeB.run
	t.Cleanup(func() { chatGPTRunRPC = nil })

	qB, err := ChatGPTProvider{}.Fetch(context.Background())
	if err != nil {
		t.Fatalf("Fetch failed: %v", err)
	}
	for _, w := range qB.Windows {
		if w.Name != "7d" {
			t.Fatalf("unknown duration must not map to a known pool, got %#v", qB.Windows)
		}
	}
	if len(qB.NotApplicableWindows) != 0 {
		t.Fatalf("unknown duration must not be absence evidence, got %#v", qB.NotApplicableWindows)
	}
}

func TestChatGPTProviderFetchBothBucketsOneRPC(t *testing.T) {
	now := time.Now().Add(2 * time.Hour).Unix()
	var calls int32
	fake := newFakeRPC(t, map[string]json.RawMessage{
		"initialize": json.RawMessage(`{"capabilities":{}}`),
		"account/rateLimits/read": func() json.RawMessage {
			atomic.AddInt32(&calls, 1)
			resp := GetAccountRateLimitsResponse{
				RateLimitsByLimitID: map[string]RateLimitsEntry{
					"codex": {
						Primary:   &RateLimitWindow{UsedPercent: float64Ptr(12), WindowDuration: float64Ptr(300), ResetsAt: float64Ptr(float64(now))},
						Secondary: &RateLimitWindow{UsedPercent: float64Ptr(96), WindowDuration: float64Ptr(10080), ResetsAt: float64Ptr(float64(now + 3600))},
						PlanType:  "prolite",
						LimitID:   "codex",
					},
					"codex_bengalfox": {
						Primary:   &RateLimitWindow{UsedPercent: float64Ptr(66), WindowDuration: float64Ptr(300)},
						Secondary: &RateLimitWindow{UsedPercent: float64Ptr(10), WindowDuration: float64Ptr(10080)},
						PlanType:  "pro",
						LimitID:   "codex_bengalfox",
					},
				},
			}
			raw, _ := json.Marshal(resp)
			return raw
		}(),
	})
	chatGPTRunRPC = fake.run
	t.Cleanup(func() { chatGPTRunRPC = nil })

	p := ChatGPTProvider{}
	q, err := p.Fetch(context.Background())
	if err != nil {
		t.Fatalf("Fetch failed: %v", err)
	}
	if got := atomic.LoadInt32(&calls); got != 1 {
		t.Fatalf("account/rateLimits/read calls = %d, want exactly 1", got)
	}
	if len(q.Windows) != 4 {
		t.Fatalf("expected 4 windows (5h,7d,spark-5h,spark-7d), got %d: %#v", len(q.Windows), q.Windows)
	}
	wantNames := []string{"5h", "7d", "spark-5h", "spark-7d"}
	for i, name := range wantNames {
		if q.Windows[i].Name != name {
			t.Fatalf("window[%d].Name = %q, want %q", i, q.Windows[i].Name, name)
		}
	}
	if q.Provider != "chatgpt" {
		t.Fatalf("Provider = %q, want chatgpt", q.Provider)
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
	if len(q.NotApplicableWindows) != 0 {
		t.Fatalf("NotApplicableWindows = %#v, want empty for present windows", q.NotApplicableWindows)
	}
}

func TestChatGPTProviderFetchSparkMissingDoesNotFailNormalLimits(t *testing.T) {
	// Only the regular codex bucket is present; the fetch must succeed with
	// the normal 5h/7d windows and no Spark windows.
	fake := newFakeRPC(t, map[string]json.RawMessage{
		"initialize":              json.RawMessage(`{"capabilities":{}}`),
		"account/rateLimits/read": chatGPTResponseOnce(nil, nil, "prolite"),
	})
	chatGPTRunRPC = fake.run
	t.Cleanup(func() { chatGPTRunRPC = nil })

	q, err := ChatGPTProvider{}.Fetch(context.Background())
	if err != nil {
		t.Fatalf("Fetch failed: %v", err)
	}
	if len(q.Windows) != 2 {
		t.Fatalf("expected 2 regular windows, got %d: %#v", len(q.Windows), q.Windows)
	}
	if q.Windows[0].Name != "5h" || q.Windows[1].Name != "7d" {
		t.Fatalf("window names = %q,%q, want 5h,7d", q.Windows[0].Name, q.Windows[1].Name)
	}
	if len(q.NotApplicableWindows) != 0 {
		t.Fatalf("NotApplicableWindows = %#v, want empty", q.NotApplicableWindows)
	}
}

// TestChatGPTProviderFetchProPrimaryNull7dMarks5hNotApplicable covers a Pro
// bucket with a valid 7d window in the secondary slot, no 5h, and no malformed
// present window: 5h is nonapplicable.
func TestChatGPTProviderFetchProPrimaryNull7dMarks5hNotApplicable(t *testing.T) {
	fake := newFakeRPC(t, map[string]json.RawMessage{
		"initialize": json.RawMessage(`{"capabilities":{}}`),
		"account/rateLimits/read": chatGPTResponseBuckets(map[string]RateLimitsEntry{
			"codex": {
				// Primary explicitly null (absent), Pro plan.
				Primary:   nil,
				Secondary: &RateLimitWindow{UsedPercent: float64Ptr(96), WindowDuration: float64Ptr(10080)},
				PlanType:  "pro",
				LimitID:   "codex",
			},
		}),
	})
	chatGPTRunRPC = fake.run
	t.Cleanup(func() { chatGPTRunRPC = nil })

	q, err := ChatGPTProvider{}.Fetch(context.Background())
	if err != nil {
		t.Fatalf("Fetch failed: %v", err)
	}
	if len(q.Windows) != 1 || q.Windows[0].Name != "7d" {
		t.Fatalf("windows = %#v, want only 7d", q.Windows)
	}
	if len(q.NotApplicableWindows) != 1 || q.NotApplicableWindows[0] != "5h" {
		t.Fatalf("NotApplicableWindows = %#v, want [5h]", q.NotApplicableWindows)
	}
}

// TestChatGPTProviderFetchMalformedWindowNotEmptyAbsence guards the boundary
// between "no windows" and "malformed window": an all-malformed response is a
// failure, never an absence marker.
func TestChatGPTProviderFetchMalformedWindowNotEmptyAbsence(t *testing.T) {
	fake := newFakeRPC(t, map[string]json.RawMessage{
		"initialize": json.RawMessage(`{"capabilities":{}}`),
		"account/rateLimits/read": chatGPTResponseBuckets(map[string]RateLimitsEntry{
			"codex": {
				Primary:  &RateLimitWindow{UsedPercent: nil},
				PlanType: "pro",
			},
		}),
	})
	chatGPTRunRPC = fake.run
	t.Cleanup(func() { chatGPTRunRPC = nil })

	_, err := ChatGPTProvider{}.Fetch(context.Background())
	if err == nil || !strings.Contains(err.Error(), "no rate limit windows") {
		t.Fatalf("expected 'no rate limit windows' error, got %v", err)
	}
}

func TestChatGPTProviderFetchRegularBucketMissing(t *testing.T) {
	fake := newFakeRPC(t, map[string]json.RawMessage{
		"initialize": json.RawMessage(`{"capabilities":{}}`),
		"account/rateLimits/read": func() json.RawMessage {
			resp := GetAccountRateLimitsResponse{
				RateLimitsByLimitID: map[string]RateLimitsEntry{"other_bucket": {}},
			}
			raw, _ := json.Marshal(resp)
			return raw
		}(),
	})
	chatGPTRunRPC = fake.run
	t.Cleanup(func() { chatGPTRunRPC = nil })

	_, err := ChatGPTProvider{}.Fetch(context.Background())
	if err == nil || !strings.Contains(err.Error(), "bucket") || !strings.Contains(err.Error(), "not found") {
		t.Fatalf("expected 'bucket not found' error, got %v", err)
	}
}

func TestChatGPTProviderFetchMissingRateLimitsByLimitId(t *testing.T) {
	fake := newFakeRPC(t, map[string]json.RawMessage{
		"initialize":              json.RawMessage(`{"capabilities":{}}`),
		"account/rateLimits/read": json.RawMessage(`{}`),
	})
	chatGPTRunRPC = fake.run
	t.Cleanup(func() { chatGPTRunRPC = nil })

	_, err := ChatGPTProvider{}.Fetch(context.Background())
	if err == nil || !strings.Contains(err.Error(), "rateLimitsByLimitId is empty") {
		t.Fatalf("expected 'rateLimitsByLimitId is empty' error, got %v", err)
	}
}

func TestChatGPTProviderFetchRPCCallError(t *testing.T) {
	fake := &fakeCodexRPC{
		t: t,
		errors: map[string]string{
			"account/rateLimits/read": "unauthorized",
		},
		responses: map[string]json.RawMessage{
			"initialize": json.RawMessage(`{"capabilities":{}}`),
		},
	}
	chatGPTRunRPC = fake.run
	t.Cleanup(func() { chatGPTRunRPC = nil })

	_, err := ChatGPTProvider{}.Fetch(context.Background())
	if err == nil || !strings.Contains(err.Error(), "JSON-RPC error") || !strings.Contains(err.Error(), "unauthorized") {
		t.Fatalf("expected JSON-RPC error with 'unauthorized', got %v", err)
	}
}

func TestChatGPTProviderFetchInitializeError(t *testing.T) {
	fake := &fakeCodexRPC{
		t: t,
		errors: map[string]string{
			"initialize": "server error",
		},
	}
	chatGPTRunRPC = fake.run
	t.Cleanup(func() { chatGPTRunRPC = nil })

	_, err := ChatGPTProvider{}.Fetch(context.Background())
	if err == nil || !strings.Contains(err.Error(), "initialize") {
		t.Fatalf("expected initialize error, got %v", err)
	}
}

func TestChatGPTProviderFetchContextCancelled(t *testing.T) {
	fake := newFakeRPC(t, map[string]json.RawMessage{
		"initialize":              json.RawMessage(`{"capabilities":{}}`),
		"account/rateLimits/read": chatGPTResponseOnce(nil, nil, "pro"),
	})
	chatGPTRunRPC = fake.run
	t.Cleanup(func() { chatGPTRunRPC = nil })

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := ChatGPTProvider{}.Fetch(ctx)
	if err == nil {
		t.Fatal("expected error from cancelled context")
	}
}

func TestChatGPTProviderFetchNotificationSkipped(t *testing.T) {
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
		notifications: map[string]json.RawMessage{
			"account/rateLimits/read": json.RawMessage(`{"progress":50}`),
		},
	}
	chatGPTRunRPC = fake.run
	t.Cleanup(func() { chatGPTRunRPC = nil })

	q, err := ChatGPTProvider{}.Fetch(context.Background())
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

func TestChatGPTProviderFetchMissingExecutable(t *testing.T) {
	chatGPTRunRPC = func(ctx context.Context, args []string) (codexAppServerProcess, error) {
		return codexAppServerProcess{}, exec.ErrNotFound
	}
	t.Cleanup(func() { chatGPTRunRPC = nil })

	_, err := ChatGPTProvider{}.Fetch(context.Background())
	if err == nil || !strings.Contains(err.Error(), "codex executable not found") {
		t.Fatalf("expected 'codex executable not found' error, got %v", err)
	}
}

func TestChatGPTProviderFetchEOF(t *testing.T) {
	fake := newFakeRPC(t, map[string]json.RawMessage{
		"initialize": json.RawMessage(`{"capabilities":{}}`),
		// No account/rateLimits/read response — connection will close.
	})
	chatGPTRunRPC = fake.run
	t.Cleanup(func() { chatGPTRunRPC = nil })

	_, err := ChatGPTProvider{}.Fetch(context.Background())
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
