package quota

import (
	"strings"
	"testing"
	"time"
)

func fixedNow() time.Time {
	return time.Date(2025, 1, 15, 10, 0, 0, 0, time.UTC)
}

func setFixedNow(t *testing.T) {
	t.Helper()
	old := timeNow
	timeNow = fixedNow
	t.Cleanup(func() { timeNow = old })
}

func TestCanonicalLabel(t *testing.T) {
	tests := []struct {
		pool string
		want string
	}{
		{"codex", "codex"},
		{"codex-spark", "spark"},
		{"kimi-coding", "kimi"},
		{"zhipu-coding", "glm"},
		{"super-grok", "super-grok"},
		{"unknown", "unknown"},
	}
	for _, tc := range tests {
		t.Run(tc.pool, func(t *testing.T) {
			if got := CanonicalLabel(tc.pool); got != tc.want {
				t.Fatalf("CanonicalLabel(%q) = %q, want %q", tc.pool, got, tc.want)
			}
		})
	}
}

func TestFormatPaceDisplay(t *testing.T) {
	if got := FormatPaceDisplay(12.5); got != "(+13%)" {
		t.Fatalf("FormatPaceDisplay(12.5) = %q, want (+13%%)", got)
	}
	if got := FormatPaceDisplay(-8.3); got != "(-8%)" {
		t.Fatalf("FormatPaceDisplay(-8.3) = %q, want (-8%%)", got)
	}
	if got := FormatPaceDisplay(0); got != "(+0%)" {
		t.Fatalf("FormatPaceDisplay(0) = %q, want (+0%%)", got)
	}
}

func TestFormatResetDuration(t *testing.T) {
	tests := []struct {
		d    time.Duration
		want string
	}{
		{0, ""},
		{-time.Hour, ""},
		{30 * time.Second, "<1m"},
		{time.Minute, "1m"},
		{43 * time.Minute, "43m"},
		{90 * time.Minute, "1h 30m"},
		{5*time.Hour + 42*time.Minute, "5h 42m"},
		{36*time.Hour + 30*time.Minute, "1d 12h"},
		{50 * time.Hour, "2d 2h"},
	}
	for _, tc := range tests {
		t.Run(tc.want, func(t *testing.T) {
			if got := FormatResetDuration(tc.d); got != tc.want {
				t.Fatalf("FormatResetDuration(%v) = %q, want %q", tc.d, got, tc.want)
			}
		})
	}
}

func TestFormatResetCompact(t *testing.T) {
	setFixedNow(t)
	now := fixedNow()
	tests := []struct {
		t    time.Time
		want string
	}{
		{now.Add(36*time.Hour + 30*time.Minute), "1d 12h"},
		{now.Add(5*time.Hour + 42*time.Minute), "5h 42m"},
		{now.Add(43 * time.Minute), "43m"},
		{now.Add(30 * time.Second), "<1m"},
		{now.Add(-time.Hour), ""},
		{time.Time{}, ""},
	}
	for _, tc := range tests {
		t.Run(tc.want, func(t *testing.T) {
			if got := FormatResetCompact(tc.t); got != tc.want {
				t.Fatalf("FormatResetCompact(%v) = %q, want %q", tc.t, got, tc.want)
			}
		})
	}
}

func TestSelectPaceAnchor7d(t *testing.T) {
	windows := []Window{
		{Name: "5h", Pct: 42, WindowMinutes: 300},
		{Name: "7d", Pct: 30, WindowMinutes: 10080},
	}
	anchor := SelectPaceAnchor(windows)
	if anchor == nil || anchor.Name != "7d" {
		t.Fatalf("expected 7d anchor, got %#v", anchor)
	}
}

func TestSelectPaceAnchorLastWhenNo7d(t *testing.T) {
	setFixedNow(t)
	now := fixedNow()
	reset := now.Add(90 * time.Minute)
	windows := []Window{
		{Name: "5h", Pct: 42, ResetsAt: &reset, WindowMinutes: 300},
	}
	anchor := SelectPaceAnchor(windows)
	if anchor == nil || anchor.Name != "5h" {
		t.Fatalf("expected 5h anchor, got %#v", anchor)
	}
}

func TestSelectPaceAnchorEmpty(t *testing.T) {
	if got := SelectPaceAnchor(nil); got != nil {
		t.Fatalf("expected nil for empty windows, got %#v", got)
	}
	if got := SelectPaceAnchor([]Window{}); got != nil {
		t.Fatalf("expected nil for empty windows, got %#v", got)
	}
}

