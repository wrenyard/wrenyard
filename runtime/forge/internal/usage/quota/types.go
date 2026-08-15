package quota

import (
	"context"
	"math"
	"strings"
	"time"
)

type Provider interface {
	Name() string
	Fetch(ctx context.Context) (Quota, error)
}

type Quota struct {
	Provider  string        `json:"provider"`
	Used      *float64      `json:"used,omitempty"`
	Total     *float64      `json:"total,omitempty"`
	Windows   []Window      `json:"windows,omitempty"`
	FetchedAt time.Time     `json:"fetched_at,omitempty"`
	CacheAge  time.Duration `json:"-"`
	Stale     bool          `json:"stale,omitempty"`
	Source    string        `json:"source,omitempty"`
	Message   string        `json:"message,omitempty"`

	// Unavailable is set by the cache layer when auto-refresh has given up
	// and a cooldown is active. It signals to rendering code that the data
	// is not just stale — it's genuinely unavailable because the provider
	// is dead (e.g. SSO/cookie expired).
	Unavailable bool `json:"-"`

	// QuotaHidden indicates the platform hides quota (show "-").
	QuotaHidden bool `json:"quota_hidden,omitempty"`

	// Label is the canonical display label for this pool.
	Label string `json:"label,omitempty"`

	// DisplayLine is a pre-formatted single-line display string.
	DisplayLine string `json:"display_line,omitempty"`
}

type Window struct {
	Name          string     `json:"name"`
	Pct           float64    `json:"pct"`
	ResetsAt      *time.Time `json:"resets_at,omitempty"`
	WindowMinutes int        `json:"window_minutes,omitempty"`
}

// PaceJSON is the structured JSON representation of window pace.
type PaceJSON struct {
	DeltaPct float64 `json:"delta_pct"`
	Text     string  `json:"text"`
}

// ResetJSON is the structured JSON representation of a quota reset time.
type ResetJSON struct {
	At time.Time `json:"at"`
	In string    `json:"in"`
}

// SelectPaceAnchorIndex selects the index of the window used for pace
// computation: the 7d window if present, otherwise the last window.
// Returns -1 when windows is empty or the fallback is unreliable.
func SelectPaceAnchorIndex(windows []Window) int {
	for i := range windows {
		if strings.EqualFold(windows[i].Name, "7d") {
			return i
		}
	}
	if len(windows) > 0 {
		last := len(windows) - 1
		// For non-7d fallback, only allow pace with reliable elapsed data.
		if windows[last].ResetsAt != nil && windows[last].WindowMinutes > 0 {
			return last
		}
		return -1
	}
	return -1
}

// SelectPaceAnchor selects the window used for pace computation.
// It is a wrapper around SelectPaceAnchorIndex.
func SelectPaceAnchor(windows []Window) *Window {
	idx := SelectPaceAnchorIndex(windows)
	if idx < 0 {
		return nil
	}
	return &windows[idx]
}

// SelectNearestFutureReset returns the nearest future reset time across
// all windows, or nil if no window has a future ResetsAt.
func SelectNearestFutureReset(windows []Window) *time.Time {
	now := timeNow()
	var nearest *time.Time
	for i := range windows {
		if windows[i].ResetsAt != nil && windows[i].ResetsAt.After(now) {
			if nearest == nil || windows[i].ResetsAt.Before(*nearest) {
				nearest = windows[i].ResetsAt
			}
		}
	}
	return nearest
}

// PaceAndResetJSON computes structured pace and reset from windows.
// Pace is computed from the anchor window (7d or last).
// Reset is the nearest future reset across all windows, computed
// independently so reset is returned even when pace is nil.
func PaceAndResetJSON(windows []Window) (*PaceJSON, *ResetJSON) {
	anchor := SelectPaceAnchor(windows)
	var pace *PaceJSON
	if anchor != nil {
		delta := WindowPaceDelta(*anchor)
		pace = &PaceJSON{
			DeltaPct: math.Round(delta),
			Text:     FormatPaceText(delta),
		}
	}
	resetTime := SelectNearestFutureReset(windows)
	if resetTime != nil {
		reset := &ResetJSON{
			At: *resetTime,
			In: FormatResetCompact(*resetTime),
		}
		return pace, reset
	}
	return pace, nil
}

// WindowPaceDeltaAt computes the pace delta for a window at the given time.
// Positive means burning ahead (used more than expected at this point in the window).
// Negative means behind (used less than expected).
// Calendar-week fallback is allowed only for the 7d window.
func WindowPaceDeltaAt(w Window, now time.Time) float64 {
	// Calendar-week fallback: allowed only for 7d window.
	if strings.EqualFold(w.Name, "7d") && (w.ResetsAt == nil || w.WindowMinutes <= 0) {
		weekday := int(now.Weekday())
		if weekday == 0 {
			weekday = 7
		}
		start := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location()).AddDate(0, 0, -(weekday - 1))
		expected := now.Sub(start).Seconds() / (7 * 24 * 3600) * 100
		return w.Pct - expected
	}

	// Unreliable non-7d window: no pace.
	if w.ResetsAt == nil || w.WindowMinutes <= 0 {
		return 0
	}

	windowMinutes := float64(w.WindowMinutes)
	minutesUntilReset := w.ResetsAt.Sub(now).Minutes()
	elapsed := (windowMinutes - minutesUntilReset) / windowMinutes
	if elapsed < 0 {
		elapsed = 0
	}
	if elapsed > 1 {
		elapsed = 1
	}
	expected := elapsed * 100
	return w.Pct - expected
}

// WindowPaceDelta computes the pace delta for a window using the default clock.
func WindowPaceDelta(w Window) float64 {
	return WindowPaceDeltaAt(w, timeNow())
}

func expectedWindowRemainingPctAt(w Window, now time.Time) *float64 {
	// Calendar-week fallback: allowed only for 7d window. Keep this raw so
	// the JSON projection, rather than shared pace math, owns clamping.
	if strings.EqualFold(w.Name, "7d") && (w.ResetsAt == nil || w.WindowMinutes <= 0) {
		weekday := int(now.Weekday())
		if weekday == 0 {
			weekday = 7
		}
		start := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location()).AddDate(0, 0, -(weekday - 1))
		expectedRemaining := 100 - now.Sub(start).Seconds()/(7*24*3600)*100
		return &expectedRemaining
	}

	if w.ResetsAt == nil || w.WindowMinutes <= 0 {
		return nil
	}

	windowMinutes := float64(w.WindowMinutes)
	minutesUntilReset := w.ResetsAt.Sub(now).Minutes()
	expectedRemaining := 100 - (windowMinutes-minutesUntilReset)/windowMinutes*100
	return &expectedRemaining
}

func clampPct(v float64) float64 {
	if v < 0 {
		return 0
	}
	if v > 100 {
		return 100
	}
	return v
}

func Float64(v float64) *float64 { return &v }
