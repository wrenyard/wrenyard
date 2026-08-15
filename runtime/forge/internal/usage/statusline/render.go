package statusline

import (
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/usage/quota"
)

// timeNow is injectable for testing; production code calls time.Now.
var timeNow = time.Now

func Render(ctx Context) string {
	if len(ctx.Profile.Segments) == 0 {
		ctx.Profile.Segments = []string{"model", "cost", "quota", "usage", "context"}
	}
	maxWidth := resolveMaxWidth(ctx)
	length := ctx.QuotaDisplayLength.normalized()
	result := renderWithQuotaLength(ctx, length)

	// CC-style statuslines render full quota windows by default, then step down
	// through shared density variants when the terminal reports a narrower width.
	if maxWidth > 0 && ctx.QuotaDisplayLength == "" && visualWidth(result) > maxWidth {
		for _, fallbackLength := range []QuotaDisplayLength{QuotaDisplayMedium, QuotaDisplayShort} {
			candidate := renderWithQuotaLength(ctx, fallbackLength)
			if strings.TrimSpace(candidate) == "" {
				continue
			}
			result = candidate
			if visualWidth(result) <= maxWidth {
				break
			}
		}
	}

	if maxWidth > 0 && visualWidth(result) > maxWidth {
		result = foldToWidth(result, maxWidth)
	}
	return result
}

func renderWithQuotaLength(ctx Context, length QuotaDisplayLength) string {
	ctx.QuotaDisplayLength = length.normalized()
	registry := map[string]Segment{
		"model":   modelSegment{},
		"cost":    costSegment{},
		"quota":   quotaSegment{},
		"usage":   usageSegment{},
		"context": contextSegment{},
	}
	parts := []string{}
	for _, name := range ctx.Profile.Segments {
		seg, ok := registry[name]
		if !ok {
			continue
		}
		text, err := seg.Render(ctx)
		if err == nil && strings.TrimSpace(text) != "" {
			parts = append(parts, text)
		}
	}
	if len(parts) == 0 {
		return Fallback()
	}
	return strings.Join(parts, " | ")
}

func Fallback() string {
	return "🤖 unknown | 📊 0.000M | 🧠 0.0% · 200K"
}

// --- Priority-based folding ---

var foldTransforms = []struct {
	name string
	fold func(string) (string, bool)
}{
	{"drop countdown", dropCountdownFold},
	{"drop pace", dropPaceFold},
	{"shrink mini-bar", shrinkMiniBarFold},
}

// dropCountdownFold removes reset-countdown suffixes like (1d 12h), (1h 30m), (43m), (&lt;1m).
var countdownRE = regexp.MustCompile(`\s+\((?:\d+d \d+h|\d+h \d+m|\d+m|<1m)\)`)

func dropCountdownFold(s string) (string, bool) {
	out := countdownRE.ReplaceAllString(s, "")
	return out, out != s
}

// dropPaceFold removes ▲X.X% or ▼X.X% (with ANSI color codes).
var paceRE = regexp.MustCompile(`\x1b\[9[12]m[▲▼][\d.]+%\x1b\[0m`)

func dropPaceFold(s string) (string, bool) {
	out := paceRE.ReplaceAllString(s, "")
	return out, out != s
}

// shrinkMiniBarFold shrinks 10-cell mini-bars to 5 cells.
var miniBarRE = regexp.MustCompile(`[●○]{10}`)

func shrinkMiniBarFold(s string) (string, bool) {
	out := miniBarRE.ReplaceAllStringFunc(s, func(m string) string {
		filled := strings.Count(m, "●")
		newFilled := int(math.Round(float64(filled) / 2))
		if newFilled < 0 {
			newFilled = 0
		}
		if newFilled > 5 {
			newFilled = 5
		}
		return strings.Repeat("●", newFilled) + strings.Repeat("○", 5-newFilled)
	})
	return out, out != s
}

// resolveMaxWidth returns the configured max width or 0 if disabled.
func resolveMaxWidth(ctx Context) int {
	if ctx.Profile.MaxWidth > 0 {
		return ctx.Profile.MaxWidth
	}
	if cols := strings.TrimSpace(os.Getenv("COLUMNS")); cols != "" {
		if n, err := strconv.Atoi(cols); err == nil && n > 0 {
			return n
		}
	}
	return 0
}

