package main

import (
	"os"
	"path/filepath"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/forge"
)

func main() {
	if code, handled := forge.RunBashGateIfNeeded(); handled {
		os.Exit(code)
	}
	if code, handled := forge.RunCodexMCPIfNeeded(os.Args[1:]); handled {
		os.Exit(code)
	}
	if code, handled := forge.RunFDSHIfNeeded(); handled {
		os.Exit(code)
	}
	if code, handled := forge.RunStableLauncherIfNeeded(); handled {
		os.Exit(code)
	}
	os.Exit(forge.Run(os.Args[1:], filepath.Base(os.Args[0])))
}
