package rpcstdio

import (
	"bytes"
	"context"
	"io"
	"os/exec"
)

// Process owns a single client's stdio session. Close always reaps its child.
type Process struct {
	Cmd    *exec.Cmd
	Stdin  io.WriteCloser
	Stdout io.Reader
	Stderr *bytes.Buffer
}

func Start(ctx context.Context, binary string, args []string, env []string) (Process, error) {
	cmd := exec.CommandContext(ctx, binary, args...)
	cmd.Env = env
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return Process{}, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		stdin.Close()
		return Process{}, err
	}
	stderr := &bytes.Buffer{}
	cmd.Stderr = &limitedWriter{w: stderr, limit: 4096}
	applyHiddenProcess(cmd)
	if err := cmd.Start(); err != nil {
		stdin.Close()
		return Process{}, err
	}
	return Process{Cmd: cmd, Stdin: stdin, Stdout: stdout, Stderr: stderr}, nil
}
func (p Process) Connection() *Conn { return New(p.Cmd, p.Stdin, p.Stdout, p.Stderr) }
func (p Process) Close() {
	if p.Stdin != nil {
		p.Stdin.Close()
	}
	if p.Cmd != nil {
		if p.Cmd.Process != nil {
			_ = p.Cmd.Process.Kill()
		}
		_ = p.Cmd.Wait()
	}
}

type limitedWriter struct {
	w       io.Writer
	limit   int
	written int
}

func (w *limitedWriter) Write(p []byte) (int, error) {
	n, err := WriteLimited(w.w, w.limit, &w.written, p)
	return n, err
}

// WriteLimited drains the stream while retaining only the bounded prefix.
func WriteLimited(w io.Writer, limit int, written *int, p []byte) (int, error) {
	remaining := limit - *written
	original := len(p)
	if remaining <= 0 {
		return original, nil
	}
	if len(p) > remaining {
		p = p[:remaining]
	}
	n, err := w.Write(p)
	*written += n
	if err != nil {
		return n, err
	}
	return original, nil
}