// visualWidth returns the visible width of s, stripping ANSI escapes.
// Emoji and CJK characters are counted as 2 cells using a heuristic.
func visualWidth(s string) int {
	// Strip ANSI escape sequences.
	ansiRE := regexp.MustCompile(`\x1b\[[0-9;]*m`)
	clean := ansiRE.ReplaceAllString(s, "")
	w := 0
	for _, r := range clean {
		if r > 0x2E80 && r < 0x30000 { // CJK range + emoji range
			w += 2
		} else if r > 0x2000 && r < 0x2B00 {
			w += 2
		} else {
			w++
		}
	}
	return w
}

// foldToWidth applies fold transforms in order until the string fits within maxWidth.
func foldToWidth(s string, maxWidth int) string {
	if visualWidth(s) <= maxWidth {
		return s
	}
	for _, ft := range foldTransforms {
		result, changed := ft.fold(s)
		if !changed {
			continue
		}
		if visualWidth(result) <= maxWidth {
			return result
		}
		s = result
	}
	return s
}

type modelSegment struct{}

func (modelSegment) Render(ctx Context) (string, error) {
	return "🤖 " + ResolveModelName(ctx.Input, ctx.Profile, ctx.Billing), nil
}

type costSegment struct{}

func (costSegment) Render(ctx Context) (string, error) {
	return "", nil
}

type quotaSegment struct{}

func (quotaSegment) Render(ctx Context) (string, error) {
	if ctx.QuotaProvider == nil {
		return "", nil
	}
	// Prefer the dedicated quota context for network fetches, falling back to the
	// render context (which may have a tighter deadline shared across all segments).
	qctx := ctx.QuotaContext
	if qctx == nil {
		qctx = ctx.Context
	}
	q, err := ctx.QuotaProvider.Fetch(qctx)
	if err != nil {
		return "", err
	}
	stale := ""
	if q.Stale {
		stale = " " + DimYellow + "~" + Reset
	}
	if len(q.Windows) > 0 {
		return "⏱ " + formatWindowsWithLength(q.Windows, ctx.QuotaDisplayLength) + stale, nil
	}
	if q.Used != nil && q.Total != nil && *q.Total > 0 {
		return fmt.Sprintf("⏱ %.0f/%.0f %s", *q.Used, *q.Total, formatMonthPace(*q.Used, *q.Total)) + stale, nil
	}
	if q.Message != "" {
		return "⏱ " + q.Message + stale, nil
	}
	return "", nil
}

func RenderOpenCodeQuota(ctx Context, label string) (string, error) {
	if ctx.QuotaProvider == nil || label == "" {
		return "", nil
	}
	qctx := ctx.QuotaContext
	if qctx == nil {
		qctx = ctx.Context
	}
	q, err := ctx.QuotaProvider.Fetch(qctx)
	if err != nil || q.Unavailable {
		return "", err
	}
	if len(q.Windows) > 0 {
		return openCodeQuotaLabel(label) + " · " + formatWindowsWithLength(q.Windows, QuotaDisplayShort), nil
	}
	if q.Used != nil && q.Total != nil && *q.Total > 0 {
		pct := *q.Used / *q.Total * 100
		return fmt.Sprintf("%s · %.0f/%.0f %.1f%%", openCodeQuotaLabel(label), *q.Used, *q.Total, pct), nil
	}
	return "", nil
}

func openCodeQuotaLabel(label string) string {
	switch strings.ToLower(strings.TrimSpace(label)) {
	case "zhipu-coding":
		return "Zhipu"
	case "kimi-coding":
		return "Kimi"
	case "codex-spark":
		return "Codex Spark"
	case "codex":
		return "Codex"
	default:
		return label
	}
}

type usageSegment struct{}

func (usageSegment) Render(ctx Context) (string, error) {
	rawSession, _, transcript := sessionAndTranscript(ctx.Input)
	tokens, cache := transcriptUsage(rawSession, transcript)
	out := fmt.Sprintf("📊 %.3fM", float64(tokens)/1_000_000)
	if cache != nil {
		out += " " + colorCache(*cache)
	}
	return out, nil
}

type contextSegment struct{}

