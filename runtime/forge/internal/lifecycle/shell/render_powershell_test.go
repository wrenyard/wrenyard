package shell

import (
	"strings"
	"testing"
)

func TestRenderManagedPowerShellUsesWrenyardClaudeShellRoot(t *testing.T) {
	profiles := map[string]Profile{
		"cc-test": {
			Name:     "cc-test",
			Client:   "claude",
			Provider: "zhipu-coding",
			Env: map[string]string{
				"ANTHROPIC_BASE_URL": "https://open.bigmodel.cn/api/anthropic/v1",
			},
		},
	}
	rendered := RenderManagedPowerShell(
		profiles,
		[]string{"cc-test"},
		"wrenyard",
		func(provider string) (string, bool) { return "test-token", true },
		func(provider string) bool { return true },
	)
	if !strings.Contains(rendered, "# wrenyard.ps1 - Managed by wrenyard runtime setup") {
		t.Fatalf("generated PowerShell should carry the Wrenyard managed header:\n%s", rendered)
	}
	if !strings.Contains(rendered, `& 'wrenyard' 'runtime' 'shell' 'exec' 'cc-test'`) {
		t.Fatalf("generated PowerShell should invoke the public wrenyard launcher:\n%s", rendered)
	}
	if !strings.Contains(rendered, `'wrenyard\runtime\claude\shell-cc'`) {
		t.Fatalf("generated PowerShell should use wrenyard/runtime/claude/shell-cc:\n%s", rendered)
	}
	if strings.Contains(rendered, `'forge\claude\shell-cc'`) {
		t.Fatalf("generated PowerShell must not use the legacy forge data-root path:\n%s", rendered)
	}
	if strings.Contains(rendered, "test-token") {
		t.Fatalf("generated PowerShell must not embed credentials:\n%s", rendered)
	}
}
