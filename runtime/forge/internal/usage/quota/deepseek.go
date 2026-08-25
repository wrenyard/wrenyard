package quota

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// deepseekBalanceEndpoint is the official DeepSeek balance endpoint.
const deepseekBalanceEndpoint = "https://api.deepseek.com/user/balance"

// DeepSeekProvider is a quota-only provider that reads the official
// DeepSeek balance API. It is strictly quota: it never registers inference
// or auth behavior. Token comes from the user-owned DEEPSEEK_API_KEY /
// FORGE_DEEPSEEK_API_KEY environment variable, never from auth.json.
type DeepSeekProvider struct {
	Token  string
	URL    string
	Client *http.Client
	Now    func() time.Time
}

func (p DeepSeekProvider) Name() string { return "deepseek" }

// Fetch queries the DeepSeek balance endpoint and parses one or more exact
// monetary balances. It is fail-closed: missing token, non-2xx responses,
// is_available=false, empty or malformed balance_infos, and negative or
// non-decimal amounts are all rejected.
func (p DeepSeekProvider) Fetch(ctx context.Context) (Quota, error) {
	now := time.Now()
	if p.Now != nil {
		now = p.Now()
	}

	token := strings.TrimSpace(p.Token)
	if token == "" {
		return Quota{}, errors.New("deepseek bearer token unavailable")
	}

	url := strings.TrimSpace(p.URL)
	if url == "" {
		url = deepseekBalanceEndpoint
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return Quota{}, fmt.Errorf("deepseek: build request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "forge")

	client := p.Client
	if client == nil {
		client = &http.Client{Timeout: 10 * time.Second}
	}
	resp, err := client.Do(req)
	if err != nil {
		return Quota{}, fmt.Errorf("deepseek: balance request failed: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return Quota{}, fmt.Errorf("deepseek: balance returned status %d", resp.StatusCode)
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return Quota{}, fmt.Errorf("deepseek: read response: %w", err)
	}
	q, err := ParseDeepSeekBalance(body)
	if err != nil {
		return Quota{}, err
	}
	q.Provider = p.Name()
	q.Source = "deepseek-balance"
	q.FetchedAt = now
	return q, nil
}

// ParseDeepSeekBalance parses the official /user/balance response into exact
// monetary balances. It requires is_available=true, a valid total_balance for
// each currency, and rejects empty/malformed/negative amounts.
func ParseDeepSeekBalance(raw []byte) (Quota, error) {
	var root struct {
		IsAvailable  bool `json:"is_available"`
		BalanceInfos []struct {
			Currency     string `json:"currency"`
			TotalBalance string `json:"total_balance"`
		} `json:"balance_infos"`
	}
	if err := json.Unmarshal(raw, &root); err != nil {
		return Quota{}, errors.New("deepseek: malformed balance response")
	}
	if !root.IsAvailable {
		return Quota{}, errors.New("deepseek: account unavailable")
	}
	if len(root.BalanceInfos) == 0 {
		return Quota{}, errors.New("deepseek: no balance info available")
	}

	var balances []MoneyBalance
	for _, info := range root.BalanceInfos {
		currency := strings.ToUpper(strings.TrimSpace(info.Currency))
		if !validCurrencyCode(currency) {
			return Quota{}, errors.New("deepseek: invalid currency")
		}
		amount := strings.TrimSpace(info.TotalBalance)
		if !validNonNegativeDecimal(amount) {
			return Quota{}, errors.New("deepseek: invalid balance amount")
		}
		balances = append(balances, MoneyBalance{Currency: currency, Amount: amount})
	}
	if len(balances) == 0 {
		return Quota{}, errors.New("deepseek: no balance info available")
	}
	return Quota{Balances: balances}, nil
}

// validCurrencyCode reports whether s is an uppercase three-letter code.
func validCurrencyCode(s string) bool {
	if len(s) != 3 {
		return false
	}
	for _, r := range s {
		if r < 'A' || r > 'Z' {
			return false
		}
	}
	return true
}

// validNonNegativeDecimal reports whether s is a non-negative exact decimal
// string (digits with an optional decimal point and fractional digits).
func validNonNegativeDecimal(s string) bool {
	if s == "" {
		return false
	}
	seenDigit := false
	seenDot := false
	fracDigits := 0
	for i, r := range s {
		switch {
		case r >= '0' && r <= '9':
			seenDigit = true
			if seenDot {
				fracDigits++
			}
		case r == '.':
			if seenDot || i == 0 {
				return false
			}
			seenDot = true
		default:
			return false
		}
	}
	if !seenDigit {
		return false
	}
	if seenDot && fracDigits == 0 {
		return false
	}
	return true
}