func (contextSegment) Render(ctx Context) (string, error) {
	_, pct, size := contextUsage(ctx.Input, ctx.Billing)
	color := ""
	if pct > 80 {
		color = Red
	}
	value := fmt.Sprintf("%.1f%%", pct)
	if color != "" {
		value = color + value + Reset
	}
	return fmt.Sprintf("🧠 %s · %s", value, formatTokensShort(size)), nil
}

func (ctx Context) ProfileFamily() string {
	name := strings.ToLower(ctx.Profile.Name)
	provider := strings.ToLower(ctx.Profile.Provider)
	client := strings.ToLower(ctx.Profile.Client)
	switch {
	case strings.HasPrefix(name, "cb-") || client == "codebuddy" || provider == "codebuddy":
		return "cb"
	case name == "ccg" || provider == "zhipu-coding":
		return "ccg"
	case provider == "anthropic":
		return "claude-native"
	default:
		return name
	}
}

func ResolveModelName(input Input, profile Profile, billing Billing) string {
	for _, candidate := range []string{input.Model.ID, input.Model.DisplayName} {
		if candidate == "" {
			continue
		}
		if display := modelDisplayName(candidate, billing); display != "" {
			return display
		}
		if key := canonicalModelKey(candidate); key != "" {
			if override := profile.ModelOverrides[strings.ToLower(key)]; override != "" {
				if display := modelDisplayName(override, billing); display != "" {
					return display
				}
				return normalizeModel(override)
			}
		}
	}
	if input.Model.ID != "" {
		return modelDisplayName(input.Model.ID, billing)
	}
	if input.Model.DisplayName != "" {
		return modelDisplayName(input.Model.DisplayName, billing)
	}
	return "unknown"
}

// modelDisplayName looks up a model name in the billing display names map,
// trying exact match first, then prefix match for date-suffixed ids, then
// falling back to a general prettifier.
func modelDisplayName(name string, billing Billing) string {
	// Try raw name first (lowered but not normalized)
	raw := strings.ToLower(strings.TrimSpace(name))
	if display := billing.ModelDisplayNames[raw]; display != "" {
		return display
	}
	// Try normalized name (strips brackets, etc.)
	normalized := strings.ToLower(normalizeModel(name))
	if normalized != raw && billing.ModelDisplayNames[normalized] != "" {
		return billing.ModelDisplayNames[normalized]
	}
	// Prefix match for date-suffixed ids like claude-haiku-4-5-20251001
	// Check against both raw and normalized forms
	for _, candidate := range []string{raw, normalized} {
		for key, display := range billing.ModelDisplayNames {
			if strings.HasPrefix(candidate, key) {
				suffix := candidate[len(key):]
				// suffix should start with "-" followed by 8 date digits
				if strings.HasPrefix(suffix, "-") && len(suffix) == 9 && isAllDigits(suffix[1:]) {
					return display
				}
			}
		}
	}
	// Strip context-window parentheticals from display names (e.g. "(1M context)")
	// and re-check the static map before falling through to autoDisplayName.
	if cleaned := cleanDisplayName(raw); cleaned != raw {
		if display := billing.ModelDisplayNames[cleaned]; display != "" {
			return display
		}
	}
	// Auto-generated display name from model ID (use normalized form to strip
	// brackets like [1m] first)
	if display := autoDisplayName(normalized); display != "" {
		return display
	}
	// Last-resort prettifier (strips known provider prefixes)
	if prettified := prettifyModelName(name); prettified != "" {
		return prettified
	}
	return normalized
}

// contextSuffixRE matches context window parentheticals at the end of display
// names, e.g. "(1M context)", "(200K context)", "(128K context)".
var contextSuffixRE = regexp.MustCompile(`\s*\(\d+[kKmM]?\s*context\)\s*$`)

// cleanDisplayName strips context window parentheticals from display names
// and converts spaces to dashes, returning a model ID suitable for map lookup (lowered).
func cleanDisplayName(name string) string {
	s := strings.TrimSpace(contextSuffixRE.ReplaceAllString(strings.ToLower(name), ""))
	s = strings.ReplaceAll(s, " ", "-")
	return s
}

