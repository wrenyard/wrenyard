package execution

import (
	"math/rand"
	"time"
)

const maxProfileRetries = 7

var retryBaseDelays = [...]time.Duration{
	0,
	2 * time.Second,
	4 * time.Second,
	8 * time.Second,
	16 * time.Second,
	32 * time.Second,
	64 * time.Second,
}

func retryBaseDelay(retry int) time.Duration {
	if retry < 1 || retry > len(retryBaseDelays) {
		return 0
	}
	return retryBaseDelays[retry-1]
}

func productionJitter(base time.Duration) time.Duration {
	if base <= 0 {
		return 0
	}
	span := float64(base) * 0.25
	return time.Duration((rand.Float64()*2 - 1) * span)
}

func retryDelay(retry int, jitter JitterFn) time.Duration {
	base := retryBaseDelay(retry)
	if base <= 0 {
		return 0
	}
	if jitter != nil {
		base += jitter(base)
	}
	if base < 0 {
		base = 0
	}
	return base.Round(time.Millisecond)
}
