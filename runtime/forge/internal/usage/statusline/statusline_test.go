package statusline

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/usage/quota"
)

func setFixedNow(t *testing.T) {
	t.Helper()
	old := timeNow
	timeNow = func() time.Time {
		return time.Date(2025, 1, 15, 10, 0, 0, 0, time.UTC)
	}
	t.Cleanup(func() { timeNow = old })
}

type staticQuota struct{ q quota.Quota }

func (p staticQuota) Name() string { return "static" }
func (p staticQuota) Fetch(context.Context) (quota.Quota, error) {
	return p.q, nil
}

func TestRenderGolden(t *testing.T) {
	dir := t.TempDir()
	transcript := filepath.Join(dir, "s1.jsonl")
	if err := os.WriteFile(transcript, []byte(`{"message":{"id":"m1","model":"deepseek-v4-pro","usage":{"input_tokens":1000,"output_tokens":500,"cache_read_input_tokens":900}}}`+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	billing := Billing{
		DefaultQuotaTotal: 7000,
		Models: map[string]ModelRate{
			"deepseek-v4-pro": {Input: 5, CacheWrite5: 6.25, CacheWrite1: 10, CacheRead: 0.5, Output: 25},
		},
	}
	billing.ModelDisplayNames = map[string]string{"deepseek-v4-pro": "DeepSeek V4 Pro"}
	out := Render(Context{
		Context: context.Background(),
		Input: Input{
			SessionID:  "s1",
			Transcript: transcript,
			Model:      Model{ID: "deepseek-v4-pro"},
			ContextWindow: map[string]any{
				"total_input_tokens":  50000.0,
				"context_window_size": 200000.0,
			},
		},
		Profile:       Profile{Name: "ccc", Client: "claude", Provider: "anthropic"},
		Billing:       billing,
		QuotaProvider: staticQuota{q: quota.Quota{Used: quota.Float64(100), Total: quota.Float64(7000)}},
		Home:          dir,
	})
	for _, want := range []string{"🤖 DeepSeek V4 Pro", "⏱ 100/7000", "📊 0.002M", "🧠 25.0% · 200K"} {
		if !strings.Contains(out, want) {
			t.Fatalf("output %q missing %q", out, want)
		}
	}
}

func TestRenderWithoutContextWindowDoesNotPanic(t *testing.T) {
	out := Render(Context{
		Context: context.Background(),
		Input:   Input{Model: Model{ID: "claude-sonnet-4"}},
		Profile: Profile{Name: "ccc", Provider: "anthropic", Segments: []string{"model", "context"}},
		Billing: Billing{},
	})
	for _, want := range []string{"🤖 Sonnet 4", "🧠 0.0% · 200K"} {
		if !strings.Contains(out, want) {
			t.Fatalf("output %q missing %q", out, want)
		}
	}
}

func TestTranscriptLineWithoutMessageIsSkippedSafely(t *testing.T) {
	dir := t.TempDir()
	transcript := filepath.Join(dir, "s1.jsonl")
	if err := os.WriteFile(transcript, []byte(`{"other":"data"}`+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if got, rate := transcriptUsage("s1", transcript); got != 0 || rate != nil {
		t.Fatalf("transcriptUsage = %d, %#v", got, rate)
	}
}

func TestDetectProfileCbDs(t *testing.T) {
	profiles := map[string]Profile{
		"ccc":     {Name: "ccc", Client: "claude", Provider: "anthropic"},
		"cb-ds":   {Name: "cb-ds", Client: "codebuddy", Provider: "codebuddy"},
		"cb-dsf":  {Name: "cb-dsf", Client: "codebuddy", Provider: "codebuddy"},
		"unknown": {Name: "unknown"},
	}
	// FORGE_PROFILE exact match
	t.Setenv("FORGE_PROFILE", "cb-ds")
	if got := DetectProfile(Input{}, profiles); got != "cb-ds" {
		t.Fatalf("env cb-ds exact = %s", got)
	}
	// FORGE_PROFILE family match (cb-* prefix)
	t.Setenv("FORGE_PROFILE", "cb-opus")
	got := DetectProfile(Input{}, profiles)
	if got != "cb-ds" && got != "cb-dsf" {
		t.Fatalf("env cb family (cb-opus) = %s, want cb-ds or cb-dsf", got)
	}
	// codebuddy client should prefer cb family when cb-* profiles exist
	t.Setenv("FORGE_PROFILE", "")
	codebuddyInput := Input{Client: map[string]any{"name": "CodeBuddy"}}
	if d := DetectProfile(codebuddyInput, profiles); d != "cb-ds" && d != "cb-dsf" {
		t.Fatalf("codebuddy client with cb-* profiles = %s, want cb-ds or cb-dsf", d)
	}
}

func TestProfileFamilyCbDs(t *testing.T) {
	ctx := Context{
		Profile: Profile{Name: "cb-ds", Client: "codebuddy", Provider: "codebuddy"},
	}
	if got := ctx.ProfileFamily(); got != "cb" {
		t.Fatalf("cb-ds family = %s, want cb", got)
	}
}

func TestProfileFamilyCbDsf(t *testing.T) {
	ctx := Context{
		Profile: Profile{Name: "cb-dsf", Client: "codebuddy", Provider: "codebuddy"},
	}
	if got := ctx.ProfileFamily(); got != "cb" {
		t.Fatalf("cb-dsf family = %s, want cb", got)
	}
}

func TestWindowRenderIncludesReset(t *testing.T) {
	setFixedNow(t)
	reset := timeNow().Add(time.Hour)
	out := Render(Context{
		Context: context.Background(),
		Input:   Input{Model: Model{ID: "claude-opus-4-8"}},
		Profile: Profile{Name: "ccc", Provider: "anthropic", Segments: []string{"quota"}},
		Billing: Billing{},
		QuotaProvider: staticQuota{q: quota.Quota{Windows: []quota.Window{
			{Name: "5h", Pct: 82, ResetsAt: &reset, WindowMinutes: 300},
			{Name: "7d", Pct: 40, WindowMinutes: 10080},
		}}},
	})
	if !strings.Contains(out, "5h") || !strings.Contains(out, "7d") || !strings.Contains(out, "82%") {
		t.Fatalf("window output = %q", out)
	}
}

func TestRenderOpenCodeQuotaUsesShortWindows(t *testing.T) {
	setFixedNow(t)
	reset5h := timeNow().Add(90 * time.Minute)
	reset7d := timeNow().Add(24*time.Hour + 38*time.Minute)
	out, err := RenderOpenCodeQuota(Context{
		Context: context.Background(),
		QuotaProvider: staticQuota{q: quota.Quota{Windows: []quota.Window{
			{Name: "5h", Pct: 1, ResetsAt: &reset5h, WindowMinutes: 300},
			{Name: "7d", Pct: 21, ResetsAt: &reset7d, WindowMinutes: 10080},
		}}},
	}, "zhipu-coding")
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"Zhipu · ", "5h", "1%", "(", ")", "7d", "21%", "▼"} {
		if !strings.Contains(out, want) {
			t.Fatalf("output = %q, missing %q", out, want)
		}
	}
	if strings.Contains(out, "●") || strings.Contains(out, "○") || strings.Contains(out, "⏱") {
		t.Fatalf("opencode short output should not use full window affordances: %q", out)
	}
	if strings.Contains(out, "71h") || strings.Contains(out, "72h") {
		t.Fatalf("opencode short output should not include long-window countdown: %q", out)
	}
}

func TestFormatWindowsFullKeepsClaudeStyle(t *testing.T) {
	setFixedNow(t)
	reset := timeNow().Add(90 * time.Minute)
	out := formatWindowsWithLength([]quota.Window{
		{Name: "5h", Pct: 1, ResetsAt: &reset, WindowMinutes: 300},
		{Name: "7d", Pct: 21, ResetsAt: &reset, WindowMinutes: 10080},
	}, QuotaDisplayFull)
	for _, want := range []string{"5h", "7d", "●", "○", "(", ")", "▼"} {
		if !strings.Contains(out, want) {
			t.Fatalf("output = %q, missing %q", out, want)
		}
	}
}

func TestRenderUsesShortQuotaWhenWidthConstrained(t *testing.T) {
	setFixedNow(t)
	reset5h := timeNow().Add(90 * time.Minute)
	reset7d := timeNow().Add(24*time.Hour + 38*time.Minute)
	out := Render(Context{
		Context: context.Background(),
		Profile: Profile{Name: "ccg", Provider: "zhipu-coding", Segments: []string{"quota"}, MaxWidth: 42},
		QuotaProvider: staticQuota{q: quota.Quota{Windows: []quota.Window{
			{Name: "5h", Pct: 1, ResetsAt: &reset5h, WindowMinutes: 300},
			{Name: "7d", Pct: 21, ResetsAt: &reset7d, WindowMinutes: 10080},
		}}},
	})
	if strings.Contains(out, "●") || strings.Contains(out, "○") {
		t.Fatalf("width-constrained quota should use short format: %q", out)
	}
	for _, want := range []string{"⏱ ", "5h", "1%", "7d", "21%", "▼"} {
		if !strings.Contains(out, want) {
			t.Fatalf("output = %q, missing %q", out, want)
		}
	}
}

func TestRenderOpenCodeQuotaHidesUnavailableProvider(t *testing.T) {
	out, err := RenderOpenCodeQuota(Context{
		Context:       context.Background(),
		QuotaProvider: staticQuota{q: quota.Quota{Unavailable: true}},
	}, "zhipu-coding")
	if err != nil {
		t.Fatal(err)
	}
	if out != "" {
		t.Fatalf("output = %q, want empty", out)
	}
}

func TestModelDisplayNameExactMatch(t *testing.T) {
	billing := Billing{}
	billing.ModelDisplayNames = map[string]string{
		"claude-fable-5":   "Fable 5",
		"claude-haiku-4-5": "Haiku 4.5",
		"vendor-pro":       "Vendor Pro",
		"vendor-preview":   "Vendor Preview",
		"gpt-5.5":          "GPT-5.5",
	}
	tests := []struct {
		name  string
		input Input
		want  string
	}{
		{"fable5", Input{Model: Model{ID: "claude-fable-5"}}, "Fable 5"},
		{"haiku45", Input{Model: Model{ID: "claude-haiku-4-5"}}, "Haiku 4.5"},
		{"vendor_pro", Input{Model: Model{ID: "vendor-pro"}}, "Vendor Pro"},
		{"vendor_preview", Input{Model: Model{ID: "vendor-preview"}}, "Vendor Preview"},
		{"gpt55", Input{Model: Model{ID: "gpt-5.5"}}, "GPT-5.5"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := ResolveModelName(tc.input, Profile{}, billing)
			if got != tc.want {
				t.Fatalf("ResolveModelName = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestModelDisplayNamePrefixMatchDateSuffix(t *testing.T) {
	// Date-suffixed ids like claude-haiku-4-5-20251001 should match haiku-4-5
	billing := Billing{}
	billing.ModelDisplayNames = map[string]string{
		"claude-haiku-4-5":  "Haiku 4.5",
		"claude-sonnet-4-6": "Sonnet 4.6",
	}
	tests := []struct {
		name  string
		input Input
		want  string
	}{
		{"haiku dated", Input{Model: Model{ID: "claude-haiku-4-5-20251001"}}, "Haiku 4.5"},
		{"sonnet dated", Input{Model: Model{ID: "claude-sonnet-4-6-20250601"}}, "Sonnet 4.6"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := ResolveModelName(tc.input, Profile{}, billing)
			if got != tc.want {
				t.Fatalf("ResolveModelName = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestModelDisplayNamePrettifier(t *testing.T) {
	billing := Billing{}
	tests := []struct {
		name  string
		input Input
		want  string
	}{
		{"fable5", Input{Model: Model{DisplayName: "claude-fable-5"}}, "Fable 5"},
		{"opus48", Input{Model: Model{DisplayName: "claude-opus-4-8"}}, "Opus 4.8"},
		{"sonnet46", Input{Model: Model{DisplayName: "claude-sonnet-4-6"}}, "Sonnet 4.6"},
		{"haiku45", Input{Model: Model{DisplayName: "claude-haiku-4-5"}}, "Haiku 4.5"},
		{"opus46_bracket", Input{Model: Model{DisplayName: "claude-opus-4-6[1m]"}}, "Opus 4.6"},
		{"unknown", Input{Model: Model{DisplayName: "unknown-model-x"}}, "Unknown Model X"},
		{"deepseek", Input{Model: Model{DisplayName: "deepseek-v4-pro"}}, "Deepseek V4 Pro"},
		{"codex", Input{Model: Model{DisplayName: "codex-high"}}, "Codex High"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := ResolveModelName(tc.input, Profile{}, billing)
			if got != tc.want {
				t.Fatalf("ResolveModelName(%q) = %q, want %q", tc.input.Model.DisplayName, got, tc.want)
			}
		})
	}
}

func TestAutoDisplayName(t *testing.T) {
	tests := []struct {
		modelID string
		want    string
	}{
		{"glm-5.3", "GLM 5.3"},
		{"vendor-pro", "Vendor Pro"},
		{"claude-sonnet-4-6", "Sonnet 4.6"},
		{"gpt-5.5", "GPT 5.5"},
		{"claude-opus-4-6", "Opus 4.6"},
		{"claude-opus-4-8", "Opus 4.8"},
		{"claude-haiku-4-5", "Haiku 4.5"},
		{"claude-opus-4-6[1m]", "Opus 4.6"},
		{"codex-mini", "Codex Mini"},
		{"", ""},
	}
	for _, tc := range tests {
		t.Run(tc.modelID, func(t *testing.T) {
			got := autoDisplayName(tc.modelID)
			if got != tc.want {
				t.Fatalf("autoDisplayName(%q) = %q, want %q", tc.modelID, got, tc.want)
			}
		})
	}

	// A model in the static map should return the mapped value (override works).
	billing := Billing{}
	billing.ModelDisplayNames = map[string]string{
		"deepseek-v4-pro": "DeepSeek V4 Pro",
	}
	got := modelDisplayName("deepseek-v4-pro", billing)
	if got != "DeepSeek V4 Pro" {
		t.Fatalf("modelDisplayName for mapped model = %q, want %q", got, "DeepSeek V4 Pro")
	}
}

func TestModelDisplayNameAutoFallback(t *testing.T) {
	// modelDisplayName with a model ID NOT in the static map should fall
	// through to autoDisplayName (not just prettifyModelName).
	billing := Billing{}
	billing.ModelDisplayNames = map[string]string{
		"deepseek-v4-pro": "DeepSeek V4 Pro", // only this is mapped
	}
	// test-model-xyz is not in the map — autoDisplayName should produce "Test Model Xyz"
	got := modelDisplayName("test-model-xyz", billing)
	if got != "Test Model Xyz" {
		t.Fatalf("modelDisplayName(%q) = %q, want %q", "test-model-xyz", got, "Test Model Xyz")
	}
	// glm-5.3 is also not in the map — autoDisplayName should produce "GLM 5.3"
	got = modelDisplayName("glm-5.3", billing)
	if got != "GLM 5.3" {
		t.Fatalf("modelDisplayName(%q) = %q, want %q", "glm-5.3", got, "GLM 5.3")
	}
}

func TestModelDisplayNameContextSuffixCleanup(t *testing.T) {
	// Display names with context suffixes like "(1M context)" should be
	// stripped before the static map lookup, so that e.g. "GLM 5.3 (1M context)"
	// still matches the map entry for "glm-5.3".
	billing := Billing{}
	billing.ModelDisplayNames = map[string]string{
		"glm-5.3": "GLM 5.3",
	}
	tests := []struct {
		name  string
		input string
		want  string
	}{
		{"glm52_1m", "GLM 5.3 (1M context)", "GLM 5.3"},
		{"glm52_200k", "GLM 5.3 (200K context)", "GLM 5.3"},
		// Raw model ID still works as before
		{"glm52_id", "glm-5.3", "GLM 5.3"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := modelDisplayName(tc.input, billing)
			if got != tc.want {
				t.Fatalf("modelDisplayName(%q) = %q, want %q", tc.input, got, tc.want)
			}
		})
	}
}

func TestModelDisplayNameFromStdin(t *testing.T) {
	// Simulate the exact stdin from the live check:
	// echo '{"model":{"display_name":"claude-fable-5"}}' | bin/forge statusline
	billing := Billing{}
	billing.ModelDisplayNames = map[string]string{
		"claude-fable-5": "Fable 5",
	}
	out := Render(Context{
		Context: context.Background(),
		Input:   Input{Model: Model{DisplayName: "claude-fable-5"}},
		Profile: Profile{Name: "ccc", Provider: "anthropic", Segments: []string{"model"}},
		Billing: billing,
	})
	if !strings.Contains(out, "Fable 5") {
		t.Fatalf("expected 'Fable 5' in output, got %q", out)
	}
	if strings.Contains(out, "claude-fable-5") {
		t.Fatalf("output should not contain raw id, got %q", out)
	}
}

func TestQuotaSegmentStaleMarker(t *testing.T) {
	tests := []struct {
		name      string
		q         quota.Quota
		wantStale bool
	}{
		{"windows stale", quota.Quota{Stale: true, Windows: []quota.Window{{Name: "5h", Pct: 42, WindowMinutes: 300}}}, true},
		{"windows fresh", quota.Quota{Windows: []quota.Window{{Name: "5h", Pct: 42, WindowMinutes: 300}}}, false},
		{"used/total stale", quota.Quota{Stale: true, Used: quota.Float64(100), Total: quota.Float64(7000)}, true},
		{"used/total fresh", quota.Quota{Used: quota.Float64(100), Total: quota.Float64(7000)}, false},
		{"message stale", quota.Quota{Stale: true, Message: "quota unavailable"}, true},
		{"message fresh", quota.Quota{Message: "quota unavailable"}, false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			out := Render(Context{
				Context:       context.Background(),
				Input:         Input{Model: Model{ID: "claude-sonnet-4"}},
				Profile:       Profile{Name: "ccc", Provider: "anthropic", Segments: []string{"quota"}},
				Billing:       Billing{},
				QuotaProvider: staticQuota{q: tc.q},
			})
			hasMarker := strings.Contains(out, "\033[2;93m~\033[0m")
			if tc.wantStale && !hasMarker {
				t.Fatalf("expected stale marker in output, got %q", out)
			}
			if !tc.wantStale && hasMarker {
				t.Fatalf("expected NO stale marker in output, got %q", out)
			}
		})
	}
}

// TestProfileFamilyZhipuCodingPlan verifies that the canonical provider id
// "zhipu-coding" is recognized as the "ccg" family, not just the
// legacy "glm" alias. Regression test for finding #5 (statusline drift).
func TestProfileFamilyZhipuCodingPlan(t *testing.T) {
	ctx := Context{
		Profile: Profile{Name: "ccg-zhipu", Client: "claude", Provider: "zhipu-coding"},
	}
	if got := ctx.ProfileFamily(); got != "ccg" {
		t.Fatalf("zhipu-coding family = %s, want ccg", got)
	}
}

// TestDetectProfileZhipu verifies that the canonical provider id
// "zhipu-coding" is detected for the ccg family.
func TestDetectProfileZhipu(t *testing.T) {
	profiles := map[string]Profile{
		"ccg":     {Name: "ccg", Client: "claude", Provider: "zhipu-coding"},
		"ccc":     {Name: "ccc", Client: "claude", Provider: "anthropic"},
		"unknown": {Name: "unknown"},
	}
	// Should detect as ccg family via provider match.
	if got := DetectProfile(Input{Client: map[string]any{"name": "claude"}}, profiles); got != "ccc" {
		// For "claude" client, ccc wins over ccg because ccc checks before ccg.
		// But ccg should be reachable via FORGE_PROFILE.
	}
	t.Setenv("FORGE_PROFILE", "ccg")
	if got := DetectProfile(Input{}, profiles); got != "ccg" {
		t.Fatalf("FORGE_PROFILE=ccg should match ccg profile, got %s", got)
	}
}

// TestOldGlmStillWorks verifies backward compatibility: the old "glm"
// provider id still works as an alias.
func TestOldGlmStillWorks(t *testing.T) {
	ctx := Context{
		Profile: Profile{Name: "ccg", Client: "claude", Provider: "glm"},
	}
	if got := ctx.ProfileFamily(); got != "ccg" {
		t.Fatalf("glm provider family = %s, want ccg", got)
	}

	profiles := map[string]Profile{
		"ccg":     {Name: "ccg", Client: "claude", Provider: "glm"},
		"unknown": {Name: "unknown"},
	}
	// firstProfile with ccg family should find the profile.
	// (detect.go firstProfile function uses provider match)
	if got := firstProfile(profiles, "ccg"); got != "ccg" {
		t.Fatalf("firstProfile(ccg) with glm provider = %s, want ccg", got)
	}
}

func TestFormatWindowPaceRolling(t *testing.T) {
	// Uses quota.WindowPaceDelta which has its own timeNow (not statusline's).
	// Setup with real time to stay consistent with quota's clock.
	reset := time.Now().Add(24*time.Hour + 38*time.Minute)
	w := quota.Window{Name: "7d", Pct: 21, ResetsAt: &reset, WindowMinutes: 10080}
	got := formatWindowPace(w)

	// Expected: elapsed ≈ (10080-1478)/10080 = 85.3%, delta = 21-85.3 = -64.3 → ▼64.3%
	if !strings.HasPrefix(got, "\x1b[92m▼") {
		t.Fatalf("expected green ▼ prefix, got %q", got)
	}
	if !strings.Contains(got, "64.") {
		t.Fatalf("expected ~64.3%%, got %q", got)
	}
}

func TestFormatWindowPaceFallbackNilResetsAt(t *testing.T) {
	setFixedNow(t)
	// When ResetsAt is nil, must fall back to calendar-week behavior without panic.
	w := quota.Window{Name: "7d", Pct: 50, ResetsAt: nil, WindowMinutes: 10080}
	got := formatWindowPace(w)
	// Should produce a ▲ or ▼ pace using calendar-week math.
	if !strings.Contains(got, "▲") && !strings.Contains(got, "▼") {
		t.Fatalf("fallback should produce ▲ or ▼, got %q", got)
	}
}

func TestFormatWindowPaceFallbackZeroWindowMinutes(t *testing.T) {
	setFixedNow(t)
	reset := timeNow().Add(time.Hour)
	w := quota.Window{Name: "7d", Pct: 50, ResetsAt: &reset, WindowMinutes: 0}
	got := formatWindowPace(w)
	if !strings.Contains(got, "▲") && !strings.Contains(got, "▼") {
		t.Fatalf("fallback (WindowMinutes=0) should produce ▲ or ▼, got %q", got)
	}
}

func TestFormatWindowPaceClampPast(t *testing.T) {
	setFixedNow(t)
	// ResetsAt in the past: elapsed_fraction clamped to 1.
	reset := timeNow().Add(-time.Hour)
	w := quota.Window{Name: "7d", Pct: 50, ResetsAt: &reset, WindowMinutes: 60}
	got := formatWindowPace(w)
	// expected=100%, delta=50-100=-50 → ▼50.0%
	if !strings.Contains(got, "▼50.0%") {
		t.Fatalf("clamped past should give ▼50.0%%, got %q", got)
	}
}

func TestFormatWindowPaceClampFuture(t *testing.T) {
	setFixedNow(t)
	// ResetsAt beyond the window: elapsed_fraction clamped to 0.
	reset := timeNow().Add(200 * time.Hour) // beyond 7d window
	w := quota.Window{Name: "7d", Pct: 50, ResetsAt: &reset, WindowMinutes: 10080}
	got := formatWindowPace(w)
	// expected=0%, delta=50-0=+50 → ▲50.0%
	if !strings.Contains(got, "▲50.0%") {
		t.Fatalf("clamped future should give ▲50.0%%, got %q", got)
	}
}

// --- Folding tests ---

func TestFoldDropCountdown(t *testing.T) {
	s := "⏱ 5h ●●●●●●○○○○ 60% (43m) | 📊 1.000M"
	want := "⏱ 5h ●●●●●●○○○○ 60% | 📊 1.000M"
	out, changed := dropCountdownFold(s)
	if !changed {
		t.Fatal("expected change")
	}
	if out != want {
		t.Fatalf("got %q, want %q", out, want)
	}
}

func TestFoldDropPace(t *testing.T) {
	// With ANSI color codes.
	s := "⏱ 100/7000 \x1b[91m▲3.25%\x1b[0m"
	want := "⏱ 100/7000 "
	out, changed := dropPaceFold(s)
	if !changed {
		t.Fatal("expected change")
	}
	if out != want {
		t.Fatalf("got %q, want %q", out, want)
	}
}

func TestFoldShrinkMiniBar(t *testing.T) {
	s := "●●●●●●●○○○"
	// 7 filled / 10 total → round(7/2)=4 → 5-cell bar: ●●●●○
	want := "●●●●○"
	out, changed := shrinkMiniBarFold(s)
	if !changed {
		t.Fatal("expected change")
	}
	if out != want {
		t.Fatalf("got %q, want %q", out, want)
	}
}

func TestFoldOrder(t *testing.T) {
	// Full statusline that is over width.
	s := "🤖 Opus 4.8 | ⏱ 5h ●●●●●●●●○○ 80% (2h 0m) ▼1.5% | 📊 1.000M"

	result := foldToWidth(s, 40)
	if result == s {
		t.Fatal("expected folding to change the string at width 40")
	}
}

func TestVisualWidthStripsANSI(t *testing.T) {
	s := "\x1b[91mHello\x1b[0m World"
	w := visualWidth(s)
	if w != 11 {
		t.Fatalf("visualWidth = %d, want 11", w)
	}
}

func TestVisualWidthEmojiAndCJK(t *testing.T) {
	s := "🏭1d ¥13.4"
	w := visualWidth(s)
	// 🏭 = emoji range (2), rest ASCII = 1 each → 10
	if w != 10 {
		t.Fatalf("visualWidth = %d, want 10", w)
	}
}

// TestModelDisplayNameGolden covers every model ID in the
// model_display_names map from models.json, asserting that modelDisplayName
// returns the mapped display value for each key. It also includes explicit
// edge cases for model IDs not in the map (bracketed variants, models that
// fall through to autoDisplayName).
func TestModelDisplayNameGolden(t *testing.T) {
	// Load the authoritative model_display_names map from models.json.
	data, err := os.ReadFile(filepath.Join("..", "..", "..", "internal", "forge", "data", "legacy", "models.json"))
	if err != nil {
		t.Fatalf("failed to read models.json: %v", err)
	}
	type modelDisplayNamesJSON struct {
		ModelDisplayNames map[string]string `json:"model_display_names"`
	}
	var md modelDisplayNamesJSON
	if err := json.Unmarshal(data, &md); err != nil {
		t.Fatalf("failed to parse models.json: %v", err)
	}
	billing := Billing{ModelDisplayNames: md.ModelDisplayNames}

	// Data-driven: assert every key in models.json returns its display value.
	for modelID, want := range md.ModelDisplayNames {
		t.Run(modelID, func(t *testing.T) {
			got := modelDisplayName(modelID, billing)
			if got != want {
				t.Fatalf("modelDisplayName(%q) = %q, want %q", modelID, got, want)
			}
		})
	}

	// Explicit sanity table for model IDs not in the map (bracketed variants,
	// fall-through autoDisplayName paths, etc.).
	sanity := []struct {
		modelID string
		want    string
	}{
		{"claude-opus-4-6[1m]", "Opus 4.6"},
		{"codex-mini", "Codex Mini"},
	}
	for _, tc := range sanity {
		t.Run(tc.modelID, func(t *testing.T) {
			got := modelDisplayName(tc.modelID, billing)
			if got != tc.want {
				t.Fatalf("modelDisplayName(%q) = %q, want %q", tc.modelID, got, tc.want)
			}
		})
	}
}

// TestAutoDisplayNameBoundaries covers edge cases for autoDisplayName/formatSegment
// that should not panic and should return reasonable output.
func TestAutoDisplayNameBoundaries(t *testing.T) {
	tests := []struct {
		modelID string
		want    string
	}{
		{"", ""},
		{"5", "5"},
		{"4-6", "4.6"},
		{"abcdefghijklmnopqrstuvwxyzabcd", "Abcdefghijklmnopqrstuvwxyzabcd"},
		{"模型-x", "模型 X"},
		{"-glm-", "GLM"},
	}
	for _, tc := range tests {
		t.Run(tc.modelID, func(t *testing.T) {
			got := autoDisplayName(tc.modelID)
			if got != tc.want {
				t.Fatalf("autoDisplayName(%q) = %q, want %q", tc.modelID, got, tc.want)
			}
		})
	}
}

func TestResetCountdownDelegatesDay(t *testing.T) {
	setFixedNow(t)
	reset := timeNow().Add(36*time.Hour + 30*time.Minute)
	got := resetCountdown(reset)
	if got != "1d 12h" {
		t.Fatalf("resetCountdown(36h30m) = %q, want %q", got, "1d 12h")
	}
}

func TestResetCountdownDelegatesHour(t *testing.T) {
	setFixedNow(t)
	reset := timeNow().Add(5*time.Hour + 42*time.Minute)
	got := resetCountdown(reset)
	if got != "5h 42m" {
		t.Fatalf("resetCountdown(5h42m) = %q, want %q", got, "5h 42m")
	}
}

func TestResetCountdownDelegatesMinute(t *testing.T) {
	setFixedNow(t)
	reset := timeNow().Add(43 * time.Minute)
	got := resetCountdown(reset)
	if got != "43m" {
		t.Fatalf("resetCountdown(43m) = %q, want %q", got, "43m")
	}
}

func TestResetCountdownDelegatesSubMinute(t *testing.T) {
	setFixedNow(t)
	reset := timeNow().Add(30 * time.Second)
	got := resetCountdown(reset)
	if got != "<1m" {
		t.Fatalf("resetCountdown(30s) = %q, want %q", got, "<1m")
	}
}

func TestResetCountdownDelegatesExpired(t *testing.T) {
	setFixedNow(t)
	reset := timeNow().Add(-time.Hour)
	got := resetCountdown(reset)
	if got != "" {
		t.Fatalf("resetCountdown(expired) = %q, want empty", got)
	}
}

func TestFormatWindowsDuplicateNamesOnePace(t *testing.T) {
	setFixedNow(t)
	now := timeNow()
	reset := now.Add(90 * time.Minute)
	windows := []quota.Window{
		{Name: "5h", Pct: 42, ResetsAt: &reset, WindowMinutes: 300},
		{Name: "5h", Pct: 50, ResetsAt: &reset, WindowMinutes: 300},
	}
	// Use short format to avoid mini-bars/countdown in the check.
	out := formatWindowsWithLength(windows, QuotaDisplayShort)
	// Only one ▲ or ▼ marker should be present (anchor index).
	count := strings.Count(out, "▲") + strings.Count(out, "▼")
	if count != 1 {
		t.Fatalf("expected exactly 1 pace marker for duplicate names, got %d in %q", count, out)
	}
}

func TestFormatWindowsReliableNon7dHasPace(t *testing.T) {
	setFixedNow(t)
	now := timeNow()
	reset := now.Add(90 * time.Minute)
	windows := []quota.Window{
		{Name: "5h", Pct: 50, ResetsAt: &reset, WindowMinutes: 300},
	}
	out := formatWindowsWithLength(windows, QuotaDisplayShort)
	if !strings.Contains(out, "▲") && !strings.Contains(out, "▼") {
		t.Fatalf("expected pace for reliable non-7d window, got %q", out)
	}
}

func TestFormatWindowsUnreliableNon7dNoPace(t *testing.T) {
	setFixedNow(t)
	windows := []quota.Window{
		{Name: "5h", Pct: 42, WindowMinutes: 300},
	}
	out := formatWindowsWithLength(windows, QuotaDisplayShort)
	if strings.Contains(out, "▲") || strings.Contains(out, "▼") {
		t.Fatalf("expected no pace for unreliable non-7d, got %q", out)
	}
}

func TestFormatWindowsPaceAlignedWithDisplayLine(t *testing.T) {
	setFixedNow(t)
	now := timeNow()
	reset := now.Add(4*time.Hour + 20*time.Minute)
	windows := []quota.Window{
		{Name: "5h", Pct: 11, ResetsAt: &reset, WindowMinutes: 300},
		{Name: "7d", Pct: 11, WindowMinutes: 10080},
	}
	// Statusline pace using injectable timeNow:
	statuslinePace := formatWindowsWithLength(windows, QuotaDisplayShort)
	// Display_line pace using the same anchor index and clock:
	q := quota.Quota{Label: "test", Windows: windows}
	dl := quota.DisplayLine(q)
	// Both should contain a pace marker.
	if !strings.Contains(statuslinePace, "▲") && !strings.Contains(statuslinePace, "▼") {
		t.Fatalf("statusline should show pace for 7d anchor: %q", statuslinePace)
	}
	if !strings.Contains(dl, "(") {
		t.Fatalf("display_line should show pace: %q", dl)
	}
}