func TestSelectNearestFutureReset(t *testing.T) {
	setFixedNow(t)
	now := fixedNow()
	far := now.Add(5 * time.Hour)
	near := now.Add(1 * time.Hour)
	windows := []Window{
		{Name: "5h", Pct: 42, ResetsAt: &far, WindowMinutes: 300},
		{Name: "7d", Pct: 30, ResetsAt: &near, WindowMinutes: 10080},
	}
	nearest := SelectNearestFutureReset(windows)
	if nearest == nil || !nearest.Equal(near) {
		t.Fatalf("expected nearest reset %v, got %v", near, nearest)
	}
}

func TestSelectNearestFutureResetSkipsPast(t *testing.T) {
	setFixedNow(t)
	now := fixedNow()
	past := now.Add(-1 * time.Hour)
	windows := []Window{
		{Name: "5h", Pct: 42, ResetsAt: &past, WindowMinutes: 300},
	}
	if got := SelectNearestFutureReset(windows); got != nil {
		t.Fatalf("expected nil when all resets are past, got %v", got)
	}
}

func TestSelectNearestFutureResetEmpty(t *testing.T) {
	if got := SelectNearestFutureReset(nil); got != nil {
		t.Fatalf("expected nil for empty windows, got %v", got)
	}
}

func TestPaceAndResetJSONDualWindow(t *testing.T) {
	setFixedNow(t)
	now := fixedNow()
	reset5h := now.Add(90 * time.Minute)
	windows := []Window{
		{Name: "5h", Pct: 42, ResetsAt: &reset5h, WindowMinutes: 300},
		{Name: "7d", Pct: 30, ResetsAt: nil, WindowMinutes: 10080},
	}
	pace, reset := PaceAndResetJSON(windows)
	if pace == nil {
		t.Fatal("expected non-nil pace")
	}
	if pace.DeltaPct == 0 {
		t.Fatal("expected non-zero pace delta")
	}
	if pace.Text == "" {
		t.Fatal("expected non-empty pace text")
	}
	if !strings.HasSuffix(pace.Text, "%") {
		t.Fatalf("pace text should end with %%, got %q", pace.Text)
	}
	if reset == nil {
		t.Fatal("expected non-nil reset (5h has future ResetsAt)")
	}
	if reset.In == "" {
		t.Fatal("expected non-empty reset time")
	}
	if !reset.At.Equal(reset5h) {
		t.Fatalf("reset.At = %v, want %v", reset.At, reset5h)
	}
}

func TestPaceAndResetJSONWindowless(t *testing.T) {
	pace, reset := PaceAndResetJSON(nil)
	if pace != nil || reset != nil {
		t.Fatalf("expected nil pace/reset for empty windows, got pace=%#v reset=%#v", pace, reset)
	}
	pace, reset = PaceAndResetJSON([]Window{})
	if pace != nil || reset != nil {
		t.Fatalf("expected nil pace/reset for empty windows, got pace=%#v reset=%#v", pace, reset)
	}
}

func TestPaceAndResetJSONNoFutureReset(t *testing.T) {
	setFixedNow(t)
	windows := []Window{
		{Name: "7d", Pct: 50, WindowMinutes: 10080},
	}
	pace, reset := PaceAndResetJSON(windows)
	if pace == nil {
		t.Fatal("expected non-nil pace")
	}
	if reset != nil {
		t.Fatalf("expected nil reset (no future ResetAt), got %#v", reset)
	}
}

func TestWindowDisplayLineDualWindowWithReset(t *testing.T) {
	setFixedNow(t)
	now := fixedNow()
	reset5h := now.Add(260 * time.Minute)  // 4h 20m
	reset7d := now.Add(8770 * time.Minute) // ~6d 2h
	windows := []Window{
		{Name: "5h", Pct: 11, ResetsAt: &reset5h, WindowMinutes: 300},
		{Name: "7d", Pct: 11, ResetsAt: &reset7d, WindowMinutes: 10080},
	}
	line := WindowDisplayLine(windows)
	expected := "5h 11% · 7d 11% (-2%) · 4h 20m reset"
	if line != expected {
		t.Fatalf("WindowDisplayLine = %q, want %q", line, expected)
	}
}

