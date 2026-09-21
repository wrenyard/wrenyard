package forge

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/clients/account"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/clients/claude"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/clients/codex"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/clients/cursor"
	clientgrok "github.com/wrenyard/wrenyard/runtime/forge/internal/clients/grok"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/grok"
	"os"
	"time"
)

func clientCommand(args []string) int {
	if len(args) != 2 {
		fmt.Fprintln(os.Stderr, "forge client: expected <client> <operation>")
		return 2
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	var result any
	var err error
	switch args[0] + "/" + args[1] {
	case "codex/rate-limits":
		result, err = codex.ReadRateLimits(ctx)
	case "cursor/usage":
		result, err = (cursor.Client{}).ReadUsage(ctx)
	case "claude-coding/usage", "claude-oauth/usage":
		p := claude.Client{AllowKeychain: true, AllowSnapshot: args[0] != "claude-oauth" && os.Getenv("FORGE_QUOTA_CODEXBAR") == "1"}
		result, err = p.ReadUsage(ctx)
	case "super-grok/usage":
		p := clientgrok.Client{ResolveAuthSources: func() []string { return grok.ReadableOAuthSources(forgeDataDir(), userHome()) }}
		result, err = p.ReadUsage(ctx)
	default:
		fmt.Fprintln(os.Stderr, "forge client: unsupported operation")
		return 2
	}
	if err != nil {
		code := "quota_query_failed"
		var status *account.Error
		if errors.As(err, &status) {
			code = status.Code
		}
		result = map[string]string{"error_code": code}
	}
	if err := json.NewEncoder(os.Stdout).Encode(result); err != nil {
		return 1
	}
	return 0
}
