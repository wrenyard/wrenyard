package quota

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

const superGrokACPSource = "grok-acp-billing"

// SuperGrokProvider reads subscription credits through the official Grok ACP
// process. It never parses, copies, logs, or sends the local OAuth file itself;
// GROK_HOME only tells the official client which existing login to use.
type SuperGrokProvider struct {
	ResolveAuthSources func() []string
	RunRPC             func(ctx context.Context, grokHome string) (codexAppServerProcess, error)
}

func (SuperGrokProvider) Name() string { return "super-grok" }

func (p SuperGrokProvider) Fetch(ctx context.Context) (Quota, error) {
	var sources []string
	if p.ResolveAuthSources != nil {
		sources = p.ResolveAuthSources()
	}
	if len(sources) == 0 {
		return Quota{}, newQuotaStatusError(
			QuotaCodeConfigurationMissing,
			"尚未配置 Grok 登录。",
			nil,
		)
	}

	var lastAuthError error
	for _, source := range sources {
		grokHome := filepath.Dir(source)
		result, err := p.fetchBilling(ctx, grokHome)
		if err == nil {
			return superGrokQuotaFromBilling(result)
		}

		var callErr *superGrokCallError
		if errors.As(err, &callErr) {
			if errors.Is(callErr.Err, exec.ErrNotFound) {
				return Quota{}, newQuotaStatusError(
					QuotaCodeConfigurationMissing,
					"尚未安装或配置 Grok 客户端。",
					err,
				)
			}
			if callErr.authRequired() || callErr.Stage != "billing" {
				lastAuthError = err
				continue
			}
			return Quota{}, newQuotaStatusError(
				QuotaCodeQueryFailed,
				"SuperGrok 额度查询失败，请稍后重试。",
				err,
			)
		}

		lastAuthError = err
	}

	return Quota{}, newQuotaStatusError(
		QuotaCodeAuthenticationRequired,
		"Grok 登录已失效，请重新登录。",
		lastAuthError,
	)
}

type superGrokCallError struct {
	Stage string
	Err   error
}

func (e *superGrokCallError) Error() string {
	return fmt.Sprintf("super-grok %s: %v", e.Stage, e.Err)
}

func (e *superGrokCallError) Unwrap() error { return e.Err }

func (e *superGrokCallError) authRequired() bool {
	var rpcErr *jsonRPCResponseError
	return errors.As(e.Err, &rpcErr) && rpcErr.Code == -32000
}

func (p SuperGrokProvider) fetchBilling(ctx context.Context, grokHome string) (json.RawMessage, error) {
	runRPC := p.RunRPC
	if runRPC == nil {
		runRPC = defaultSuperGrokRunRPC
	}
	proc, err := runRPC(ctx, grokHome)
	if err != nil {
		return nil, &superGrokCallError{Stage: "initialize", Err: err}
	}

	conn := &rpcConn{
		cmd:       proc.cmd,
		stdin:     proc.stdin,
		stdout:    proc.stdout,
		stderrBuf: proc.stderrBuf,
	}
	defer func() {
		if conn.stdin != nil {
			_ = conn.stdin.Close()
		}
		if conn.cmd != nil && conn.cmd.Process != nil {
			_ = conn.cmd.Process.Kill()
		}
		if conn.cmd != nil {
			_ = conn.cmd.Wait()
		}
	}()

	initialize := json.RawMessage(`{"protocolVersion":1,"clientCapabilities":{}}`)
	if _, err := conn.call(ctx, "initialize", initialize); err != nil {
		return nil, &superGrokCallError{Stage: "initialize", Err: conn.wrapErr(err)}
	}

	// ACP extension methods use an underscore-prefixed wire name. Grok's
	// extension router exposes the logical x.ai/billing handler behind it.
	result, err := conn.call(ctx, "_x.ai/billing", nil)
	if err != nil {
		return nil, &superGrokCallError{Stage: "billing", Err: conn.wrapErr(err)}
	}
	return result, nil
}

func defaultSuperGrokRunRPC(ctx context.Context, grokHome string) (codexAppServerProcess, error) {
	binary, err := resolveGrokBinary()
	if err != nil {
		return codexAppServerProcess{}, err
	}
	cmd := exec.CommandContext(ctx, binary, "agent", "stdio")
	cmd.Env = superGrokProcessEnv(os.Environ(), grokHome)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return codexAppServerProcess{}, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		_ = stdin.Close()
		return codexAppServerProcess{}, err
	}
	var stderr bytes.Buffer
	cmd.Stderr = &limitWriter{w: &stderr, limit: 4096}
	applyCodexHiddenProcess(cmd)
	if err := cmd.Start(); err != nil {
		_ = stdin.Close()
		return codexAppServerProcess{}, err
	}
	return codexAppServerProcess{cmd: cmd, stdout: stdout, stdin: stdin, stderrBuf: &stderr}, nil
}

