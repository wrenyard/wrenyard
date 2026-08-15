package claudeapp

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// ApplyPolicy applies the Claude Desktop policy for the given config. On
// non-Windows it only applies the local config. On Windows it writes registry
// policy (with elevation retry) and then applies local config.
func ApplyPolicy(cfg Config) error {
	if !isWindows() {
		return ApplyLocalConfig(cfg)
	}
	models, err := policyModels(cfg.Routes)
	if err != nil {
		return err
	}
	if !policyMatches(cfg, models) {
		values := policyValues(cfg, models)
		for _, value := range values {
			if err := regAdd(registryKey, value.name, value.typ, value.value); err != nil {
				if shouldRetryElevated(err) {
					if err := applyPolicyElevated(values); err != nil {
						return err
					}
					break
				}
				return err
			}
		}
	}
	return ApplyLocalConfig(cfg)
}

type policyValue struct {
	name  string
	typ   string
	value string
}

func policyValues(cfg Config, models string) []policyValue {
	return []policyValue{
		{"inferenceProvider", "REG_SZ", "gateway"},
		{"inferenceGatewayBaseUrl", "REG_SZ", cfg.GatewayBaseURL},
		{"inferenceGatewayApiKey", "REG_SZ", cfg.GatewayAPIKey},
		{"inferenceGatewayAuthScheme", "REG_SZ", gatewayAuthScheme},
		{"inferenceGatewayHeaders", "REG_SZ", GatewayHeadersJSON(cfg.GatewayAPIKey)},
		{"inferenceModels", "REG_SZ", models},
		{"isClaudeCodeForDesktopEnabled", "REG_DWORD", "1"},
		{"coworkEgressAllowedHosts", "REG_SZ", `["*"]`},
		{"forge_managed", "REG_SZ", "true"},
	}
}

func applyPolicyElevated(values []policyValue) error {
	script, err := policyPowerShell(values)
	if err != nil {
		return err
	}
	if err := runElevatedPowerShell(script); err != nil {
		return err
	}
	policy := QueryPolicyRaw()
	if policy["inferenceProvider"] != "gateway" || policy["forge_managed"] != "true" {
		return errors.New("forge app: elevated policy write did not verify; check the UAC prompt and Claude policy registry key")
	}
	return nil
}

func policyPowerShell(values []policyValue) (string, error) {
	var b strings.Builder
	b.WriteString("$ErrorActionPreference = 'Stop'\n")
	b.WriteString("function DecodeUtf8([string]$Value) { [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Value)) }\n")
	b.WriteString("$path = 'HKCU:\\SOFTWARE\\Policies\\Claude'\n")
	b.WriteString("New-Item -Path $path -Force | Out-Null\n")
	for _, value := range values {
		encoded := base64.StdEncoding.EncodeToString([]byte(value.value))
		if value.typ == "REG_DWORD" {
			b.WriteString(fmt.Sprintf("New-ItemProperty -LiteralPath $path -Name %s -Value %s -PropertyType DWord -Force | Out-Null\n", psQuote(value.name), psQuote(value.value)))
			continue
		}
		b.WriteString(fmt.Sprintf("New-ItemProperty -LiteralPath $path -Name %s -Value (DecodeUtf8 %s) -PropertyType String -Force | Out-Null\n", psQuote(value.name), psQuote(encoded)))
	}
	return b.String(), nil
}

func runElevatedPowerShell(script string) error {
	path := filepath.Join(os.TempDir(), fmt.Sprintf("forge-claude-app-%d.ps1", time.Now().UnixNano()))
	if err := os.WriteFile(path, []byte(script), 0o600); err != nil {
		return err
	}
	defer os.Remove(path)
	command := fmt.Sprintf("$script = %s; Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',$script) -Verb RunAs -WindowStyle Hidden -Wait", psQuote(path))
	cmd := exec.Command("powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command)
	hideCommandWindow(cmd)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("forge app: elevated PowerShell policy write failed: %s", strings.TrimSpace(string(out)))
	}
	return nil
}

func isAccessDeniedError(err error) bool {
	text := strings.ToLower(err.Error())
	return strings.Contains(text, "access is denied") || strings.Contains(text, "access denied") || strings.Contains(text, "拒绝访问")
}