// autoDisplayName generates a display name from a model ID by splitting on "-"
// and formatting each segment. The static model_display_names map in models.json
// takes precedence; this is the fallback for model IDs not in that map.
//
// Adjacent pure-number segments are joined with "." to produce version strings
// like "4.6" instead of "4 6".
func autoDisplayName(modelID string) string {
	modelID = strings.TrimSpace(modelID)
	if modelID == "" {
		return ""
	}
	if normalized := normalizeModel(modelID); strings.HasPrefix(strings.ToLower(normalized), "claude-") {
		modelID = normalized[len("claude-"):]
	}
	parts := strings.Split(modelID, "-")
	result := make([]string, 0, len(parts))
	for _, p := range parts {
		if p == "" {
			continue
		}
		result = append(result, formatSegment(p))
	}
	return joinWithNumberDots(result)
}

// joinWithNumberDots joins formatted segments with spaces, but consecutive
// pure-number segments are joined with "." to produce version strings like
// "4.6" instead of "4 6".
func joinWithNumberDots(segments []string) string {
	if len(segments) == 0 {
		return ""
	}
	out := make([]string, 0, len(segments))
	i := 0
	for i < len(segments) {
		// Collect consecutive pure-number segments.
		j := i
		for j < len(segments) && isPureNumber(segments[j]) {
			j++
		}
		if j > i {
			// Join the run of number segments with ".".
			out = append(out, strings.Join(segments[i:j], "."))
		} else {
			out = append(out, segments[i])
			j = i + 1
		}
		i = j
	}
	return strings.Join(out, " ")
}

