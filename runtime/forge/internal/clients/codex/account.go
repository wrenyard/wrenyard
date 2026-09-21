package codex

import (
	"context"
	"encoding/json"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/clients/rpcstdio"
)

func ReadRateLimits(ctx context.Context) (json.RawMessage, error) {
	process, err := rpcstdio.Start(ctx, "codex", []string{"app-server", "--stdio"}, nil)
	if err != nil {
		return nil, err
	}
	return ReadRateLimitsWithProcess(ctx, process)
}

// ReadRateLimitsWithProcess accepts an owned session, including an injected transport.
func ReadRateLimitsWithProcess(ctx context.Context, process rpcstdio.Process) (json.RawMessage, error) {
	defer process.Close()
	conn := process.Connection()
	init := json.RawMessage(`{"clientInfo":{"name":"forge","title":"Forge","version":"0.0.0"}}`)
	if _, err := conn.Call(ctx, "initialize", init); err != nil {
		return nil, conn.WrapErr(err)
	}
	conn.Notify("initialized", nil)
	result, err := conn.Call(ctx, "account/rateLimits/read", json.RawMessage("null"))
	return result, conn.WrapErr(err)
}