func shouldRetryElevated(err error) bool {
	if err == nil {
		return false
	}
	text := strings.ToLower(err.Error())
	return isAccessDeniedError(err) || strings.Contains(text, "forge app: reg add ")
}

func policyMatches(cfg Config, models string) bool {
	if !isWindows() {
		return false
	}
	policy := QueryPolicyRaw()
	if len(policy) == 0 {
		return false
	}
	return policy["inferenceProvider"] == "gateway" &&
		policy["inferenceGatewayBaseUrl"] == cfg.GatewayBaseURL &&
		policy["inferenceGatewayApiKey"] == cfg.GatewayAPIKey &&
		policy["inferenceGatewayAuthScheme"] == gatewayAuthScheme &&
		policy["inferenceGatewayHeaders"] == GatewayHeadersJSON(cfg.GatewayAPIKey) &&
		policy["inferenceModels"] == models &&
		policy["coworkEgressAllowedHosts"] == `["*"]` &&
		policy["forge_managed"] == "true" &&
		regDwordIsOne(policy["isClaudeCodeForDesktopEnabled"])
}

func regDwordIsOne(value string) bool {
	clean := strings.TrimSpace(strings.ToLower(value))
	return clean == "1" || clean == "0x1" || clean == "0x00000001"
}

func policyModels(routes []ModelRoute) (string, error) {
	content, err := json.Marshal(localModelEntries(routes))
	if err != nil {
		return "", err
	}
	return string(content), nil
}

func regAdd(key, name, typ, value string) error {
	cmd := exec.Command("reg.exe", "add", key, "/v", name, "/t", typ, "/d", value, "/f")
	hideCommandWindow(cmd)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("forge app: reg add %s failed: %s", name, strings.TrimSpace(string(out)))
	}
	return nil
}

func psQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "''") + "'"
}

func regDeleteValue(key, name string) error {
	cmd := exec.Command("reg.exe", "delete", key, "/v", name, "/f")
	hideCommandWindow(cmd)
	out, err := cmd.CombinedOutput()
	if err == nil {
		return nil
	}
	text := strings.ToLower(string(out))
	if strings.Contains(text, "unable to find") || strings.Contains(text, "cannot find") || strings.Contains(text, "not found") {
		return nil
	}
	return fmt.Errorf("forge app: reg delete %s failed: %s", name, strings.TrimSpace(string(out)))
}

// ResetPolicy clears the registry policy and local Claude Desktop config.
func ResetPolicy() error {
	var failures []string
	if err := ClearPolicy(); err != nil {
		failures = append(failures, err.Error())
	}
	if err := ClearLocalConfig(); err != nil {
		failures = append(failures, err.Error())
	}
	if len(failures) > 0 {
		return errors.New(strings.Join(failures, "; "))
	}
	return nil
}

func ClearPolicy() error {
	if !isWindows() {
		return nil
	}
	var failures []string
	for _, name := range append(append([]string{}, managedPolicyNames...), "ccds_managed") {
		if err := regDeleteValue(registryKey, name); err != nil {
			failures = append(failures, err.Error())
		}
	}
	if len(failures) > 0 {
		return errors.New(strings.Join(failures, "; "))
	}
	return nil
}

// QueryPolicy reads the registry policy, redacting sensitive values.
func QueryPolicy() map[string]string {
	result := map[string]string{}
	for name, value := range QueryPolicyRaw() {
		result[name] = redactValue(name, value)
	}
	return result
}

func QueryPolicyRaw() map[string]string {
	cmd := exec.Command("reg.exe", "query", registryKey)
	hideCommandWindow(cmd)
	out, err := cmd.Output()
	if err != nil {
		return map[string]string{}
	}
	return parseRegQueryOutput(string(out))
}

func parseRegQueryOutput(content string) map[string]string {
	result := map[string]string{}
	for _, line := range strings.Split(content, "\n") {
		fields := strings.Fields(strings.TrimSpace(line))
		typeIndex := -1
		for i, field := range fields {
			if strings.HasPrefix(field, "REG_") {
				typeIndex = i
				break
			}
		}
		if typeIndex <= 0 || typeIndex >= len(fields)-1 {
			continue
		}
		name := strings.Join(fields[:typeIndex], " ")
		value := strings.Join(fields[typeIndex+1:], " ")
		result[name] = value
	}
	return result
}
