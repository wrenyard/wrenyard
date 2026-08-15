package execution

import (
	"testing"
	"time"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/protocol"
)

func TestClassifyNormalizedOutputUsesOnlyDownstreamEvents(t *testing.T) {
	now := time.Date(2026, 7, 12, 6, 30, 0, 0, time.UTC)
	got := ClassifyAttempt([]protocol.Event{
		{Type: "message", Data: map[string]any{"text": "normal response"}},
		{Type: "run_finished", Data: map[string]any{
			"status": "failed",
			"error":  "context window exceeded",
		}},
	}, now)
	if got.Classification != FailureClassNonRetryable {
		t.Fatalf("classification=%q want non_retryable", got.Classification)
	}

	// Prompt/stdin are deliberately not parameters to ClassifyAttempt. A
	// prompt containing provider-looking text therefore cannot affect it.
	got = ClassifyAttempt([]protocol.Event{
		{Type: "run_finished", Data: map[string]any{"status": "failed", "error": "ordinary failure"}},
	}, now)
	if got.Classification != FailureClassNonRetryable {
		t.Fatalf("classification=%q want non_retryable", got.Classification)
	}
}

func TestClassifyNormalizedOutputPriorityAndDone(t *testing.T) {
	now := time.Date(2026, 7, 12, 6, 30, 0, 0, time.UTC)
	tests := []struct {
		name   string
		events []protocol.Event
		want   FailureClass
	}{
		{
			name:   "done",
			events: []protocol.Event{{Type: "run_finished", Data: map[string]any{"status": "done", "error": "429 rate limit"}}},
			want:   FailureClassNone,
		},
		{
			name:   "explicit profile class",
			events: []protocol.Event{{Type: "run_finished", Data: map[string]any{"status": "failed", "failure_class": "profile_specific_limit", "error": "503"}}},
			want:   FailureClassProfileSpecificLimit,
		},
		{
			name:   "profile before transient",
			events: []protocol.Event{{Type: "run_finished", Data: map[string]any{"status": "failed", "error": "profile quota limit after 429"}}},
			want:   FailureClassProfileSpecificLimit,
		},
		{
			name:   "transient message",
			events: []protocol.Event{{Type: "message", Data: map[string]any{"text": "provider returned 503"}}},
			want:   FailureClassTransientProvider,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := ClassifyAttempt(tt.events, now)
			if got.Classification != tt.want {
				t.Fatalf("classification=%q want %q", got.Classification, tt.want)
			}
		})
	}
}

func TestClassifyReliableRecoveryAllowlist(t *testing.T) {
	now := time.Date(2026, 7, 12, 6, 30, 0, 0, time.UTC)
	got := ClassifyAttempt([]protocol.Event{{Type: "run_finished", Data: map[string]any{
		"status":              "failed",
		"failure_class":       "transient_provider",
		"recovery_at":         "2026-07-12T07:00:00+00:00",
		"retry_after_seconds": 1,
		"error":               map[string]any{"recovery_at": "2026-07-12T08:00:00Z"},
	}}}, now)
	if got.RecoveryAt == nil || !got.RecoveryAt.Equal(time.Date(2026, 7, 12, 7, 0, 0, 0, time.UTC)) {
		t.Fatalf("recovery_at=%v want top-level valid UTC timestamp", got.RecoveryAt)
	}
	if got.RecoveryAt.Equal(now.Add(time.Second)) {
		t.Fatalf("recovery_at incorrectly used retry_after_seconds: %v", got.RecoveryAt)
	}

	// +08:00 offset must be accepted and converted to the equivalent UTC instant.
	got2 := ClassifyAttempt([]protocol.Event{{Type: "run_finished", Data: map[string]any{
		"status":        "failed",
		"failure_class": "transient_provider",
		"recovery_at":   "2026-07-12T15:00:00+08:00",
	}}}, now)
	if got2.RecoveryAt == nil || !got2.RecoveryAt.Equal(time.Date(2026, 7, 12, 7, 0, 0, 0, time.UTC)) {
		t.Fatalf("recovery_at=%v want UTC instant 2026-07-12T07:00:00Z for +08:00 input", got2.RecoveryAt)
	}

	for _, tc := range []struct {
		name string
		data map[string]any
	}{
		{name: "natural language", data: map[string]any{"error": "try again in 30 minutes"}},
		{name: "missing timezone", data: map[string]any{"recovery_at": "2026-07-12T07:00:00"}},
		{name: "past", data: map[string]any{"recovery_at": "2026-07-12T06:29:59Z"}},
		{name: "too far", data: map[string]any{"retry_after_seconds": 604801}},
		{name: "wrong type", data: map[string]any{"retry_after_seconds": "30"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			data := map[string]any{"status": "failed", "failure_class": "transient_provider"}
			for key, value := range tc.data {
				data[key] = value
			}
			got := ClassifyAttempt([]protocol.Event{{Type: "run_finished", Data: data}}, now)
			if got.RecoveryAt != nil {
				t.Fatalf("recovery_at=%v want nil", got.RecoveryAt)
			}
		})
	}
}

