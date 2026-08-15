package doctor

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// nativeClientInstall describes one user-installed upstream CLI. These are
// not Forge launchers (fdsh, fgrok); doctor reports them as one installation
// group so missing binaries stay separate from credentials and protocol checks.
type nativeClientInstall struct {
	ID     string
	Binary string
	Hint   string
}

// nativeClientInstalls is the stable human order for `forge doctor` installation.
var nativeClientInstalls = []nativeClientInstall{
	{ID: "claude-code", Binary: "claude", Hint: "Install Claude Code and ensure claude is on PATH."},
	{ID: "opencode", Binary: "opencode", Hint: "Install OpenCode and ensure opencode is on PATH."},
	{ID: "codex", Binary: "codex", Hint: "Install Codex CLI and ensure codex is on PATH."},
	{ID: "dsh", Binary: "dsh", Hint: "Install with: npm install -g @deepseek-ai/dsh, or set FORGE_DSH_BIN."},
	{ID: "codebuddy", Binary: "codebuddy", Hint: "Install with: npm install -g @tencent-ai/codebuddy-code."},
	{ID: "grok", Binary: "grok", Hint: "Install Grok Build and ensure grok is on PATH."},
}

// InstallationDoctorCheck reports whether each native client binary is present
// on this machine. Missing entries are warnings with an unversioned install
// hint; Forge protocol pins never appear here.
func InstallationDoctorCheck() map[string]interface{} {
	clients := make([]map[string]interface{}, 0, len(nativeClientInstalls))
	missing := 0
	for _, spec := range nativeClientInstalls {
		path := nativeBinaryPath(spec)
		row := map[string]interface{}{
			"id":     spec.ID,
			"binary": spec.Binary,
		}
		if path == "" {
			missing++
			row["status"] = "missing"
			row["hint"] = spec.Hint
		} else {
			row["status"] = "ok"
			row["path"] = path
		}
		clients = append(clients, row)
	}
	details := map[string]interface{}{"clients": clients}
	if missing > 0 {
		return Check("installation", "warning", "One or more native clients are not installed.", nil, details)
	}
	return Check("installation", "ok", "Native client binaries are installed.", nil, details)
}

func nativeBinaryPath(spec nativeClientInstall) string {
	if spec.Binary == "dsh" {
		if configured := strings.TrimSpace(os.Getenv("FORGE_DSH_BIN")); configured != "" {
			abs, err := filepath.Abs(configured)
			if err == nil {
				if _, statErr := os.Stat(abs); statErr == nil {
					return abs
				}
			}
		}
	}
	path, err := exec.LookPath(spec.Binary)
	if err != nil {
		return ""
	}
	return path
}

// InstallationRows extracts the ordered native-client rows for human printing.
func InstallationRows(check map[string]interface{}) []map[string]interface{} {
	details, _ := check["details"].(map[string]interface{})
	if details == nil {
		return nil
	}
	raw, ok := details["clients"]
	if !ok {
		return nil
	}
	switch rows := raw.(type) {
	case []map[string]interface{}:
		return rows
	case []interface{}:
		out := make([]map[string]interface{}, 0, len(rows))
		for _, item := range rows {
			row, ok := item.(map[string]interface{})
			if ok {
				out = append(out, row)
			}
		}
		return out
	default:
		return nil
	}
}
