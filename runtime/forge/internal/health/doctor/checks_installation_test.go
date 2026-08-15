package doctor

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestInstallationDoctorCheckReportsMissingDSH(t *testing.T) {
	t.Setenv("PATH", t.TempDir())
	t.Setenv("FORGE_DSH_BIN", "")

	check := InstallationDoctorCheck()
	if check["adapter"] != "installation" {
		t.Fatalf("adapter = %v, want installation", check["adapter"])
	}
	if check["status"] != "warning" {
		t.Fatalf("status = %v, want warning when native clients are missing", check["status"])
	}
	var dsh map[string]interface{}
	for _, row := range InstallationRows(check) {
		if row["id"] == "dsh" {
			dsh = row
			break
		}
	}
	if dsh == nil {
		t.Fatalf("installation clients must include dsh, got %#v", check["details"])
	}
	if dsh["status"] != "missing" {
		t.Fatalf("dsh status = %#v, want missing", dsh["status"])
	}
	hint, _ := dsh["hint"].(string)
	if !strings.Contains(hint, "npm install -g @deepseek-ai/dsh") {
		t.Fatalf("dsh hint should name the unversioned package, got %q", hint)
	}
	if strings.Contains(hint, "0.1.0-rc.6") {
		t.Fatalf("installation hint must not pin a dsh version, got %q", hint)
	}
}

func TestInstallationDoctorCheckHonorsFORGEDSHBIN(t *testing.T) {
	t.Setenv("PATH", t.TempDir())
	bin := t.TempDir()
	dshPath := filepath.Join(bin, "dsh")
	if runtime.GOOS == "windows" {
		dshPath += ".cmd"
	}
	if err := os.WriteFile(dshPath, []byte("ok\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("FORGE_DSH_BIN", dshPath)

	check := InstallationDoctorCheck()
	var dsh map[string]interface{}
	for _, row := range InstallationRows(check) {
		if row["id"] == "dsh" {
			dsh = row
			break
		}
	}
	if dsh["status"] != "ok" {
		t.Fatalf("FORGE_DSH_BIN should count as installed, got %#v", dsh)
	}
}

func TestInstallationDoctorCheckStableOrder(t *testing.T) {
	t.Setenv("PATH", t.TempDir())
	t.Setenv("FORGE_DSH_BIN", "")
	rows := InstallationRows(InstallationDoctorCheck())
	want := []string{"claude-code", "opencode", "codex", "dsh", "codebuddy", "grok"}
	if len(rows) != len(want) {
		t.Fatalf("len(rows) = %d, want %d (%#v)", len(rows), len(want), rows)
	}
	for i, id := range want {
		if rows[i]["id"] != id {
			t.Fatalf("clients[%d] = %v, want %s", i, rows[i]["id"], id)
		}
	}
}

func TestFormatCheckLinesInstallationGroup(t *testing.T) {
	t.Setenv("PATH", t.TempDir())
	t.Setenv("FORGE_DSH_BIN", "")
	lines := FormatCheckLines(InstallationDoctorCheck())
	if len(lines) != 1+len(nativeClientInstalls) {
		t.Fatalf("len(lines) = %d, want %d (%#v)", len(lines), 1+len(nativeClientInstalls), lines)
	}
	if lines[0] != "installation:" {
		t.Fatalf("lines[0] = %q, want installation:", lines[0])
	}
	if lines[1] != "\tclaude-code missing" {
		t.Fatalf("lines[1] = %q, want tabbed claude-code missing", lines[1])
	}
	if lines[4] != "\tdsh missing" {
		t.Fatalf("lines[4] = %q, want tabbed dsh missing", lines[4])
	}
}
