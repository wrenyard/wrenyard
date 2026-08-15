package quota

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"
)

type KimiProvider struct {
	Token  string
	URL    string
	Client *http.Client
}

func (p KimiProvider) Name() string { return "kimi-coding" }

func (p KimiProvider) Fetch(ctx context.Context) (Quota, error) {
	token := strings.TrimSpace(p.Token)
	if token == "" {
		return Quota{}, errors.New("kimi bearer token unavailable")
	}
	url := strings.TrimSpace(p.URL)
	if url == "" {
		url = "https://api.kimi.com/coding/v1/usages"
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return Quota{}, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "forge")
	client := p.Client
	if client == nil {
		client = &http.Client{Timeout: 5 * time.Second}
	}
	resp, err := client.Do(req)
	if err != nil {
		return Quota{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return Quota{}, errors.New(resp.Status)
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return Quota{}, err
	}
	q, err := ParseKimiQuota(body)
	if err != nil {
		return Quota{}, err
	}
	q.Provider = p.Name()
	q.Source = "api"
	q.FetchedAt = time.Now()
	return q, nil
}

func ParseKimiQuota(raw []byte) (Quota, error) {
	var root map[string]any
	if err := json.Unmarshal(raw, &root); err != nil {
		return Quota{}, err
	}
	usage, limits := kimiUsageAndLimits(root)
	q := Quota{}
	var weekly *Window
	if detail, ok := usage.(map[string]any); ok {
		if used, total, reset, ok := parseKimiUsageDetail(detail); ok {
			q.Used = Float64(used)
			q.Total = Float64(total)
			w := Window{Name: "7d", Pct: used / total * 100, WindowMinutes: 10080, ResetsAt: reset}
			weekly = &w
		}
	}
	for _, item := range limits {
		if w, ok := parseKimiLimitWindow(item); ok {
			q.Windows = append(q.Windows, w)
		}
	}
	if weekly != nil {
		q.Windows = append(q.Windows, *weekly)
	}
	if monthly, ok := parseKimiTotalQuota(kimiTotalQuota(root)); ok {
		q.Windows = append(q.Windows, monthly)
	}
	if q.Used == nil && len(q.Windows) == 0 {
		return Quota{}, errors.New("kimi usage unavailable")
	}
	return q, nil
}

func kimiTotalQuota(root map[string]any) any {
	if total := root["totalQuota"]; total != nil {
		return total
	}
	usages, _ := root["usages"].([]any)
	for _, item := range usages {
		m, ok := item.(map[string]any)
		if !ok {
			continue
		}
		scope := strings.ToUpper(toString(m["scope"]))
		if scope != "" && scope != "FEATURE_CODING" {
			continue
		}
		if total := m["totalQuota"]; total != nil {
			return total
		}
	}
	return nil
}

func kimiUsageAndLimits(root map[string]any) (any, []any) {
	if usage := root["usage"]; usage != nil {
		limits, _ := root["limits"].([]any)
		return usage, limits
	}
	usages, _ := root["usages"].([]any)
	for _, item := range usages {
		m, ok := item.(map[string]any)
		if !ok {
			continue
		}
		scope := strings.ToUpper(toString(m["scope"]))
		if scope != "" && scope != "FEATURE_CODING" {
			continue
		}
		limits, _ := m["limits"].([]any)
		return m["detail"], limits
	}
	return nil, nil
}

func parseKimiUsageDetail(detail map[string]any) (float64, float64, *time.Time, bool) {
	limit, ok := coerceFloat(firstPresent(detail, "limit", "total"))
	if !ok || limit <= 0 {
		return 0, 0, nil, false
	}
	used, usedOK := coerceFloat(firstPresent(detail, "used", "usage"))
	if !usedOK {
		if remaining, ok := coerceFloat(detail["remaining"]); ok {
			used = limit - remaining
			usedOK = true
		}
	}
	if !usedOK {
		return 0, 0, nil, false
	}
	if used < 0 {
		used = 0
	}
	return used, limit, parseTimeAny(firstPresent(detail, "resetTime", "reset_time", "resetsAt", "resets_at")), true
}

func parseKimiLimitWindow(value any) (Window, bool) {
	m, ok := value.(map[string]any)
	if !ok {
		return Window{}, false
	}
	detail, _ := m["detail"].(map[string]any)
	if detail == nil {
		detail = m
	}
	used, total, reset, ok := parseKimiUsageDetail(detail)
	if !ok || total <= 0 {
		return Window{}, false
	}
	minutes := kimiWindowMinutes(m["window"])
	if minutes == 0 {
		minutes = 300
	}
	return Window{
		Name:          windowName(minutes),
		Pct:           used / total * 100,
		WindowMinutes: minutes,
		ResetsAt:      reset,
	}, true
}

func parseKimiTotalQuota(value any) (Window, bool) {
	m, ok := value.(map[string]any)
	if !ok {
		return Window{}, false
	}
	detail, _ := m["detail"].(map[string]any)
	if detail == nil {
		detail = m
	}
	used, total, reset, ok := parseKimiUsageDetail(detail)
	if !ok || total <= 0 {
		return Window{}, false
	}
	minutes := kimiWindowMinutes(m["window"])
	if minutes == 0 {
		minutes = 30 * 24 * 60
	}
	return Window{
		Name:          "1mo",
		Pct:           used / total * 100,
		WindowMinutes: minutes,
		ResetsAt:      reset,
	}, true
}

func kimiWindowMinutes(value any) int {
	m, ok := value.(map[string]any)
	if !ok {
		return 0
	}
	duration, ok := coerceFloat(m["duration"])
	if !ok || duration <= 0 {
		return 0
	}
	unit := strings.ToUpper(toString(m["timeUnit"]))
	switch unit {
	case "TIME_UNIT_HOUR", "HOUR", "HOURS":
		return int(duration * 60)
	case "TIME_UNIT_DAY", "DAY", "DAYS":
		return int(duration * 24 * 60)
	default:
		return int(duration)
	}
}
