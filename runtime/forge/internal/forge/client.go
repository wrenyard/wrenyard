package forge

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/credentials/claude"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/execution/rpcstdio"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/grok"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/providers/cursor"
)

type clientRPCRequest struct {
	Command string             `json:"command"`
	Args    []string           `json:"args"`
	Env     map[string]*string `json:"env"`
	Steps   []struct {
		Method       string          `json:"method"`
		Params       json.RawMessage `json:"params"`
		Notification bool            `json:"notification"`
	} `json:"steps"`
}

// Internal bounded transport. Client protocol choreography lives in TypeScript.
func clientCommand(args []string) int {
	if len(args) != 1 || (args[0] != "rpc" && args[0] != "credential") {
		fmt.Fprintln(os.Stderr, "forge client: expected rpc or credential with a JSON request on stdin")
		return 2
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	decoder := json.NewDecoder(io.LimitReader(os.Stdin, 1024*1024))
	decoder.DisallowUnknownFields()
	var data any
	var err error
	step := -1
	if args[0] == "credential" {
		var request struct {
			Store string `json:"store"`
		}
		if err = decoder.Decode(&request); err == nil {
			switch request.Store {
			case "claude":
				var token string
				token, err = (claude.Store{AllowKeychain: true}).AccessToken(ctx)
				data = map[string]string{"accessToken": token}
			case "cursor":
				var token string
				token, err = cursor.AccessToken(cursor.StatePath(""))
				data = map[string]string{"accessToken": token}
			case "grok-sources":
				data = grok.ReadableOAuthSources(forgeDataDir(), userHome())
			default:
				err = errors.New("unknown credential store")
			}
		}
	} else {
		var request clientRPCRequest
		if err = decoder.Decode(&request); err == nil {
			if request.Command == "" || len(request.Steps) == 0 || len(request.Steps) > 64 {
				err = errors.New("invalid RPC sequence")
			} else {
				env := os.Environ()
				for key, value := range request.Env {
					filtered := make([]string, 0, len(env)+1)
					for _, entry := range env {
						name, _, _ := strings.Cut(entry, "=")
						if !strings.EqualFold(name, key) {
							filtered = append(filtered, entry)
						}
					}
					if value != nil {
						filtered = append(filtered, key+"="+*value)
					}
					env = filtered
				}
				var proc rpcstdio.Process
				proc, err = rpcstdio.Start(ctx, request.Command, request.Args, env)
				if err == nil {
					defer proc.Close()
					conn := proc.Connection()
					results := make([]json.RawMessage, len(request.Steps))
					for index, operation := range request.Steps {
						step = index
						if operation.Notification {
							err = conn.Notify(operation.Method, operation.Params)
						} else {
							results[index], err = conn.Call(ctx, operation.Method, operation.Params)
						}
						if err != nil {
							break
						}
					}
					data = results
				}
			}
		}
	}
	response := map[string]any{"data": data}
	if err != nil {
		code := "native_operation_failed"
		if args[0] == "credential" {
			code = "authentication_required"
		}
		fault := map[string]any{"code": code, "step": step}
		var rpcError *rpcstdio.ResponseError
		if errors.As(err, &rpcError) {
			fault["rpcCode"] = rpcError.Code
		}
		response = map[string]any{"error": fault}
	}
	// Never echo native errors or credential-bearing requests into logs.
	if json.NewEncoder(os.Stdout).Encode(response) != nil {
		return 1
	}
	return 0
}
