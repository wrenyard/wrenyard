package execution

import (
	"encoding/json"
	"strings"
	"time"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/driver"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/protocol"
)

// Clock and Sleeper are the small execution seams used by circuit and retry
// behavior. Production uses wall time; offline tests provide deterministic
// implementations.
type Clock interface {
	Now() time.Time
}

type Sleeper interface {
	Sleep(time.Duration) error
}

type JitterFn func(base time.Duration) time.Duration

type realClock struct{}

func (realClock) Now() time.Time { return time.Now() }

type realSleeper struct{}

func (realSleeper) Sleep(delay time.Duration) error {
	time.Sleep(delay)
	return nil
}

type FailureClass string

const (
	FailureClassNone                 FailureClass = "none"
	FailureClassProfileSpecificLimit FailureClass = "profile_specific_limit"
	FailureClassTransientProvider    FailureClass = "transient_provider"
	FailureClassNonRetryable         FailureClass = "non_retryable"
	FailureClassPolicyExhausted      FailureClass = "policy_exhausted"
)

type Classification = FailureClass

const (
	ClassificationNone                 Classification = FailureClassNone
	ClassificationProfileSpecificLimit Classification = FailureClassProfileSpecificLimit
	ClassificationTransientProvider    Classification = FailureClassTransientProvider
	ClassificationNonRetryable         Classification = FailureClassNonRetryable
)

// AttemptClassification is the safe decision produced from one normalized
// child snapshot. It has no prompt, stdin, raw transcript, or command fields.
type AttemptClassification struct {
	Classification  Classification
	RecoveryAt      *time.Time
	NativeSessionID string
	// ImmediateCircuit marks a verified hard subscription/account denial
	// (for example an explicit billing-cycle quota exhaustion) that was
	// classified as profile_specific_limit. Retrying such denials is
	// pointless, so the orchestrator opens the profile circuit immediately.
	ImmediateCircuit bool
}

// ClassifyAttempt classifies only normalized downstream events. The explicit
// failure_class field wins over text patterns; done always wins over failure
// text. Recovery timestamps are accepted only from the structured allowlist.
func ClassifyAttempt(events []protocol.Event, now time.Time) AttemptClassification {
	result := AttemptClassification{Classification: ClassificationNonRetryable}
	var texts []string
	var fields []map[string]any
	sawDone := false
	for _, event := range events {
		data := event.Data
		if data == nil {
			continue
		}
		if event.Type == "run_finished" {
			if status, ok := data["status"].(string); ok && strings.EqualFold(strings.TrimSpace(status), "done") {
				sawDone = true
			}
			fields = append(fields, data)
			if text := normalizedText(data["error"]); text != "" {
				texts = append(texts, text)
			}
			if text, ok := data["text"].(string); ok && text != "" {
				texts = append(texts, text)
			}
			if explicit, ok := explicitFailureClass(data); ok {
				result.Classification = explicit
			}
		}
		if event.Type == "message" {
			if text, ok := data["text"].(string); ok && text != "" {
				texts = append(texts, text)
			}
		}
	}
	joined := strings.ToLower(strings.Join(texts, "\n"))
	if recovered := verifiedCodeBuddyRecoveryAt(texts, now); recovered != nil {
		return AttemptClassification{
			Classification:   ClassificationProfileSpecificLimit,
			RecoveryAt:       recovered,
			NativeSessionID:  latestNativeSessionID(events),
			ImmediateCircuit: hardProfileLimitSignal(joined),
		}
	}
	if sawDone {
		return AttemptClassification{Classification: ClassificationNone, NativeSessionID: latestNativeSessionID(events)}
	}

	if explicit := firstExplicitClass(fields); explicit != "" {
		result.Classification = explicit
	} else {
		switch {
		case profileSpecificSignal(joined):
			result.Classification = ClassificationProfileSpecificLimit
		case transientProviderSignal(joined):
			result.Classification = ClassificationTransientProvider
		default:
			result.Classification = ClassificationNonRetryable
		}
	}
	if result.Classification == ClassificationNone {
		return result
	}
	if result.RecoveryAt == nil {
		result.RecoveryAt = reliableRecoveryAt(fields, now)
	}
	if result.Classification == ClassificationProfileSpecificLimit && hardProfileLimitSignal(joined) {
		result.ImmediateCircuit = true
	}
	return result
}

func verifiedCodeBuddyRecoveryAt(texts []string, now time.Time) *time.Time {
	for _, text := range texts {
		recovered, ok := driver.ParseCodeBuddyResetRecoveryAt(strings.TrimSpace(text))
		if !ok {
			continue
		}
		recovered = recovered.UTC()
		if recovered.After(now.UTC()) && recovered.Sub(now.UTC()) <= 7*24*time.Hour {
			return &recovered
		}
	}
	return nil
}

func explicitFailureClass(data map[string]any) (Classification, bool) {
	raw, ok := data["failure_class"]
	if !ok {
		if nested, nestedOK := data["failure"].(map[string]any); nestedOK {
			raw, ok = nested["failure_class"]
			if !ok {
				raw, ok = nested["class"]
			}
		}
	}
	value, ok := raw.(string)
	if !ok {
		return "", false
	}
	switch FailureClass(strings.TrimSpace(value)) {
	case FailureClassNone:
		return ClassificationNone, true
	case FailureClassProfileSpecificLimit:
		return ClassificationProfileSpecificLimit, true
	case FailureClassTransientProvider:
		return ClassificationTransientProvider, true
	case FailureClassNonRetryable:
		return ClassificationNonRetryable, true
	default:
		return ClassificationNonRetryable, true
	}
}

