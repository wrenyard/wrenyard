package shell

import (
	"fmt"
	"runtime"
	"strings"
)

// --- PowerShell quoting ---

func powerShellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "''") + "'"
}

func powerShellArray(values []string) string {
	if len(values) == 0 {
		return "@()"
	}
	quoted := make([]string, 0, len(values))
	for _, value := range values {
		quoted = append(quoted, powerShellQuote(value))
	}
	return "@(" + strings.Join(quoted, ", ") + ")"
}

// --- PowerShell rendering ---

// RenderManagedPowerShell renders the forge.ps1 managed shell file.
func RenderManagedPowerShell(
	profiles map[string]Profile,
	funcNames []string,
	forgeBin string,
	credResolver func(string) (string, bool),
	managedProvider func(string) bool,
) string {
	var b strings.Builder
	b.WriteString("# forge.ps1 - Managed by forge setup. Do not edit manually.\n")
	b.WriteString("# Source this file from your PowerShell profile.\n\n")
	for _, name := range funcNames {
		p, ok := profiles[name]
		if !ok {
			continue
		}
		if isRawClaudeAliasProfile(p) {
			b.WriteString(renderPowerShellRawClaudeAliasProfile(name, p))
			continue
		}
		if providerSupportsCCShortcut(p.Provider) {
			if rendered, err := renderPowerShellDirectClaudeProfile(name, p, forgeBin, credResolver, managedProvider); err == nil {
				b.WriteString(rendered)
			}
			continue
		}
		b.WriteString(renderPowerShellRawClaudeAliasProfile(name, p))
	}
	return b.String()
}

func renderPowerShellRawClaudeAliasProfile(name string, p Profile) string {
	command := claudeShortcutCommand(p)
	var b strings.Builder
	b.WriteString("function ")
	b.WriteString(name)
	b.WriteString(" {\n")
	if len(command) > 1 {
		b.WriteString("    $forgeCommandArgs = ")
		b.WriteString(powerShellArray(command[1:]))
		b.WriteString("\n")
		b.WriteString("    $forgeCommandArgs += $args\n")
		b.WriteString("    & ")
		b.WriteString(powerShellQuote(command[0]))
		b.WriteString(" @forgeCommandArgs\n")
	} else {
		b.WriteString("    & ")
		b.WriteString(powerShellQuote(command[0]))
		b.WriteString(" @args\n")
	}
	b.WriteString("}\n")
	return b.String()
}

