//go:build windows

package forge

import "os"

// codexAppServerSignals lists the cancellation signals available on Windows.
// SIGTERM does not exist there, so interrupt is the only portable signal.
func codexAppServerSignals() []os.Signal {
	return []os.Signal{os.Interrupt}
}