func firstExplicitClass(fields []map[string]any) Classification {
	for _, field := range fields {
		if classification, ok := explicitFailureClass(field); ok {
			return classification
		}
	}
	return ""
}

func profileSpecificSignal(text string) bool {
	if strings.Contains(text, "profile_specific_limit") || strings.Contains(text, "profile-specific limit") {
		return true
	}
	profileMention := strings.Contains(text, "profile") || strings.Contains(text, "credential") || strings.Contains(text, "account") || strings.Contains(text, "subscription") || strings.Contains(text, "quota")
	limitMention := strings.Contains(text, "quota") || strings.Contains(text, "limit") || strings.Contains(text, "suspend") || strings.Contains(text, "paused") || strings.Contains(text, "unavailable") || strings.Contains(text, "disabled")
	return profileMention && limitMention
}

// hardProfileLimitSignal recognizes exact hard subscription/account denials
// where retrying is pointless: explicit billing-cycle quota exhaustion and
// terminated account access. It matches only precise denial phrases, never
// generic quota, rate-limit, or temporary wording.
func hardProfileLimitSignal(text string) bool {
	for _, phrase := range []string{
		"you've reached your usage limit for this billing cycle",
		"you have reached your usage limit for this billing cycle",
		"usage limit for this billing cycle",
		"access terminated",
	} {
		if strings.Contains(text, phrase) {
			return true
		}
	}
	return false
}

func transientProviderSignal(text string) bool {
	for _, signal := range []string{
		"429", "rate limit", "rate_limit", "too many requests", "503", "service unavailable",
		"connection reset", "connection refused", "transient provider", "temporarily unavailable",
		"gateway timeout", "upstream timeout",
	} {
		if strings.Contains(text, signal) {
			return true
		}
	}
	return false
}

func normalizedText(value any) string {
	switch v := value.(type) {
	case string:
		return v
	case map[string]any:
		for _, key := range []string{"message", "error", "detail", "code", "type"} {
			if text := normalizedText(v[key]); text != "" {
				return text
			}
		}
		data, _ := json.Marshal(v)
		return string(data)
	default:
		return ""
	}
}

func latestNativeSessionID(events []protocol.Event) string {
	latest := ""
	for _, event := range events {
		if event.Type != protocol.EventRunFinished {
			continue
		}
		if event.Data == nil {
			continue
		}
		if id, ok := event.Data["native_session_id"].(string); ok && validNativeSessionID(id) {
			latest = strings.TrimSpace(id)
		}
	}
	return latest
}

func validNativeSessionID(id string) bool {
	id = strings.TrimSpace(id)
	if id == "" {
		return false
	}
	for _, r := range id {
		if r == '\x00' || r == '\n' || r == '\r' {
			return false
		}
	}
	return true
}

func reliableRecoveryAt(fields []map[string]any, now time.Time) *time.Time {
	now = now.UTC()
	for _, field := range fields {
		if recovered, ok := parseRecoveryTimestamp(field["recovery_at"], now); ok {
			return &recovered
		}
		if nested, ok := field["error"].(map[string]any); ok {
			if recovered, ok := parseRecoveryTimestamp(nested["recovery_at"], now); ok {
				return &recovered
			}
		}
		if recovered, ok := parseRetryAfter(field["retry_after_seconds"], now); ok {
			return &recovered
		}
		if nested, ok := field["error"].(map[string]any); ok {
			if recovered, ok := parseRetryAfter(nested["retry_after_seconds"], now); ok {
				return &recovered
			}
		}
	}
	return nil
}

func parseRecoveryTimestamp(raw any, now time.Time) (time.Time, bool) {
	value, ok := raw.(string)
	if !ok || strings.TrimSpace(value) == "" {
		return time.Time{}, false
	}
	parsed, err := time.Parse(time.RFC3339, value)
	if err != nil {
		return time.Time{}, false
	}
	parsed = parsed.UTC()
	if !parsed.After(now) || parsed.Sub(now) > 7*24*time.Hour {
		return time.Time{}, false
	}
	return parsed, true
}

func parseRetryAfter(raw any, now time.Time) (time.Time, bool) {
	seconds, ok := integerValue(raw)
	if !ok || seconds < 1 || seconds > 604800 {
		return time.Time{}, false
	}
	return now.Add(time.Duration(seconds) * time.Second), true
}

func integerValue(raw any) (int64, bool) {
	switch value := raw.(type) {
	case int:
		return int64(value), true
	case int8:
		return int64(value), true
	case int16:
		return int64(value), true
	case int32:
		return int64(value), true
	case int64:
		return value, true
	case uint:
		return int64(value), uint64(value) <= uint64(^uint64(0)>>1)
	case uint8:
		return int64(value), true
	case uint16:
		return int64(value), true
	case uint32:
		return int64(value), true
	case uint64:
		if value > uint64(^uint64(0)>>1) {
			return 0, false
		}
		return int64(value), true
	case float64:
		if value != float64(int64(value)) {
			return 0, false
		}
		return int64(value), true
	default:
		return 0, false
	}
}