func renderPowerShellDirectClaudeProfile(
	name string,
	p Profile,
	forgeBin string,
	credResolver func(string) (string, bool),
	managedProvider func(string) bool,
) (string, error) {
	p.Name = nonEmpty(p.Name, name)
	command := claudeShortcutCommand(p)

	apiKey := p.Env["ANTHROPIC_API_KEY"]
	// SecretRef resolution is handled by the root facade; the shell
	// package only performs provider-based credential resolution.
	if p.Provider != "" {
		cred, ok := credResolver(p.Provider)
		if !ok || cred == "" {
			if managedProvider(p.Provider) {
				return "", fmt.Errorf("no credential for provider %q; run forge auth login %s", p.Provider, p.Provider)
			}
		} else {
			apiKey = cred
		}
	}

	shellEnv := directClaudeEnv(p, apiKey)
	settingsEnv := directClaudeSettingsEnv(p, apiKey)
	settingsJSON := claudeSettingsJSON(p, settingsEnv)

	var b strings.Builder
	b.WriteString("function ")
	b.WriteString(name)
	b.WriteString(" {\n")
	b.WriteString("    $forgeDataHome = [Environment]::GetEnvironmentVariable('XDG_DATA_HOME', 'Process')\n")
	b.WriteString("    if (-not $forgeDataHome) { $forgeDataHome = Join-Path $HOME '.local\\share' }\n")
	b.WriteString("    $forgeClaudeRoot = Join-Path $forgeDataHome 'wrenyard\\runtime\\claude\\shell-cc'\n")
	b.WriteString("    $forgeClaudeConfigDir = Join-Path $forgeClaudeRoot 'config'\n")
	b.WriteString("    $forgeClaudeJobDir = Join-Path $forgeClaudeRoot 'jobs'\n")
	b.WriteString("    New-Item -ItemType Directory -Force -Path $forgeClaudeConfigDir, $forgeClaudeJobDir | Out-Null\n")
	b.WriteString("    $forgeClaudeSettings = Join-Path $forgeClaudeConfigDir 'settings.json'\n")
	b.WriteString("    $forgeClaudeSettingsPatch = ")
	b.WriteString(powerShellQuote(settingsJSON))
	b.WriteString("\n")
	b.WriteString("    $forgeSettingsEnv = [ordered]@{\n")
	b.WriteString("        'FORGE_SETTINGS_PATH' = $forgeClaudeSettings\n")
	b.WriteString("        'FORGE_SETTINGS_PATCH' = $forgeClaudeSettingsPatch\n")
	b.WriteString("    }\n")
	b.WriteString("    $forgePreviousSettingsEnv = @{}\n")
	b.WriteString("    foreach ($forgeKey in $forgeSettingsEnv.Keys) {\n")
	b.WriteString("        $forgePreviousSettingsEnv[$forgeKey] = [Environment]::GetEnvironmentVariable($forgeKey, 'Process')\n")
	b.WriteString("        [Environment]::SetEnvironmentVariable($forgeKey, $forgeSettingsEnv[$forgeKey], 'Process')\n")
	b.WriteString("    }\n")
	b.WriteString("    try {\n")
	b.WriteString("        & 'node' '-e' ")
	b.WriteString(powerShellQuote(claudeSettingsMergeScript()))
	b.WriteString("\n")
	b.WriteString("        if ($LASTEXITCODE -ne 0) { Set-Content -LiteralPath $forgeClaudeSettings -Encoding UTF8 -Value $forgeClaudeSettingsPatch }\n")
	b.WriteString("    } finally {\n")
	b.WriteString("        foreach ($forgeKey in $forgeSettingsEnv.Keys) {\n")
	b.WriteString("            [Environment]::SetEnvironmentVariable($forgeKey, $forgePreviousSettingsEnv[$forgeKey], 'Process')\n")
	b.WriteString("        }\n")
	b.WriteString("    }\n")
	b.WriteString(renderPowerShellClaudeCleanStart())
	b.WriteString("    $forgeProfileArgs = @()\n")
	b.WriteString("    $forgeProjectSettings = Join-Path (Get-Location) '.claude\\settings.json'\n")
	b.WriteString("    if (Test-Path -LiteralPath $forgeProjectSettings -PathType Leaf) { $forgeProfileArgs += @('--settings', $forgeProjectSettings) }\n")
	b.WriteString("    $forgeProfileArgs += $args\n")
	b.WriteString("    $forgeCommandArgs = @()\n")
	if len(command) > 1 {
		b.WriteString("    $forgeCommandArgs += ")
		b.WriteString(powerShellArray(command[1:]))
		b.WriteString("\n")
	}
	b.WriteString("    $forgeCommandArgs += $forgeProfileArgs\n")
	b.WriteString("    $forgeEnv = [ordered]@{\n")
	b.WriteString("        'CLAUDE_CONFIG_DIR' = $forgeClaudeConfigDir\n")
	b.WriteString("        'CLAUDE_JOB_DIR' = $forgeClaudeJobDir\n")
	for _, key := range sortedStringKeys(shellEnv) {
		b.WriteString("        ")
		b.WriteString(powerShellQuote(key))
		b.WriteString(" = ")
		b.WriteString(powerShellQuote(shellEnv[key]))
		b.WriteString("\n")
	}
	b.WriteString("    }\n")
	b.WriteString("    $forgePreviousEnv = @{}\n")
	b.WriteString("    foreach ($forgeKey in $forgeEnv.Keys) {\n")
	b.WriteString("        $forgePreviousEnv[$forgeKey] = [Environment]::GetEnvironmentVariable($forgeKey, 'Process')\n")
	b.WriteString("        [Environment]::SetEnvironmentVariable($forgeKey, $forgeEnv[$forgeKey], 'Process')\n")
	b.WriteString("    }\n")
	b.WriteString("    $forgeProviderEnvKeys = @('ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY')\n")
	b.WriteString("    $forgePreviousProviderEnv = @{}\n")
	b.WriteString("    foreach ($forgeKey in $forgeProviderEnvKeys) {\n")
	b.WriteString("        $forgePreviousProviderEnv[$forgeKey] = [Environment]::GetEnvironmentVariable($forgeKey, 'Process')\n")
	b.WriteString("        [Environment]::SetEnvironmentVariable($forgeKey, $null, 'Process')\n")
	b.WriteString("    }\n")
	b.WriteString("    try {\n")
	b.WriteString("        & ")
	b.WriteString(powerShellQuote(forgeBin))
	b.WriteString(" 'shell' 'exec' ")
	b.WriteString(powerShellQuote(p.Name))
	b.WriteString(" '--' ")
	b.WriteString(powerShellQuote(command[0]))
	b.WriteString(" @forgeCommandArgs\n")
	b.WriteString("    } finally {\n")
	b.WriteString("        foreach ($forgeKey in $forgeEnv.Keys) {\n")
	b.WriteString("            [Environment]::SetEnvironmentVariable($forgeKey, $forgePreviousEnv[$forgeKey], 'Process')\n")
	b.WriteString("        }\n")
	b.WriteString("        foreach ($forgeKey in $forgeProviderEnvKeys) {\n")
	b.WriteString("            [Environment]::SetEnvironmentVariable($forgeKey, $forgePreviousProviderEnv[$forgeKey], 'Process')\n")
	b.WriteString("        }\n")
	b.WriteString("    }\n")
	b.WriteString("}\n")
	return b.String(), nil
}

