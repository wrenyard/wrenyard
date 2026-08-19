package quota

import (
	"fmt"
	"math"
	"strings"
	"time"
)

// timeNow is a variable for testing; production code calls time.Now.
var timeNow = time.Now

// CanonicalLabel returns a short display label for a pool name.
func CanonicalLabel(pool string) string {
	switch pool {
	case "codex":
		return "codex"
	case "codex-spark":
		return "spark"
	case "kimi-coding":
		return "kimi"
	case "zhipu-coding":
		return "glm"
	case "super-grok":
		return "super-grok"
	default:
		return pool
	}
}

// FormatPaceText returns a signed integer pace string without parentheses.
// Positive delta = burning ahead: +N%
// Negative delta = behind: -N%
func FormatPaceText(delta float64) string {
	d := math.Round(delta)
	if d >= 0 {
		return fmt.Sprintf("+%d%%", int(d))
	}
	return fmt.Sprintf("-%d%%", -int(d))
}

// FormatPaceDisplay wraps the pace text in parentheses for display_line.
func FormatPaceDisplay(delta float64) string {
	return "(" + FormatPaceText(delta) + ")"
}

// FormatResetDuration formats a duration as a compact reset string.
// >=1d → "Nd Nh"
// >=1h → "Nh Nm"
// >=1m → "Nm"
// <1m → "<1m"
// Zero or negative → ""
func FormatResetDuration(d time.Duration) string {
	if d <= 0 {
		return ""
	}
	if d >= 24*time.Hour {
		days := int(d.Hours()) / 24
		hours := int(d.Hours()) % 24
		return fmt.Sprintf("%dd %dh", days, hours)
	}
	if d >= time.Hour {
		h := int(d.Hours())
		m := int(d.Minutes()) % 60
		return fmt.Sprintf("%dh %dm", h, m)
	}
	if d >= time.Minute {
		m := int(d.Minutes())
		return fmt.Sprintf("%dm", m)
	}
	return "<1m"
}

// FormatResetCompact formats a reset time as a compact string.
func FormatResetCompact(t time.Time) string {
	return FormatResetDuration(t.Sub(timeNow()))
}

// WindowDisplayLine produces a compact display string for quota with windows.
// Each window shows remaining percentage plus the literal "remain".
// Pace is shown on the anchor window (7d preferred, last as fallback),
// wrapped as (+N%) or (-N%) in used-vs-expected space. The nearest future
// reset is appended as a separate final segment ending with the literal
// word "reset".
func WindowDisplayLine(windows []Window) string {
	if len(windows) == 0 {
		return ""
	}
	parts := make([]string, 0, len(windows)+1)
	anchorIdx := SelectPaceAnchorIndex(windows)
	for i, w := range windows {
		part := fmt.Sprintf("%s %.0f%% remain", w.Name, clampPct(100-w.Pct))
		if anchorIdx >= 0 && i == anchorIdx {
			delta := WindowPaceDeltaAt(w, timeNow())
			part += " " + FormatPaceDisplay(delta)
		}
		parts = append(parts, part)
	}
	// Append nearest future reset as a separate final segment
	// ending with the literal word "reset".
	resetTime := SelectNearestFutureReset(windows)
	if resetTime != nil {
		if reset := FormatResetCompact(*resetTime); reset != "" {
			parts = append(parts, reset+" reset")
		}
	}
	return strings.Join(parts, " · ")
}

// DisplayLine builds a display_line string for a Quota, prefixed with the
// canonical label when set.  It does not fabricate windows.
func DisplayLine(q Quota) string {
	var line string
	if len(q.Windows) > 0 {
		line = WindowDisplayLine(q.Windows)
	}
	if line == "" && q.Used != nil && q.Total != nil && *q.Total > 0 && !q.QuotaHidden {
		remaining := *q.Total - *q.Used
		if remaining < 0 {
			remaining = 0
		}
		line = "remain " + compactMoney(remaining)
	}
	if line != "" && q.Label != "" {
		line = q.Label + " " + line
	}
	return line
}

func compactMoney(v float64) string {
	if v >= 1_000_000 {
		v = v / 1_000_000
		if math.Abs(v-math.Round(v)) < 0.05 {
			return fmt.Sprintf("¥%.0fM", v)
		}
		return fmt.Sprintf("¥%.1fM", v)
	}
	if v >= 1000 {
		v = v / 1000
		if math.Abs(v-math.Round(v)) < 0.05 {
			return fmt.Sprintf("¥%.0fk", v)
		}
		return fmt.Sprintf("¥%.1fk", v)
	}
	if v == float64(int64(v)) {
		return fmt.Sprintf("¥%.0f", v)
	}
	return fmt.Sprintf("¥%.1f", v)
}