func TestPaceAndResetJSONPrefers7dAnchorAndNearestReset(t *testing.T) {
	setFixedNow(t)
	now := fixedNow()
	farReset := now.Add(5 * time.Hour)
	nearReset := now.Add(90 * time.Minute)
	windows := []Window{
		{Name: "5h", Pct: 42, ResetsAt: &farReset, WindowMinutes: 300},
		{Name: "7d", Pct: 30, ResetsAt: &nearReset, WindowMinutes: 10080},
	}
	pace, reset := PaceAndResetJSON(windows)
	if pace == nil {
		t.Fatal("expected non-nil pace")
	}
	// Anchor is 7d window, pace delta from 7d (Pct=30, calendar-week fallback)
	if pace.DeltaPct == 0 {
		t.Fatal("expected non-zero pace delta from 7d anchor")
	}
	// Reset should be the nearest future: 90 minutes (not 5h)
	if reset == nil {
		t.Fatal("expected non-nil reset")
	}
	if !reset.At.Equal(nearReset) {
		t.Fatalf("expected nearest reset (1h30m), got %v", reset.At)
	}
	if reset.In != "1h 30m" {
		t.Fatalf("expected reset.In = \"1h 30m\", got %q", reset.In)
	}
}

func TestWindowDisplayLineDualWindowNilReset(t *testing.T) {
	setFixedNow(t)
	windows := []Window{
		{Name: "5h", Pct: 42, ResetsAt: nil, WindowMinutes: 300},
		{Name: "7d", Pct: 30, ResetsAt: nil, WindowMinutes: 10080},
	}
	line := WindowDisplayLine(windows)
	if line == "" {
		t.Fatal("expected non-empty display line")
	}
	if !strings.Contains(line, "5h") || !strings.Contains(line, "7d") {
		t.Fatalf("display line should contain both windows: %q", line)
	}
	if strings.Contains(line, "▲") || strings.Contains(line, "▼") {
		t.Fatalf("display line should not have arrow symbols: %q", line)
	}
}

func TestWindowDisplayLineSingleWindow(t *testing.T) {
	setFixedNow(t)
	windows := []Window{
		{Name: "7d", Pct: 50, WindowMinutes: 10080},
	}
	line := WindowDisplayLine(windows)
	if line == "" {
		t.Fatal("expected non-empty display line for single window")
	}
	if !strings.Contains(line, "7d") || !strings.Contains(line, "50%") {
		t.Fatalf("display line should contain window name and pct: %q", line)
	}
}

func TestWindowDisplayLineWindowless(t *testing.T) {
	if got := WindowDisplayLine(nil); got != "" {
		t.Fatalf("expected empty for nil windows, got %q", got)
	}
	if got := WindowDisplayLine([]Window{}); got != "" {
		t.Fatalf("expected empty for empty windows, got %q", got)
	}
}

func TestWindowDisplayLineDuplicateNames(t *testing.T) {
	setFixedNow(t)
	now := fixedNow()
	reset := now.Add(90 * time.Minute)
	windows := []Window{
		{Name: "5h", Pct: 42, ResetsAt: &reset, WindowMinutes: 300},
		{Name: "5h", Pct: 50, ResetsAt: &reset, WindowMinutes: 300},
	}
	line := WindowDisplayLine(windows)
	// Only one pace marker should be shown (on the anchor window).
	// Anchor = last (index 1): elapsed=(300-90)/300=0.7, expected=70, delta=50-70=-20
	if strings.Count(line, "(") != 1 {
		t.Fatalf("expected exactly 1 pace marker for duplicate names, got %q", line)
	}
	if !strings.Contains(line, "5h 50% (-20%)") {
		t.Fatalf("expected pace on last window, got %q", line)
	}
}

func TestWindowDisplayLineUnreliableNon7d(t *testing.T) {
	windows := []Window{
		{Name: "5h", Pct: 42, ResetsAt: nil, WindowMinutes: 0},
	}
	line := WindowDisplayLine(windows)
	// Should show window display but no pace (no parentheses).
	if strings.Contains(line, "(") || strings.Contains(line, ")") {
		t.Fatalf("expected no pace for unreliable non-7d window, got %q", line)
	}
	if !strings.Contains(line, "5h 42%") {
		t.Fatalf("expected window display, got %q", line)
	}
}

func TestWindowPaceDeltaFallbackNilResetsAt(t *testing.T) {
	setFixedNow(t)
	w := Window{Name: "7d", Pct: 50, ResetsAt: nil, WindowMinutes: 10080}
	delta := WindowPaceDelta(w)
	if delta > 100 || delta < -100 {
		t.Fatalf("unexpected delta: %f", delta)
	}
}

