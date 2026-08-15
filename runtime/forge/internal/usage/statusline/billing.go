package statusline

import (
	"encoding/json"
	"os"
	"strings"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/catalog"
)

type Billing struct {
	USDToCNY          float64              `json:"usd_to_cny"`
	DefaultQuotaTotal float64              `json:"default_quota_total"`
	ContextWindows    map[string]int       `json:"context_windows"`
	Models            map[string]ModelRate `json:"models"`
	ModelDisplayNames map[string]string    `json:"model_display_names"`
}

type ModelRate struct {
	Input       float64 `json:"input"`
	CacheWrite5 float64 `json:"cache_write_5m"`
	CacheWrite1 float64 `json:"cache_write_1h"`
	CacheRead   float64 `json:"cache_read"`
	Output      float64 `json:"output"`
}

// LoadBilling reads billing data from a models.json path.
func LoadBilling(path string) (Billing, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return Billing{}, err
	}
	return LoadBillingData(raw)
}

// LoadBillingCatalog constructs billing info from the catalog provider model
// definitions. This is the production billing source; models.json is no longer
// embedded or loaded.
func LoadBillingCatalog(reg *catalog.Registry) Billing {
	b := Billing{
		USDToCNY:          7.2,
		DefaultQuotaTotal: 7000,
		ContextWindows: map[string]int{
			"1m":      1000000,
			"default": 200000,
		},
		Models:            make(map[string]ModelRate),
		ModelDisplayNames: make(map[string]string),
	}

	// Collect display names from catalog model definitions.
	for _, p := range reg.Providers() {
		for _, m := range p.Models {
			key := strings.ToLower(m.ID)
			if m.DisplayName != "" {
				b.ModelDisplayNames[key] = m.DisplayName
			}
		}
	}

	return b
}

// LoadBillingData unmarshals billing from raw JSON bytes.
func LoadBillingData(raw []byte) (Billing, error) {
	var b Billing
	if err := json.Unmarshal(raw, &b); err != nil {
		return Billing{}, err
	}
	if b.USDToCNY == 0 {
		b.USDToCNY = 7.2
	}
	if b.DefaultQuotaTotal == 0 {
		b.DefaultQuotaTotal = 7000
	}
	if b.ContextWindows == nil {
		b.ContextWindows = map[string]int{"1m": 1000000, "default": 200000}
	}
	return b, nil
}

func (b Billing) RateFor(model string) ModelRate {
	m := strings.ToLower(model)
	if strings.Contains(m, "opus") && (strings.Contains(m, "4.7") || strings.Contains(m, "4.6")) {
		if r, ok := b.Models["opus-4.7"]; ok {
			return r
		}
	}
	for _, key := range []string{"opus", "sonnet", "haiku"} {
		if strings.Contains(m, key) {
			if r, ok := b.Models[key]; ok {
				return r
			}
		}
	}
	// Unknown model — return a zero rate.
	return ModelRate{}
}
