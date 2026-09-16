//go:build !windows

package forge

import (
	"os"
	"syscall"
)

// codexAppServerSignals lists the interoperable cancellation signals Forge
// forwards to the Codex app-server bridge. SIGTERM and SIGINT are portable
// across the Unix platforms Forge supports.
func codexAppServerSignals() []os.Signal {
	return []os.Signal{syscall.SIGTERM, os.Interrupt}
}
