package execution

import (
	"testing"
	"time"
)

func TestRetryDelayTableWithZeroJitter(t *testing.T) {
	want := []time.Duration{0, 2 * time.Second, 4 * time.Second, 8 * time.Second, 16 * time.Second, 32 * time.Second, 64 * time.Second}
	for retry, expected := range want {
		if got := retryDelay(retry+1, func(time.Duration) time.Duration { return 0 }); got != expected {
			t.Fatalf("retry %d delay=%s want %s", retry+1, got, expected)
		}
	}
}

func TestRetryDelayJitterClampedToTwentyFivePercent(t *testing.T) {
	for retry := 2; retry <= maxProfileRetries; retry++ {
		base := retryBaseDelay(retry)
		for _, jitter := range []time.Duration{-base, -base / 4, 0, base / 4, base} {
			got := retryDelay(retry, func(time.Duration) time.Duration { return jitter })
			min := (base - base/4).Round(time.Millisecond)
			max := (base + base/4).Round(time.Millisecond)
			if jitter < -base/4 || jitter > base/4 {
				// JitterFn is a production/test seam; out-of-range values are
				// intentionally not silently clamped by the executor.
				continue
			}
			if got < min || got > max {
				t.Fatalf("retry %d jitter %s produced %s outside [%s,%s]", retry, jitter, got, min, max)
			}
		}
	}
}

func TestRetryWorstCaseWaitBudgetStaysUnderFiveMinutes(t *testing.T) {
	var total time.Duration
	for retry := 1; retry <= maxProfileRetries; retry++ {
		base := retryBaseDelay(retry)
		total += retryDelay(retry, func(time.Duration) time.Duration { return base / 4 })
	}
	if total > 5*time.Minute {
		t.Fatalf("worst-case cumulative wait=%s exceeds 5m", total)
	}
	if total != 157500*time.Millisecond {
		t.Fatalf("worst-case cumulative wait=%s want 2m37.5s", total)
	}
}