// isPureNumber returns true if s is solely composed of digits (no dots, letters,
// or other chars). This is checked on already-formatted segments, so numbers
// like "4" and "6" match, but "v4" or "4.5" do not.
func isPureNumber(s string) bool {
	if s == "" {
		return false
	}
	for _, c := range s {
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}

// uppercaseAbbrevs is a whitelist of known acronyms/abbreviations that should
// be rendered in all-caps. Segments that match (case-insensitive) are uppercased.
// Everything else gets title-cased (first letter upper, rest lower).
var uppercaseAbbrevs = map[string]bool{
	"glm": true, "gpt": true, "llm": true, "api": true,
	"mcp": true, "sdk": true, "cli": true,
	"ai": true, "id": true, "url": true, "ide": true,
	"ssr": true, "ssd": true, "cpu": true, "gpu": true,
	"ure": true, "oss": true,
}

// formatSegment formats a single segment of a model ID.
// Rules:
//  1. If the segment (lowercased) is in the abbreviation whitelist → UPPERCASE it.
//  2. Else if version-like (contains digit, only letters/digits/dots) → uppercase leading letters.
//  3. Else → title-case (first letter upper, rest lower).
func formatSegment(s string) string {
	s = strings.ToLower(s)
	if s == "" {
		return s
	}
	// Rule 1: Known abbreviation → UPPERCASE
	if uppercaseAbbrevs[s] {
		return strings.ToUpper(s)
	}
	// Rule 2: Version-like (e.g. v4, 5.2) → uppercase leading letters
	if isVersionLike(s) {
		i := 0
		for i < len(s) && isASCIILetter(s[i]) {
			i++
		}
		if i > 0 {
			return strings.ToUpper(s[:i]) + s[i:]
		}
		return s
	}
	// Rule 3: Title-case
	runes := []rune(s)
	runes[0] = []rune(strings.ToUpper(string(runes[0])))[0]
	return string(runes)
}

// isVersionLike returns true if s contains at least one digit and only
// letters, digits, or dots.
func isVersionLike(s string) bool {
	hasDigit := false
	for _, c := range s {
		if c >= '0' && c <= '9' {
			hasDigit = true
		} else if !((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c == '.') {
			return false
		}
	}
	return hasDigit
}

// isAllLetters returns true if s is non-empty and contains only ASCII letters.
func isAllLetters(s string) bool {
	if s == "" {
		return false
	}
	for _, c := range s {
		if !((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')) {
			return false
		}
	}
	return true
}

// isASCIILetter returns true if c is an ASCII letter.
func isASCIILetter(c byte) bool {
	return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
}

// prettifyModelName converts a raw model id to a human-readable form.
// Strips known provider prefixes, splits on dashes, title-cases words,
// and joins trailing numeric pairs with a dot.
func prettifyModelName(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ""
	}
	raw = normalizeModel(raw)
	// Strip known provider prefixes
	for _, prefix := range []string{"claude-", "deepseek-", "codebuddy-", "codex-"} {
		if strings.HasPrefix(strings.ToLower(raw), prefix) {
			raw = raw[len(prefix):]
			break
		}
	}
	parts := strings.Split(raw, "-")
	if len(parts) == 0 || (len(parts) == 1 && parts[0] == "") {
		return raw
	}
	// Title-case non-numeric parts
	for i, p := range parts {
		if p == "" {
			continue
		}
		if _, err := strconv.Atoi(p); err == nil {
			continue
		}
		parts[i] = strings.ToUpper(p[:1]) + p[1:]
	}
	// Trailing digit pairs: if last two tokens are both numeric, join with dot
	if len(parts) >= 2 {
		last := parts[len(parts)-1]
		secondLast := parts[len(parts)-2]
		_, err1 := strconv.Atoi(last)
		_, err2 := strconv.Atoi(secondLast)
		if err1 == nil && err2 == nil {
			parts = parts[:len(parts)-1]
			parts[len(parts)-1] = secondLast + "." + last
		}
	}
	return strings.Join(parts, " ")
}

// isAllDigits returns true if s is non-empty and contains only digits.
func isAllDigits(s string) bool {
	if s == "" {
		return false
	}
	for _, c := range s {
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}

func normalizeModel(raw string) string {
	s := strings.TrimSpace(raw)
	s = regexp.MustCompile(`\[[^\]]+\]$`).ReplaceAllString(s, "")
	return s
}

func canonicalModelKey(model string) string {
	lower := strings.ToLower(strings.TrimSpace(model))
	lower = regexp.MustCompile(`\[[^\]]+\]$`).ReplaceAllString(lower, "")
	lower = strings.TrimSpace(regexp.MustCompile(`\s*\(1m context\)\s*$`).ReplaceAllString(lower, ""))
	aliases := map[string]string{
		"opus": "claude-opus-4-8", "opus 4.8": "claude-opus-4-8",
		"sonnet": "claude-sonnet-4-6", "sonnet 4.6": "claude-sonnet-4-6",
		"haiku": "claude-haiku-4-5", "haiku 4.5": "claude-haiku-4-5",
	}
	if aliases[lower] != "" {
		return aliases[lower]
	}
	return lower
}

func sessionAndTranscript(input Input) (string, string, string) {
	raw := input.SessionID
	transcript := input.Transcript
	session := raw
	if session == "" && transcript != "" {
		session = strings.TrimSuffix(filepath.Base(transcript), filepath.Ext(transcript))
	}
	return raw, session, transcript
}

func transcriptMatches(rawSession, transcript string) bool {
	if rawSession == "" || transcript == "" {
		return false
	}
	return strings.TrimSuffix(filepath.Base(transcript), filepath.Ext(transcript)) == rawSession
}

func collectTranscriptPaths(transcript string) []string {
	if transcript == "" {
		return nil
	}
	paths := []string{transcript}
	dir := filepath.Dir(transcript)
	stem := strings.TrimSuffix(filepath.Base(transcript), filepath.Ext(transcript))
	sub := filepath.Join(dir, stem, "subagents")
	entries, err := os.ReadDir(sub)
	if err == nil {
		for _, entry := range entries {
			if !entry.IsDir() && strings.HasSuffix(entry.Name(), ".jsonl") {
				paths = append(paths, filepath.Join(sub, entry.Name()))
			}
		}
	}
	sort.Strings(paths)
	return paths
}

func readJSONLines(path string, fn func(map[string]any)) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return
	}
	for _, line := range strings.Split(string(raw), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		var m map[string]any
		if json.Unmarshal([]byte(line), &m) == nil {
			fn(m)
		}
	}
}

func transcriptUsage(rawSession, transcript string) (int, *float64) {
	if !transcriptMatches(rawSession, transcript) {
		return 0, nil
	}
	totalTokens, totalCache, totalInput := 0, 0, 0
	seen := map[string]bool{}
	for _, path := range collectTranscriptPaths(transcript) {
		readJSONLines(path, func(payload map[string]any) {
			message, _ := payload["message"].(map[string]any)
			if message == nil {
				return
			}
			usage, _ := message["usage"].(map[string]any)
			if usage == nil {
				return
			}
			id := stringValue(message["id"])
			if id != "" && seen[id] {
				return
			}
			if id != "" {
				seen[id] = true
			}
			inp := intValue(usage["input_tokens"])
			out := intValue(usage["output_tokens"])
			create := intValue(usage["cache_creation_input_tokens"])
			read := intValue(usage["cache_read_input_tokens"])
			if read == 0 && inp > 0 {
				if rawUsage, _ := message["rawUsage"].(map[string]any); rawUsage != nil {
					hit := intValue(rawUsage["prompt_cache_hit_tokens"])
					if hit > 0 {
						read = hit
						inp = hit + intValue(rawUsage["prompt_cache_miss_tokens"])
					}
				}
			}
			cacheTotal := create + read
			totalTokens += max(inp, cacheTotal) + out
			totalCache += read
			if inp >= read {
				totalInput += inp
			} else {
				totalInput += inp + read
			}
		})
	}
	if totalInput > 0 {
		rate := float64(totalCache) / float64(totalInput)
		return totalTokens, &rate
	}
	return totalTokens, nil
}

func contextUsage(input Input, billing Billing) (int, float64, int) {
	size := contextWindowSize(input, billing)
	cw, _ := input.ContextWindow.(map[string]any)
	if cw == nil {
		return 0, 0, size
	}
	in := intValue(firstAny(cw, "total_input_tokens", "input_tokens"))
	if current, _ := cw["current_usage"].(map[string]any); in == 0 && current != nil {
		in = intValue(current["input_tokens"])
	}
	if in > 0 && size > 0 {
		return in, math.Round(float64(in)/float64(size)*1000) / 10, size
	}
	pct := floatValue(cw["used_percentage"])
	return int(float64(size) * pct / 100), math.Round(pct*10) / 10, size
}

func contextWindowSize(input Input, billing Billing) int {
	if cw, _ := input.ContextWindow.(map[string]any); cw != nil {
		if size := intValue(cw["context_window_size"]); size > 0 {
			return size
		}
	}
	combined := strings.ToLower(input.Model.ID + " " + input.Model.DisplayName)
	if strings.Contains(combined, "1m") {
		if v := billing.ContextWindows["1m"]; v > 0 {
			return v
		}
		return 1_000_000
	}
	if v := billing.ContextWindows["default"]; v > 0 {
		return v
	}
	return 200_000
}

type QuotaDisplayLength string

const (
	QuotaDisplayFull   QuotaDisplayLength = "full"
	QuotaDisplayMedium QuotaDisplayLength = "medium"
	QuotaDisplayShort  QuotaDisplayLength = "short"
)

func (l QuotaDisplayLength) normalized() QuotaDisplayLength {
	switch l {
	case QuotaDisplayMedium, QuotaDisplayShort:
		return l
	default:
		return QuotaDisplayFull
	}
}

func formatWindows(windows []quota.Window) string {
	return formatWindowsWithLength(windows, QuotaDisplayFull)
}

func formatWindowsWithLength(windows []quota.Window, length QuotaDisplayLength) string {
	length = length.normalized()
	anchorIdx := quota.SelectPaceAnchorIndex(windows)
	parts := []string{}
	for i, w := range windows {
		color := ""
		if w.Pct > 80 {
			color = Red
		}
		pct := fmt.Sprintf("%.0f%%", w.Pct)
		if color != "" {
			pct = color + pct + Reset
		}
		part := ""
		switch length {
		case QuotaDisplayShort:
			part = fmt.Sprintf("%s %s", w.Name, pct)
		case QuotaDisplayMedium:
			part = fmt.Sprintf("%s %s %s", w.Name, miniBar(w.Pct, 5), pct)
		default:
			part = fmt.Sprintf("%s %s %s", w.Name, miniBar(w.Pct, 10), pct)
		}
		if i == anchorIdx {
			if length == QuotaDisplayShort {
				part += " " + formatWindowPaceCompact(w)
			} else {
				part += " " + formatWindowPace(w)
			}
		}
		if showWindowCountdown(w, length) {
			if suffix := resetCountdown(*w.ResetsAt); suffix != "" {
				part += " (" + suffix + ")"
			}
		}
		parts = append(parts, part)
	}
	return strings.Join(parts, " · ")
}

func showWindowCountdown(w quota.Window, length QuotaDisplayLength) bool {
	if w.ResetsAt == nil {
		return false
	}
	if length != QuotaDisplayShort {
		return true
	}
	return w.WindowMinutes > 0 && w.WindowMinutes <= 24*60
}

func miniBar(pct float64, width int) string {
	filled := int(math.Round(pct / 100 * float64(width)))
	if filled < 0 {
		filled = 0
	}
	if filled > width {
		filled = width
	}
	return strings.Repeat("●", filled) + strings.Repeat("○", width-filled)
}

func formatMonthPace(used, total float64) string {
	if total <= 0 {
		return ""
	}
	now := time.Now()
	start := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, now.Location())
	end := start.AddDate(0, 1, 0)
	delta := (used/total - now.Sub(start).Seconds()/end.Sub(start).Seconds()) * 100
	color := Green
	sign := ""
	if delta >= 0 {
		color = Red
		sign = "+"
	}
	return fmt.Sprintf("%s%s%.2f%%%s", color, sign, delta, Reset)
}

