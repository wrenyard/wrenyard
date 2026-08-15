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

type BigModelProvider struct {
	Token  string
	URL    string
	Client *http.Client
}

func (p BigModelProvider) Name() string { return "zhipu-coding" }

func (p BigModelProvider) Fetch(ctx context.Context) (Quota, error) {
	token := strings.TrimSpace(p.Token)
	if token == "" {
		return Quota{}, errors.New("bigmodel bearer token unavailable")
	}
	url := p.URL
	if url == "" {
		url = "https://open.bigmodel.cn/api/monitor/usage/quota/limit"
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return Quota{}, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/json")
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
	q, err := ParseBigModelQuota(body)
	if err != nil {
		return Quota{
			Provider:  p.Name(),
			Source:    "api",
			FetchedAt: time.Now(),
			Message:   "no data: " + err.Error(),
		}, nil
	}
	q.Provider = p.Name()
	q.Source = "api"
	q.FetchedAt = time.Now()
	return q, nil
}

func ParseBigModelQuota(raw []byte) (Quota, error) {
	var root map[string]any
	if err := json.Unmarshal(raw, &root); err != nil {
		return Quota{}, err
	}
	limits := findLimits(root)
	windows := []Window{}
	for _, item := range limits {
		name := strings.ToUpper(toString(item["name"]))
		if name == "" {
			name = strings.ToUpper(toString(item["type"]))
		}
		if name != "TOKENS_LIMIT" {
			continue
		}
		unit, _ := coerceFloat(item["unit"])
		number, _ := coerceFloat(item["number"])
		pct := limitPct(item)
		if pct == nil {
			continue
		}
		resetsAt := parseNextResetTime(item, 0)
		switch {
		case int(unit) == 3 && int(number) == 5:
			resetsAt = parseNextResetTime(item, 5*time.Hour)
			windows = append(windows, Window{Name: "5h", Pct: *pct, WindowMinutes: 300, ResetsAt: resetsAt})
		case int(unit) == 6 && int(number) == 1:
			resetsAt = parseNextResetTime(item, 7*24*time.Hour)
			windows = append(windows, Window{Name: "7d", Pct: *pct, WindowMinutes: 10080, ResetsAt: resetsAt})
		}
	}
	if len(windows) == 0 {
		return Quota{}, errors.New("bigmodel quota windows unavailable")
	}
	return Quota{Windows: windows}, nil
}

func findLimits(v any) []map[string]any {
	switch x := v.(type) {
	case map[string]any:
		for key, item := range x {
			if strings.EqualFold(key, "limits") {
				if arr, ok := item.([]any); ok {
					out := []map[string]any{}
					for _, elem := range arr {
						if m, ok := elem.(map[string]any); ok {
							out = append(out, m)
						}
					}
					return out
				}
			}
			if found := findLimits(item); len(found) > 0 {
				return found
			}
		}
	case []any:
		for _, item := range x {
			if found := findLimits(item); len(found) > 0 {
				return found
			}
		}
	}
	return nil
}

// parseNextResetTime parses the nextResetTime field from the BigModel API.
// maxDur is the window duration used as an upper-bound sanity check:
// a reset time must be in the future but not absurdly far out.
// If maxDur is zero, a generous 8-day cap is used.
func parseNextResetTime(item map[string]any, maxDur time.Duration) *time.Time {
	ts, ok := coerceFloat(item["nextResetTime"])
	if !ok || ts <= 0 {
		return nil
	}
	t := time.UnixMilli(int64(ts))

	// Must be in the future.
	if !t.After(time.Now()) {
		return nil
	}

	// Must not be absurdly far in the future.
	capDur := maxDur
	if capDur <= 0 {
		capDur = 8 * 24 * time.Hour
	}
	maxAllowed := time.Now().Add(capDur)
	if t.After(maxAllowed) {
		return nil
	}

	return &t
}

func limitPct(item map[string]any) *float64 {
	for _, key := range []string{"used_percent", "usedPercent", "usage_percent", "usagePercent", "percentage", "percent", "pct"} {
		if n, ok := coerceFloat(item[key]); ok {
			return &n
		}
	}
	used, usedOK := coerceFloat(item["used"])
	total, totalOK := coerceFloat(item["total"])
	if !usedOK {
		used, usedOK = coerceFloat(item["usage"])
	}
	if !totalOK {
		total, totalOK = coerceFloat(item["limit"])
	}
	if usedOK && totalOK && total > 0 {
		pct := used / total * 100
		return &pct
	}
	return nil
}
