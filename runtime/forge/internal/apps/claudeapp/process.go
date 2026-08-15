package claudeapp

import (
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// Serve runs the proxy HTTP server on the configured port (foreground, used by
// the --forge-serve-proxy child process).
func Serve(cfg Config) int {
	server := &http.Server{
		Addr:              fmt.Sprintf("127.0.0.1:%d", cfg.Port),
		Handler:           NewProxy(cfg),
		ReadHeaderTimeout: 30 * time.Second,
	}
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	return 0
}

// Ensure starts the proxy process if the gateway is not already matching the
// config, returning whether a new process was started.
func Ensure(cfg Config) (bool, error) {
	if ok, err := GatewayMatches(cfg); ok && err == nil {
		return false, nil
	}
	if stopped, err := StopProcesses(); err != nil {
		return false, err
	} else if stopped > 0 {
		time.Sleep(500 * time.Millisecond)
	}
	if err := StartProcess(cfg); err != nil {
		return false, err
	}
	deadline := time.Now().Add(8 * time.Second)
	for time.Now().Before(deadline) {
		if ok, err := GatewayMatches(cfg); ok && err == nil {
			return true, nil
		}
		time.Sleep(250 * time.Millisecond)
	}
	if status, err := ReadGatewayStatus(cfg.GatewayBaseURL); err == nil {
		return false, fmt.Errorf("forge app: gateway at %s is not serving profile %s: %v", cfg.GatewayBaseURL, cfg.Profile.Name, status)
	}
	return false, fmt.Errorf("forge app: gateway at %s did not become healthy; check %s", cfg.GatewayBaseURL, logDir())
}

func StopProcesses() (int, error) {
	if !isWindows() {
		return stopProcessesUnix()
	}
	script := `$items = Get-CimInstance Win32_Process -Filter "name = 'forge.exe'" | Where-Object { $_.CommandLine -match '--forge-serve-proxy' }
$count = 0
foreach ($item in $items) {
  Stop-Process -Id $item.ProcessId -Force
  $count += 1
}
	Write-Output $count`
	cmd := exec.Command("powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script)
	hideCommandWindow(cmd)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return 0, fmt.Errorf("forge app: failed to stop existing proxy: %s", strings.TrimSpace(string(out)))
	}
	count, _ := strconv.Atoi(strings.TrimSpace(string(out)))
	return count, nil
}

func stopProcessesUnix() (int, error) {
	cmd := exec.Command("ps", "-axo", "pid=,command=")
	hideCommandWindow(cmd)
	out, err := cmd.Output()
	if err != nil {
		return 0, fmt.Errorf("forge app: failed to list existing proxy processes: %w", err)
	}
	pids := proxyPIDsFromPS(string(out), os.Getpid())
	var failures []string
	for _, pid := range pids {
		proc, err := os.FindProcess(pid)
		if err != nil {
			failures = append(failures, fmt.Sprintf("%d: %v", pid, err))
			continue
		}
		if err := proc.Kill(); err != nil {
			failures = append(failures, fmt.Sprintf("%d: %v", pid, err))
		}
	}
	if len(failures) > 0 {
		return len(pids) - len(failures), fmt.Errorf("forge app: failed to stop existing proxy: %s", strings.Join(failures, "; "))
	}
	return len(pids), nil
}

func proxyPIDsFromPS(content string, currentPID int) []int {
	pids := []int{}
	for _, line := range strings.Split(content, "\n") {
		fields := strings.Fields(strings.TrimSpace(line))
		if len(fields) < 2 {
			continue
		}
		pid, err := strconv.Atoi(fields[0])
		if err != nil || pid == currentPID {
			continue
		}
		command := strings.Join(fields[1:], " ")
		if strings.Contains(command, "--forge-serve-proxy") && !strings.Contains(command, " rg ") {
			pids = append(pids, pid)
		}
	}
	return pids
}

func StartProcess(cfg Config) error {
	exe, err := currentForgePath()
	if err != nil {
		return err
	}
	logDir := logDir()
	if err := os.MkdirAll(logDir, 0o700); err != nil {
		return err
	}
	stdout, err := os.OpenFile(filepath.Join(logDir, "claude-app-proxy.out.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	stderr, err := os.OpenFile(filepath.Join(logDir, "claude-app-proxy.err.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		_ = stdout.Close()
		return err
	}
	cmd := exec.Command(exe, "app", "use", cfg.Profile.Name, "--port", strconv.Itoa(cfg.Port), "--forge-serve-proxy")
	hideCommandWindow(cmd)
	if repo, err := repoDir(); err == nil {
		cmd.Dir = repo
	}
	cmd.Stdout = stdout
	cmd.Stderr = stderr
	if err := cmd.Start(); err != nil {
		_ = stdout.Close()
		_ = stderr.Close()
		return err
	}
	_ = cmd.Process.Release()
	_ = stdout.Close()
	_ = stderr.Close()
	return nil
}

func logDir() string {
	if isWindows() {
		if base := os.Getenv("LOCALAPPDATA"); base != "" {
			return filepath.Join(base, "Forge")
		}
	}
	if base := os.Getenv("XDG_STATE_HOME"); base != "" {
		return filepath.Join(base, "forge")
	}
	return filepath.Join(userHome(), ".local", "state", "forge")
}

// currentForgePath and repoDir are package-level resolvers defaulting to minimal
// behavior; the root package installs real implementations via ConfigurePaths so
// the process code stays decoupled from the root forge package.
var (
	currentForgePath = func() (string, error) {
		exe, err := os.Executable()
		if err != nil {
			return "", err
		}
		if resolved, err := filepath.EvalSymlinks(exe); err == nil {
			exe = resolved
		}
		return filepath.Abs(exe)
	}
	repoDir = func() (string, error) { return "", errors.New("repo dir not configured") }
)

// ConfigurePaths installs the runtime path resolvers from the root package.
func ConfigurePaths(current func() (string, error), repo func() (string, error)) {
	if current != nil {
		currentForgePath = current
	}
	if repo != nil {
		repoDir = repo
	}
}