func resolveGrokBinary() (string, error) {
	name := "grok"
	if runtime.GOOS == "windows" {
		name = "grok.exe"
	}
	if binary, err := exec.LookPath(name); err == nil {
		return binary, nil
	}
	home, err := os.UserHomeDir()
	if err == nil && strings.TrimSpace(home) != "" {
		for _, candidate := range []string{
			filepath.Join(home, ".grok", "bin", name),
			filepath.Join(home, ".grok", "bin", "grok"),
		} {
			info, statErr := os.Stat(candidate)
			if statErr == nil && info.Mode().IsRegular() {
				return candidate, nil
			}
		}
	}
	return "", exec.ErrNotFound
}

func superGrokProcessEnv(base []string, grokHome string) []string {
	blocked := map[string]bool{
		"GROK_HOME":             true,
		"XAI_API_KEY":           true,
		"GROK_CODE_XAI_API_KEY": true,
	}
	out := make([]string, 0, len(base)+1)
	for _, entry := range base {
		name, _, ok := strings.Cut(entry, "=")
		if ok && blocked[strings.ToUpper(name)] {
			continue
		}
		out = append(out, entry)
	}
	return append(out, "GROK_HOME="+grokHome)
}

type superGrokBillingResponse struct {
	Config           *superGrokBillingConfig `json:"config"`
	SubscriptionTier string                  `json:"subscriptionTier"`
}

type superGrokBillingConfig struct {
	CreditUsagePercent *float64              `json:"creditUsagePercent"`
	CurrentPeriod      *superGrokUsagePeriod `json:"currentPeriod"`
	MonthlyLimit       *superGrokCent        `json:"monthlyLimit"`
	Used               *superGrokCent        `json:"used"`
	PrepaidBalance     *superGrokCent        `json:"prepaidBalance"`
	BillingPeriodStart string                `json:"billingPeriodStart"`
	BillingPeriodEnd   string                `json:"billingPeriodEnd"`
}

type superGrokUsagePeriod struct {
	Type  string `json:"type"`
	Start string `json:"start"`
	End   string `json:"end"`
}

type superGrokCent struct {
	Val int64 `json:"val"`
}

func superGrokQuotaFromBilling(raw json.RawMessage) (Quota, error) {
	var response superGrokBillingResponse
	if err := json.Unmarshal(raw, &response); err != nil {
		return Quota{}, newQuotaStatusError(
			QuotaCodeQueryFailed,
			"SuperGrok 额度查询失败，请稍后重试。",
			err,
		)
	}

	quota := Quota{
		Provider:  "super-grok",
		Source:    superGrokACPSource,
		FetchedAt: timeNow(),
	}
	if response.Config == nil {
		quota.Message = "当前账户未返回可展示的订阅额度。"
		return quota, nil
	}

	config := response.Config
	usedPct, ok := superGrokUsedPct(config)
	if ok {
		window := Window{Name: "quota", Pct: clampPct(usedPct)}
		if config.CurrentPeriod != nil {
			window.Name = superGrokPeriodName(config.CurrentPeriod.Type)
			applySuperGrokPeriod(&window, config.CurrentPeriod.Start, config.CurrentPeriod.End)
		} else {
			window.Name = "1mo"
			applySuperGrokPeriod(&window, config.BillingPeriodStart, config.BillingPeriodEnd)
		}
		quota.Windows = []Window{window}
	}
	if balance := config.PrepaidBalance; balance != nil && balance.Val >= 0 {
		quota.Balances = []MoneyBalance{{Currency: "USD", Amount: centsDecimal(balance.Val)}}
	}
	if len(quota.Windows) == 0 && len(quota.Balances) == 0 {
		quota.Message = "当前账户未返回可展示的订阅额度。"
	}
	return quota, nil
}

func superGrokUsedPct(config *superGrokBillingConfig) (float64, bool) {
	if config.CreditUsagePercent != nil {
		return *config.CreditUsagePercent, true
	}
	if config.MonthlyLimit != nil && config.MonthlyLimit.Val > 0 && config.Used != nil {
		return float64(config.Used.Val) / float64(config.MonthlyLimit.Val) * 100, true
	}
	return 0, false
}

func superGrokPeriodName(periodType string) string {
	switch strings.ToUpper(strings.TrimSpace(periodType)) {
	case "USAGE_PERIOD_TYPE_WEEKLY":
		return "7d"
	case "USAGE_PERIOD_TYPE_MONTHLY":
		return "1mo"
	default:
		return "quota"
	}
}

func applySuperGrokPeriod(window *Window, startRaw, endRaw string) {
	end, endErr := time.Parse(time.RFC3339, endRaw)
	if endErr == nil {
		window.ResetsAt = &end
	}
	start, startErr := time.Parse(time.RFC3339, startRaw)
	if startErr == nil && endErr == nil && end.After(start) {
		window.WindowMinutes = int(end.Sub(start) / time.Minute)
	}
}

func centsDecimal(value int64) string {
	return fmt.Sprintf("%d.%02d", value/100, value%100)
}
