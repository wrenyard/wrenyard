package grok

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/clients/account"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/clients/rpcstdio"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

const superGrokACPSource = "grok-acp-billing"

// Client reads subscription credits through the official Grok ACP
// process. It never parses, copies, logs, or sends the local OAuth file itself;
// GROK_HOME only tells the official client which existing login to use.
type Client struct {
	ResolveAuthSources func() []string
	RunRPC             func(ctx context.Context, grokHome string) (rpcstdio.Process, error)
}

func (p Client) ReadUsage(ctx context.Context) (account.Observation, error) {
	var sources []string
	if p.ResolveAuthSources != nil {
		sources = p.ResolveAuthSources()
	}
	if len(sources) == 0 {
		return account.Observation{}, account.NewError(
			"configuration_missing",
			"尚未配置 Grok 登录。",
			nil,
		)
	}

	var lastAuthError error
	for _, source := range sources {
		grokHome := filepath.Dir(source)
		result, err := p.fetchBilling(ctx, grokHome)
		if err == nil {
			return account.Observation{Source: superGrokACPSource, FetchedAt: time.Now(), Data: result}, nil
		}

		var callErr *superGrokCallError
		if errors.As(err, &callErr) {
			if errors.Is(callErr.Err, exec.ErrNotFound) {
				return account.Observation{}, account.NewError(
					"configuration_missing",
					"尚未安装或配置 Grok 客户端。",
					err,
				)
			}
			if callErr.authRequired() || callErr.Stage != "billing" {
				lastAuthError = err
				continue
			}
			return account.Observation{}, account.NewError(
				"quota_query_failed",
				"SuperGrok 额度查询失败，请稍后重试。",
				err,
			)
		}

		lastAuthError = err
	}

	return account.Observation{}, account.NewError(
		"authentication_required",
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
	var rpcErr *rpcstdio.ResponseError
	return errors.As(e.Err, &rpcErr) && rpcErr.Code == -32000
}

func (p Client) fetchBilling(ctx context.Context, grokHome string) (json.RawMessage, error) {
	runRPC := p.RunRPC
	if runRPC == nil {
		runRPC = defaultSuperGrokRunRPC
	}
	proc, err := runRPC(ctx, grokHome)
	if err != nil {
		return nil, &superGrokCallError{Stage: "initialize", Err: err}
	}

	conn := proc.Connection()
	defer proc.Close()

	initialize := json.RawMessage(`{"protocolVersion":1,"clientCapabilities":{}}`)
	if _, err := conn.Call(ctx, "initialize", initialize); err != nil {
		return nil, &superGrokCallError{Stage: "initialize", Err: conn.WrapErr(err)}
	}

	// ACP extension methods use an underscore-prefixed wire name. Grok's
	// extension router exposes the logical x.ai/billing handler behind it.
	result, err := conn.Call(ctx, "_x.ai/billing", nil)
	if err != nil {
		return nil, &superGrokCallError{Stage: "billing", Err: conn.WrapErr(err)}
	}
	return result, nil
}

func defaultSuperGrokRunRPC(ctx context.Context, grokHome string) (rpcstdio.Process, error) {
	binary, err := resolveGrokBinary()
	if err != nil {
		return rpcstdio.Process{}, err
	}
	proc, err := rpcstdio.Start(ctx, binary, []string{"agent", "stdio"}, superGrokProcessEnv(os.Environ(), grokHome))
	if err != nil {
		return rpcstdio.Process{}, err
	}
	return proc, nil
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
