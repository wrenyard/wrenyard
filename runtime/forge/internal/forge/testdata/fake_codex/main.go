// Command fake_codex is a minimal stand-in for the native Codex CLI. It speaks
// only the `codex app-server --stdio` JSON-RPC transport Forge drives: there is
// no `exec` mode, no live model call, and no real shell execution.
//
// The fake mirrors the Codex 0.148 native schema exactly (camelCase item types,
// nested turn objects, a root-level thread model, and per-response usage) so the
// built-Forge bridge integration test can assert end-to-end record translation
// without any credential or network access. The only credentials it ever sees
// are the fake ones the test itself places in a throwaway auth.json, and the
// account/login/start parameters are deliberately never persisted.
package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"strings"
)

const (
	fakeCodexThreadID = "thread-fake"
	fakeCodexTurnID   = "turn-fake"
	fakeCodexModel    = "gpt-5.6-sol"
	// fakeCodexToolOutput is the deterministic aggregated output of the fake
	// command execution. Nothing is ever executed: the fixture only reports it.
	fakeCodexToolOutput = "fake-codex-tool-output\n"
)

// fakeCodexObservation is the argv/env record written for the test to read.
// Only configuration-relevant detail is recorded: the CODEX_HOME the child was
// given (so the test can prove the isolated home), the working directory, and
// the argv Forge passed. No auth request parameters ever reach this file.
type fakeCodexObservation struct {
	Argv             []string `json:"argv"`
	CodexHome        string   `json:"codex_home"`
	CWD              string   `json:"cwd"`
	AppServerInvoked bool     `json:"app_server_invoked"`
	AuthLogins       int      `json:"auth_logins"`
	ThreadStarts     int      `json:"thread_starts"`
	TurnStarts       int      `json:"turn_starts"`
	Fake             bool     `json:"fake"`
}

type rpcMessage struct {
	ID     *json.RawMessage `json:"id,omitempty"`
	Method string           `json:"method,omitempty"`
	Params json.RawMessage  `json:"params,omitempty"`
}

func main() {
	if len(os.Args) == 2 && os.Args[1] == "--version" {
		// The native version string the bridge probes for. It matches the
		// schema generation this fake implements.
		fmt.Println("codex-cli 0.148.0-fake")
		return
	}

	obs := fakeCodexObservation{
		Argv:      append([]string(nil), os.Args[1:]...),
		CodexHome: os.Getenv("CODEX_HOME"),
		Fake:      true,
	}
	if cwd, err := os.Getwd(); err == nil {
		obs.CWD = cwd
	}
	// The app-server subcommand is the only transport this fake offers: an
	// `exec` invocation is refused outright so no legacy path can be reached.
	obs.AppServerInvoked = hasToken(obs.Argv, "app-server") && hasToken(obs.Argv, "--stdio")

	// The observation is written before serving so the test still gets the
	// argv/env record even if the protocol conversation fails. The counters
	// are re-read at exit, so they reflect the whole conversation.
	defer func() {
		if obs.CodexHome == "" {
			obs.CodexHome = os.Getenv("CODEX_HOME")
		}
		writeObservation(obs)
	}()

	if !obs.AppServerInvoked {
		fmt.Fprintln(os.Stderr, "fake codex: only `app-server --stdio` is supported")
		os.Exit(2)
	}

	serve(&obs)
}

// serve runs the app-server JSON-RPC loop until stdin closes. A closed stdin is
// the real Codex CLI's shutdown signal.
func serve(obs *fakeCodexObservation) {
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 0, 64*1024), 8*1024*1024)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		var msg rpcMessage
		if err := json.Unmarshal([]byte(line), &msg); err != nil {
			// A malformed request is dropped; the peer keeps serving.
			continue
		}
		if msg.Method == "" {
			// A response to a server-initiated request: nothing to do.
			continue
		}
		if msg.ID == nil {
			// A notification from the client (`initialized`). Never answered.
			continue
		}
		respond(obs, msg)
	}
}