func formatMonthPacePlain(used, total float64) string {
	return formatMonthPacePlainFixed(used, total, 2)
}

func formatMonthPacePlainFixed(used, total float64, decimals int) string {
	if total <= 0 {
		return ""
	}
	now := time.Now()
	start := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, now.Location())
	end := start.AddDate(0, 1, 0)
	delta := (used/total - now.Sub(start).Seconds()/end.Sub(start).Seconds()) * 100
	sign := ""
	if delta >= 0 {
		sign = "+"
	}
	format := "%s%." + strconv.Itoa(decimals) + "f%%"
	return fmt.Sprintf(format, sign, delta)
}

func formatWindowPace(w quota.Window) string {
	return formatWindowPaceWithDecimals(w, 1)
}

func formatWindowPaceCompact(w quota.Window) string {
	return formatWindowPaceWithDecimals(w, 0)
}

func formatWindowPaceWithDecimals(w quota.Window, decimals int) string {
	delta := quota.WindowPaceDeltaAt(w, timeNow())
	if delta >= 0 {
		return fmt.Sprintf("%s▲%.*f%%%s", Red, decimals, delta, Reset)
	}
	return fmt.Sprintf("%s▼%.*f%%%s", Green, decimals, -delta, Reset)
}

func resetCountdown(t time.Time) string {
	return quota.FormatResetDuration(t.Sub(timeNow()))
}