func renderPowerShellClaudeCleanStart() string {
	var b strings.Builder
	b.WriteString("    $forgePreviousClaudeConfigDir = [Environment]::GetEnvironmentVariable('CLAUDE_CONFIG_DIR', 'Process')\n")
	b.WriteString("    [Environment]::SetEnvironmentVariable('CLAUDE_CONFIG_DIR', $forgeClaudeConfigDir, 'Process')\n")
	b.WriteString("    try {\n")
	b.WriteString("        & 'claude' 'daemon' 'stop' '--any' *> $null\n")
	b.WriteString("    } finally {\n")
	b.WriteString("        [Environment]::SetEnvironmentVariable('CLAUDE_CONFIG_DIR', $forgePreviousClaudeConfigDir, 'Process')\n")
	b.WriteString("    }\n")
	if runtime.GOOS == "windows" {
		b.WriteString("    $forgeSelfPid = $PID\n")
		b.WriteString("    $forgeClaudeProcesses = @(Get-CimInstance Win32_Process | Where-Object {\n")
		b.WriteString("        $_.ProcessId -ne $forgeSelfPid -and (\n")
		b.WriteString("            $_.Name -match '^(claude|claude-code)(\\.exe)?$' -or\n")
		b.WriteString("            ($_.CommandLine -and ($_.CommandLine -match '@anthropic-ai[\\\\/]+claude-code' -or $_.CommandLine -match '[\\\\/]claude(\\.exe)?(\\s|$)'))\n")
		b.WriteString("        )\n")
		b.WriteString("    })\n")
		b.WriteString("    foreach ($forgeProc in $forgeClaudeProcesses) { Stop-Process -Id $forgeProc.ProcessId -Force -ErrorAction SilentlyContinue }\n")
		b.WriteString("    if ($forgeClaudeProcesses.Count -gt 0) { Start-Sleep -Milliseconds 250 }\n")
		return b.String()
	}
	b.WriteString("    $forgeClaudePattern = '(^|[/\\\\])claude([ ._-]|$)|@anthropic-ai[/\\\\]claude-code'\n")
	b.WriteString("    if (Get-Command pkill -ErrorAction SilentlyContinue) {\n")
	b.WriteString("        & 'pkill' '-f' $forgeClaudePattern *> $null\n")
	b.WriteString("        if ($LASTEXITCODE -eq 0) { Start-Sleep -Milliseconds 250 }\n")
	b.WriteString("        & 'pkill' '-9' '-f' $forgeClaudePattern *> $null\n")
	b.WriteString("    } else {\n")
	b.WriteString("        $forgeClaudeProcesses = @(& 'ps' '-A' '-o' 'pid=,command=' | Where-Object { $_ -match $forgeClaudePattern })\n")
	b.WriteString("        foreach ($forgeProc in $forgeClaudeProcesses) {\n")
	b.WriteString("            if ($forgeProc -match '^\\s*(\\d+)') {\n")
	b.WriteString("                $forgePid = $Matches[1]\n")
	b.WriteString("                if ($forgePid -ne $PID) { & 'kill' $forgePid *> $null }\n")
	b.WriteString("            }\n")
	b.WriteString("        }\n")
	b.WriteString("        if ($forgeClaudeProcesses.Count -gt 0) { Start-Sleep -Milliseconds 250 }\n")
	b.WriteString("        $forgeClaudeProcesses = @(& 'ps' '-A' '-o' 'pid=,command=' | Where-Object { $_ -match $forgeClaudePattern })\n")
	b.WriteString("        foreach ($forgeProc in $forgeClaudeProcesses) {\n")
	b.WriteString("            if ($forgeProc -match '^\\s*(\\d+)') {\n")
	b.WriteString("                $forgePid = $Matches[1]\n")
	b.WriteString("                if ($forgePid -ne $PID) { & 'kill' '-9' $forgePid *> $null }\n")
	b.WriteString("            }\n")
	b.WriteString("        }\n")
	b.WriteString("    }\n")
	return b.String()
}