func TestWindowPaceDeltaClampPast(t *testing.T) {
	setFixedNow(t)
	reset := fixedNow().Add(-time.Hour)
	w := Window{Name: "7d", Pct: 50, ResetsAt: &reset, WindowMinutes: 60}
	delta := WindowPaceDelta(w)
	// elapsed=1, expected=100, delta=50-100=-50
	if delta > -49 || delta < -51 {
		t.Fatalf("clamped past delta = %f, want ~ -50", delta)
	}
}

func TestWindowPaceDeltaClampFuture(t *testing.T) {
	setFixedNow(t)
	reset := fixedNow().Add(200 * time.Hour)
	w := Window{Name: "7d", Pct: 50, ResetsAt: &reset, WindowMinutes: 10080}
	delta := WindowPaceDelta(w)
	// elapsed=0, expected=0, delta=50-0=50
	if delta < 49 || delta > 51 {
		t.Fatalf("clamped future delta = %f, want ~ 50", delta)
	}
}

func TestDisplayLineGenericRemain(t *testing.T) {
	q := Quota{
		Used:  Float64(4800),
		Total: Float64(7000),
	}
	line := DisplayLine(q)
	if line == "" {
		t.Fatal("expected non-empty display line for used/total quota")
	}
	if !strings.Contains(line, "remain ¥2.2k") {
		t.Fatalf("expected remaining with currency sign: %q", line)
	}
}

func TestDisplayLineQuotaHidden(t *testing.T) {
	q := Quota{
		Used:        Float64(100),
		Total:       Float64(7000),
		QuotaHidden: true,
	}
	line := DisplayLine(q)
	if line != "" {
		t.Fatalf("expected empty display line for hidden quota, got %q", line)
	}
}

func TestDisplayLineWindowedPreference(t *testing.T) {
	setFixedNow(t)
	q := Quota{
		Provider: "codex",
		Label:    "codex",
		Used:     Float64(100),
		Total:    Float64(7000),
		Windows:  []Window{{Name: "7d", Pct: 42, WindowMinutes: 10080}},
	}
	line := DisplayLine(q)
	if line == "" {
		t.Fatal("expected non-empty display line")
	}
	if !strings.HasPrefix(line, "codex ") {
		t.Fatalf("expected label prefix 'codex ' in display line: %q", line)
	}
	if !strings.Contains(line, "7d") || !strings.Contains(line, "42%") {
		t.Fatalf("expected window-based display line: %q", line)
	}
}

func TestDisplayLineEmpty(t *testing.T) {
	q := Quota{Provider: "empty"}
	if got := DisplayLine(q); got != "" {
		t.Fatalf("expected empty display line, got %q", got)
	}
}

func TestFormatPaceTextPositive(t *testing.T) {
	got := FormatPaceText(12.5)
	if got != "+13%" {
		t.Fatalf("FormatPaceText(12.5) = %q, want +13%%", got)
	}
}

func TestFormatPaceTextNegative(t *testing.T) {
	got := FormatPaceText(-8.3)
	if got != "-8%" {
		t.Fatalf("FormatPaceText(-8.3) = %q, want -8%%", got)
	}
}

func TestFormatPaceTextZero(t *testing.T) {
	got := FormatPaceText(0)
	if got != "+0%" {
		t.Fatalf("FormatPaceText(0) = %q, want +0%%", got)
	}
}

func TestFormatResetCompactDays(t *testing.T) {
	setFixedNow(t)
	reset := fixedNow().Add(36*time.Hour + 30*time.Minute)
	got := FormatResetCompact(reset)
	if got != "1d 12h" {
		t.Fatalf("FormatResetCompact(36h30m) = %q, want 1d 12h", got)
	}
}

func TestFormatResetCompactHours(t *testing.T) {
	setFixedNow(t)
	reset := fixedNow().Add(5*time.Hour + 42*time.Minute)
	got := FormatResetCompact(reset)
	if got != "5h 42m" {
		t.Fatalf("FormatResetCompact(5h42m) = %q, want 5h 42m", got)
	}
}

func TestFormatResetCompactMinutes(t *testing.T) {
	setFixedNow(t)
	reset := fixedNow().Add(43 * time.Minute)
	got := FormatResetCompact(reset)
	if got != "43m" {
		t.Fatalf("FormatResetCompact(43m) = %q, want 43m", got)
	}
}

func TestFormatResetCompactSubMinute(t *testing.T) {
	setFixedNow(t)
	reset := fixedNow().Add(30 * time.Second)
	got := FormatResetCompact(reset)
	if got != "<1m" {
		t.Fatalf("FormatResetCompact(<1m) = %q, want <1m", got)
	}
}