func TestClassifyVerifiedCodeBuddyResetMessage(t *testing.T) {
	now := time.Date(2026, 7, 12, 3, 33, 0, 0, time.UTC)
	message := "429 您的使用量已超出频率限制，将在 2026-07-12 11:49:02 UTC+8 重置，您也可以切换其他模型继续使用。 (eae0465ed7664c40bcb0bb7f08afb8ca/1d37242c-c2ea-4c31-812a-2b2cd1e13a92)"
	got := ClassifyAttempt([]protocol.Event{{Type: "message", Data: map[string]any{"role": "assistant", "text": message}}}, now)
	if got.Classification != ClassificationProfileSpecificLimit || got.RecoveryAt == nil || !got.RecoveryAt.Equal(time.Date(2026, 7, 12, 3, 49, 2, 0, time.UTC)) {
		t.Fatalf("classification=%+v want immediate CodeBuddy profile circuit", got)
	}

	lookalike := ClassifyAttempt([]protocol.Event{{Type: "message", Data: map[string]any{"text": "prefix " + message}}}, now)
	if lookalike.RecoveryAt != nil {
		t.Fatalf("lookalike recovery_at=%v want nil", lookalike.RecoveryAt)
	}
}

func TestClassifyHardBillingCycleDenialMarksImmediateCircuit(t *testing.T) {
	now := time.Date(2026, 7, 12, 6, 30, 0, 0, time.UTC)

	// The exact Kimi billing-cycle 403 is a hard permission/quota denial:
	// profile_specific_limit plus immediate-circuit flag.
	hard := []protocol.Event{{Type: "run_finished", Data: map[string]any{
		"status": "failed",
		"error":  "Error code: 403 - insufficient_quota: You've reached your usage limit for this billing cycle. Please try again later or upgrade your plan.",
	}}}
	got := ClassifyAttempt(hard, now)
	if got.Classification != FailureClassProfileSpecificLimit || !got.ImmediateCircuit {
		t.Fatalf("classification=%+v want profile_specific_limit with immediate circuit", got)
	}

	terminated := []protocol.Event{{Type: "run_finished", Data: map[string]any{
		"status": "failed",
		"error":  "Error code: 403 - access terminated: Your subscription has been suspended. Please contact support.",
	}}}
	got = ClassifyAttempt(terminated, now)
	if got.Classification != FailureClassProfileSpecificLimit || !got.ImmediateCircuit {
		t.Fatalf("terminated classification=%+v want profile_specific_limit with immediate circuit", got)
	}

	// Generic quota, rate-limit, and temporary wording must not be treated as
	// a hard denial even when they classify as a profile-specific limit.
	for _, tc := range []struct {
		name   string
		events []protocol.Event
	}{
		{name: "generic quota", events: []protocol.Event{{Type: "run_finished", Data: map[string]any{"status": "failed", "error": "profile quota limit reached"}}}},
		{name: "429 rate limit", events: []protocol.Event{{Type: "run_finished", Data: map[string]any{"status": "failed", "error": "429 rate limit exceeded"}}}},
		{name: "temporary quota", events: []protocol.Event{{Type: "run_finished", Data: map[string]any{"status": "failed", "error": "temporary quota exhausted, retry shortly"}}}},
		{name: "billing mention without exact phrase", events: []protocol.Event{{Type: "run_finished", Data: map[string]any{"status": "failed", "error": "billing issue please retry later"}}}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := ClassifyAttempt(tc.events, now)
			if got.ImmediateCircuit {
				t.Fatalf("classification=%+v must not mark immediate circuit for %q", got, tc.name)
			}
		})
	}

	// A done run still wins over hard denial text.
	done := ClassifyAttempt([]protocol.Event{{Type: "run_finished", Data: map[string]any{
		"status": "done",
		"error":  "You've reached your usage limit for this billing cycle.",
	}}}, now)
	if done.Classification != FailureClassNone || done.ImmediateCircuit {
		t.Fatalf("done classification=%+v want none without immediate circuit", done)
	}
}
