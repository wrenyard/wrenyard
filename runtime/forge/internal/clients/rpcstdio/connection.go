package rpcstdio

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os/exec"
	"strings"
	"sync"
)

type Message struct {
	ID     *int            `json:"id,omitempty"`
	Method string          `json:"method,omitempty"`
	Params json.RawMessage `json:"params,omitempty"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  *RPCError       `json:"error,omitempty"`
}

type RPCError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type ResponseError struct {
	Code    int
	Message string
}

func (e *ResponseError) Error() string {
	return fmt.Sprintf("JSON-RPC error %d: %s", e.Code, e.Message)
}

// Conn manages the stdio connection to a JSON-RPC subprocess over newline-delimited JSON.
type Conn struct {
	cmd       *exec.Cmd
	stdin     io.WriteCloser
	stdout    io.Reader
	mu        sync.Mutex
	nextID    int
	scanner   *bufio.Scanner
	stderrBuf *bytes.Buffer
}

func (c *Conn) Call(ctx context.Context, method string, params json.RawMessage) (json.RawMessage, error) {
	c.mu.Lock()
	c.nextID++
	id := c.nextID
	c.mu.Unlock()

	msg := Message{
		ID:     &id,
		Method: method,
		Params: params,
	}

	body, err := json.Marshal(msg)
	if err != nil {
		return nil, err
	}

	// Write as newline-delimited JSON.
	body = append(body, '\n')
	if _, err := c.stdin.Write(body); err != nil {
		return nil, err
	}

	// Read response messages until we find one matching our ID.
	for {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		default:
		}

		resp, err := c.ReadOneLine()
		if err != nil {
			return nil, err
		}

		// Ignore notifications (no ID).
		if resp.ID == nil {
			continue
		}

		// Match our request ID.
		if *resp.ID != id {
			continue
		}

		if resp.Error != nil {
			return nil, &ResponseError{Code: resp.Error.Code, Message: resp.Error.Message}
		}

		return resp.Result, nil
	}
}

// notify sends a JSON-RPC notification (no ID).
func (c *Conn) Notify(method string, params json.RawMessage) {
	msg := Message{
		Method: method,
		Params: params,
	}
	body, err := json.Marshal(msg)
	if err != nil {
		return
	}
	body = append(body, '\n')
	c.stdin.Write(body)
}

// readOneLine reads one newline-delimited JSON message from the stdio stream.
func (c *Conn) ReadOneLine() (Message, error) {
	if c.scanner == nil {
		c.scanner = bufio.NewScanner(c.stdout)
		c.scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	}
	for c.scanner.Scan() {
		line := strings.TrimSpace(c.scanner.Text())
		if line == "" {
			continue
		}
		var msg Message
		if err := json.Unmarshal([]byte(line), &msg); err != nil {
			return Message{}, fmt.Errorf("unmarshal response: %w", err)
		}
		return msg, nil
	}
	if err := c.scanner.Err(); err != nil {
		return Message{}, err
	}
	return Message{}, fmt.Errorf("connection closed unexpectedly: %w", io.ErrUnexpectedEOF)
}

// wrapErr wraps the error with bounded stderr content if non-empty.
func (c *Conn) WrapErr(err error) error {
	if err == nil || c.stderrBuf == nil || c.stderrBuf.Len() == 0 {
		return err
	}
	stderr := strings.TrimSpace(c.stderrBuf.String())
	if stderr == "" {
		return err
	}
	return fmt.Errorf("%s (stderr: %s)", err.Error(), stderr)
}

func New(cmd *exec.Cmd, stdin io.WriteCloser, stdout io.Reader, stderr *bytes.Buffer) *Conn {
	return &Conn{cmd: cmd, stdin: stdin, stdout: stdout, stderrBuf: stderr}
}
