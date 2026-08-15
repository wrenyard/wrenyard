//go:build !darwin

package quota

import (
	"context"
	"errors"
)

func readClaudeKeychain(ctx context.Context) ([]byte, error) {
	return nil, errors.New("keychain unavailable")
}

// ReadClaudeKeychain is a stub for non-darwin platforms.
func ReadClaudeKeychain(ctx context.Context) ([]byte, error) {
	return nil, errors.New("keychain only available on macOS")
}