func colorCache(rate float64) string {
	pct := rate * 100
	color := Yellow
	if pct >= 95 {
		color = Green
	} else if pct < 80 {
		color = Red
	}
	return fmt.Sprintf("⚡%s%.1f%%%s", color, pct, Reset)
}

func formatTokensShort(n int) string {
	if n >= 1_000_000 {
		v := float64(n) / 1_000_000
		if math.Abs(v-math.Round(v)) < 0.001 {
			return fmt.Sprintf("%.0fM", v)
		}
		return fmt.Sprintf("%.1fM", v)
	}
	if n >= 1000 {
		v := float64(n) / 1000
		if math.Abs(v-math.Round(v)) < 0.001 {
			return fmt.Sprintf("%.0fK", v)
		}
		return fmt.Sprintf("%.1fK", v)
	}
	return strconv.Itoa(n)
}

func homeDir(home string) string {
	if home != "" {
		return home
	}
	h, _ := os.UserHomeDir()
	return h
}

func firstAny(m map[string]any, keys ...string) any {
	for _, key := range keys {
		if v, ok := m[key]; ok {
			return v
		}
	}
	return nil
}

func stringValue(v any) string {
	switch x := v.(type) {
	case string:
		return x
	case fmt.Stringer:
		return x.String()
	default:
		return strings.Trim(strings.TrimSpace(fmt.Sprint(v)), "<nil>")
	}
}

func intValue(v any) int {
	return int(floatValue(v))
}

func floatValue(v any) float64 {
	switch x := v.(type) {
	case float64:
		return x
	case float32:
		return float64(x)
	case int:
		return float64(x)
	case int64:
		return float64(x)
	case json.Number:
		n, _ := x.Float64()
		return n
	case string:
		n, _ := strconv.ParseFloat(strings.TrimSpace(x), 64)
		return n
	default:
		return 0
	}
}