func TestSelectPaceAnchorUnreliableNon7dReturnsNil(t *testing.T) {
	// Non-7d without ResetsAt is unreliable → SelectPaceAnchor returns nil.
	windows := []Window{
		{Name: "5h", Pct: 42, WindowMinutes: 300},
	}
	if got := SelectPaceAnchor(windows); got != nil {
		t.Fatalf("expected nil for unreliable non-7d, got %#v", got)
	}
	// Non-7d with ResetsAt and WindowMinutes is reliable → returns anchor.
	now := fixedNow()
	reset := now.Add(90 * time.Minute)
	reliable := []Window{
		{Name: "5h", Pct: 42, ResetsAt: &reset, WindowMinutes: 300},
	}
	anchor := SelectPaceAnchor(reliable)
	if anchor == nil || anchor.Name != "5h" {
		t.Fatalf("expected 5h anchor for reliable non-7d, got %#v", anchor)
	}
}

func TestPaceAndResetJSONIndependentResetWhenPaceNil(t *testing.T) {
	setFixedNow(t)
	now := fixedNow()
	reset := now.Add(90 * time.Minute)
	// Unreliable anchor (no ResetsAt on only window) → pace nil, but reset still computed.
	windows := []Window{
		{Name: "5h", Pct: 42, WindowMinutes: 300, ResetsAt: nil},
	}
	pace, resetJSON := PaceAndResetJSON(windows)
	if pace != nil {
		t.Fatalf("expected nil pace for unreliable anchor, got %#v", pace)
	}
	if resetJSON != nil {
		t.Fatalf("expected nil reset when no future ResetsAt, got %#v", resetJSON)
	}

	// Add a window with future ResetsAt → reset should be returned even with nil pace.
	windows2 := []Window{
		{Name: "5h", Pct: 42, WindowMinutes: 300, ResetsAt: nil},
		{Name: "7d", Pct: 50, WindowMinutes: 10080, ResetsAt: &reset},
	}
	pace2, reset2 := PaceAndResetJSON(windows2)
	if pace2 == nil {
		t.Fatal("expected non-nil pace (7d anchor available)")
	}
	if reset2 == nil {
		t.Fatal("expected non-nil reset (7d has future ResetsAt)")
	}
}

func TestFormatResetCompactExpired(t *testing.T) {
	setFixedNow(t)
	reset := fixedNow().Add(-time.Hour)
	got := FormatResetCompact(reset)
	if got != "" {
		t.Fatalf("FormatResetCompact(expired) = %q, want empty", got)
	}
}

func TestFormatResetCompactZero(t *testing.T) {
	got := FormatResetCompact(time.Time{})
	if got != "" {
		t.Fatalf("FormatResetCompact(zero) = %q, want empty", got)
	}
}

func TestWindowDisplayLineDuplicateNamesOnePace(t *testing.T) {
	setFixedNow(t)
	now := fixedNow()
	reset := now.Add(90 * time.Minute)
	windows := []Window{
		{Name: "5h", Pct: 42, ResetsAt: &reset, WindowMinutes: 300},
		{Name: "5h", Pct: 50, ResetsAt: &reset, WindowMinutes: 300},
	}
	line := WindowDisplayLine(windows)
	// Only one pace marker on the anchor (last) window.
	if strings.Count(line, "(") != 1 {
		t.Fatalf("expected exactly 1 pace marker for duplicate names, got %q", line)
	}
}

func TestWindowDisplayLineUnreliableNon7dNoPace(t *testing.T) {
	// Non-7d without ResetsAt (unreliable) → no pace.
	windows := []Window{
		{Name: "5h", Pct: 42, WindowMinutes: 300},
	}
	line := WindowDisplayLine(windows)
	if strings.Contains(line, "(") || strings.Contains(line, ")") {
		t.Fatalf("expected no pace for unreliable non-7d, got %q", line)
	}
}

func TestWindowDisplayLineReliableNon7dHasPace(t *testing.T) {
	setFixedNow(t)
	now := fixedNow()
	reset := now.Add(90 * time.Minute)
	windows := []Window{
		{Name: "5h", Pct: 50, ResetsAt: &reset, WindowMinutes: 300},
	}
	line := WindowDisplayLine(windows)
	if !strings.Contains(line, "(") {
		t.Fatalf("expected pace for reliable non-7d, got %q", line)
	}
}