// respond answers one client request. Unknown methods always receive -32601 so
// the bridge never blocks on an unimplemented endpoint.
func respond(obs *fakeCodexObservation, msg rpcMessage) {
	switch msg.Method {
	case "initialize":
		// The child advertises an empty capabilities/account surface: Forge
		// reads only the response envelope.
		writeResult(msg.ID, map[string]any{})
	case "account/login/start":
		// The native handshake. The request params are intentionally NOT
		// recorded: only the fact that the login happened is observable.
		obs.AuthLogins++
		writeResult(msg.ID, map[string]any{"type": "chatgptAuthTokens"})
	case "thread/start":
		obs.ThreadStarts++
		writeResult(msg.ID, map[string]any{
			"thread": map[string]any{"id": fakeCodexThreadID},
			"model":  fakeCodexModel,
		})
	case "thread/resume":
		obs.ThreadStarts++
		writeResult(msg.ID, map[string]any{
			"thread": map[string]any{"id": fakeCodexThreadID},
			"model":  fakeCodexModel,
		})
	case "turn/start":
		obs.TurnStarts++
		writeResult(msg.ID, map[string]any{"turn": map[string]any{"id": fakeCodexTurnID}})
		streamTurn()
	case "turn/interrupt":
		writeResult(msg.ID, map[string]any{})
	default:
		writeError(msg.ID, -32601, "method not found: "+msg.Method)
	}
}

// streamTurn emits the native notification sequence of one completed turn: the
// turn lifecycle, a command execution item (started and completed), an
// agent-message delta followed by the completed message, the raw response
// completion carrying usage, and finally the completed turn.
func streamTurn() {
	notify("turn/started", map[string]any{
		"threadId": fakeCodexThreadID,
		"turn":     map[string]any{"id": fakeCodexTurnID, "status": "inProgress"},
	})
	notify("item/started", map[string]any{
		"threadId": fakeCodexThreadID,
		"turnId":   fakeCodexTurnID,
		"item": map[string]any{
			"id":      "cmd-fake",
			"type":    "commandExecution",
			"command": "printf " + fakeCodexToolOutput,
			"status":  "inProgress",
		},
	})
	notify("item/completed", map[string]any{
		"threadId": fakeCodexThreadID,
		"turnId":   fakeCodexTurnID,
		"item": map[string]any{
			"id":               "cmd-fake",
			"type":             "commandExecution",
			"command":          "printf " + fakeCodexToolOutput,
			"aggregatedOutput": fakeCodexToolOutput,
			"exitCode":         0,
			"status":           "completed",
		},
	})
	notify("item/agentMessage/delta", map[string]any{
		"threadId": fakeCodexThreadID,
		"turnId":   fakeCodexTurnID,
		"itemId":   "msg-fake",
		"delta":    "FAKE_CODEX_",
	})
	notify("item/completed", map[string]any{
		"threadId": fakeCodexThreadID,
		"turnId":   fakeCodexTurnID,
		"item": map[string]any{
			"id":   "msg-fake",
			"type": "agentMessage",
			"text": "FAKE_CODEX_FINAL",
		},
	})
	notify("rawResponse/completed", map[string]any{
		"threadId":   fakeCodexThreadID,
		"turnId":     fakeCodexTurnID,
		"responseId": "resp-fake",
		"usage": map[string]any{
			"inputTokens":  128,
			"outputTokens": 16,
		},
	})
	notify("turn/completed", map[string]any{
		"threadId": fakeCodexThreadID,
		"turn": map[string]any{
			"id":         fakeCodexTurnID,
			"status":     "completed",
			"durationMs": 50,
		},
	})
}

func writeResult(id *json.RawMessage, result any) {
	write(map[string]any{"id": rawID(id), "result": result})
}

func writeError(id *json.RawMessage, code int, message string) {
	write(map[string]any{"id": rawID(id), "error": map[string]any{"code": code, "message": message}})
}

func notify(method string, params any) {
	write(map[string]any{"method": method, "params": params})
}

// rawID preserves the client's request id verbatim, whatever JSON type it is.
func rawID(id *json.RawMessage) any {
	if id == nil {
		return nil
	}
	return *id
}

func write(message any) {
	body, err := json.Marshal(message)
	if err != nil {
		return
	}
	fmt.Println(string(body))
}

// writeObservation records the argv/env observation when the test asked for it.
func writeObservation(obs fakeCodexObservation) {
	path := strings.TrimSpace(os.Getenv("FAKE_CODEX_OBSERVATION"))
	if path == "" {
		return
	}
	data, err := json.MarshalIndent(obs, "", "  ")
	if err != nil {
		return
	}
	_ = os.WriteFile(path, append(data, '\n'), 0o600)
}

func hasToken(args []string, want string) bool {
	for _, arg := range args {
		if arg == want {
			return true
		}
	}
	return false
}
