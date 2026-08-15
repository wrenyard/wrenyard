<#
.SYNOPSIS
    wrenyard installer/updater (Windows)

.DESCRIPTION
    Downloads a checksum-verified suite zip, validates that the suite contains
    the wrenyard executable and the release manifest, installs the suite
    under <Prefix>\versions\<version>, and safely updates the `current` link and
    the single public wrenyard launcher shim. Old versions are retained.

    This script only moves prebuilt artifacts into place. It never invokes
    go/npm/pnpm, never changes execution policy, and never writes secrets to
    logs (optional private-mirror auth travels as an Authorization header).

.PARAMETER Version
    Version to install (e.g. 1.0.0-dev.0).
.PARAMETER Prefix
    Install root (default: $env:LOCALAPPDATA\wrenyard).
.PARAMETER BinDir
    Directory for launcher shims (default: <Prefix>\bin).
.PARAMETER Url
    Suite zip URL (default: derived from the GitHub release).
.PARAMETER ChecksumUrl
    .sha256 sidecar URL (default: <Url>.sha256).
.PARAMETER Update
    Install the newest non-draft release (prereleases included).

.EXAMPLE
    .\install.ps1 -Version 1.0.0-dev.0 -Prefix "$env:LOCALAPPDATA\wrenyard"
#>
[CmdletBinding()]
param(
    [string]$Version = '',
    [string]$Prefix = '',
    [string]$BinDir = '',
    [string]$Url = '',
    [string]$ChecksumUrl = '',
    [switch]$Update
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-Log { Write-Host "install.ps1: $($args -join ' ')" }
function Die([string]$Message) { throw "install.ps1: $Message" }

# --- Resolve defaults ------------------------------------------------------
if (-not $Prefix) {
    $Prefix = if ($env:WRENYARD_PREFIX) { $env:WRENYARD_PREFIX } else { Join-Path $env:LOCALAPPDATA 'wrenyard' }
}
$Prefix = [System.IO.Path]::GetFullPath($Prefix)
$BinDir = if ($BinDir) { [System.IO.Path]::GetFullPath($BinDir) } else { Join-Path $Prefix 'bin' }

$Repo = if ($env:WRENYARD_GITHUB_REPOSITORY) { $env:WRENYARD_GITHUB_REPOSITORY } else { 'wrenyard/wrenyard' }

# --- Optional private-mirror auth -------------------------------------------
# The token is passed as an Authorization header and never written to logs.
$token = if ($env:GH_TOKEN) { $env:GH_TOKEN } elseif ($env:GITHUB_TOKEN) { $env:GITHUB_TOKEN } else { '' }
$headers = @{ 'User-Agent' = 'wrenyard-install' }
if ($token) { $headers['Authorization'] = "Bearer $token" }

if (-not $Version) {
    if ($Update) {
        # Newest non-draft release from the full releases list, prereleases
        # included, so the latest v1.0.0-dev.* prerelease is selected.
        $releases = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases?per_page=100" -Headers $headers
        $release = $releases | Where-Object { -not $_.draft } | Sort-Object published_at -Descending | Select-Object -First 1
        if (-not $release) { Die "could not resolve the latest non-draft release tag for $Repo" }
        $Version = [string]$release.tag_name -replace '^v', ''
    } else {
        Die 'a -Version is required (or pass -Update to install the latest release)'
    }
}

# --- Path hygiene ----------------------------------------------------------
if ($Version -match '[/\\]' -or $Version -match '\.\.' -or $Version -match '\s') {
    Die "invalid version: $Version"
}

$DirVersion = $Version -replace '^v', ''
$Tag = if ($Version -match '^v') { $Version } else { "v$Version" }
if ($env:PROCESSOR_ARCHITECTURE -ne 'AMD64' -and $env:PROCESSOR_ARCHITECTURE -ne 'x86_64') {
    Die "unsupported processor architecture: $env:PROCESSOR_ARCHITECTURE (supported: AMD64/x86_64)"
}
if (-not $Url) { $Url = "https://github.com/$Repo/releases/download/$Tag/wrenyard-$DirVersion-win32-x64-suite.zip" }
if (-not $ChecksumUrl) { $ChecksumUrl = "$Url.sha256" }

$VersionsDir = Join-Path $Prefix 'versions'
$VersionDir = Join-Path $VersionsDir $DirVersion
$CurrentLink = Join-Path $Prefix 'current'

# --- Helpers ---------------------------------------------------------------
function Find-Artifact {
    param([string]$Root, [string]$Name)
    Get-ChildItem -Path $Root -Recurse -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -eq $Name -or $_.Name -eq "$Name.exe" } |
        Select-Object -First 1
}

function Relative-To {
    param([string]$Path, [string]$Root)
    $full = [System.IO.Path]::GetFullPath($Path)
    $root = [System.IO.Path]::GetFullPath($Root).TrimEnd('\')
    if ($full.StartsWith($root + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
        return $full.Substring($root.Length)
    }
    return $full
}

function Remove-LinkOnly {
    param([string]$Path)
    # Never follow a symlink/junction into its version target: only the link
    # itself may be deleted. The existing `current` entry must be a reparse
    # point (symbolic link or junction); a plain directory is refused rather
    # than recursively deleted, so a misconfigured link can never take the
    # versions tree down with it.
    $item = Get-Item -LiteralPath $Path -Force
    if (-not ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
        Die "'$Path' is not a link; refusing to delete it recursively"
    }
    if ($item.LinkType -eq 'SymbolicLink') {
        # Symbolic link: Remove-Item without -Recurse deletes only the link.
        Remove-Item -LiteralPath $Path -Force
    } else {
        # Junction (or other directory reparse point): delete the link only.
        [System.IO.Directory]::Delete($Path)
    }
}

function Switch-Link {
    param([string]$Target, [string]$Path)
    if (Test-Path $Path) { Remove-LinkOnly -Path $Path }
    try {
        New-Item -ItemType SymbolicLink -Path $Path -Target $Target -ErrorAction Stop | Out-Null
        return $true
    } catch {
        # Real symlinks need Developer Mode/elevation; fall back to a junction
        # for directory links (the `current` link) when permitted.
        if (-not (Get-Item $Target).PSIsContainer) { return $false }
        try {
            $cmd = 'mklink /J "{0}" "{1}"' -f $Path, $Target
            $null = cmd /c $cmd 2>&1
            return (Test-Path $Path)
        } catch {
            return $false
        }
    }
}

function Write-Shim {
    param([string]$Name, [string]$Target)
    $shim = Join-Path $BinDir "$Name.cmd"
    Set-Content -Path $shim -Value "@echo off`r`n`"$Target`" %*`r`n" -Encoding ASCII
}

function Write-NodeShim {
    param([string]$Name, [string]$Node, [string]$Script)
    $shim = Join-Path $BinDir "$Name.cmd"
    Set-Content -Path $shim -Value "@echo off`r`n`"$Node`" `"$Script`" %*`r`n" -Encoding ASCII
}

# --- Download + checksum verification --------------------------------------
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("wrenyard-install-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
    $zipPath = Join-Path $tmp 'suite.zip'
    $shaPath = Join-Path $tmp 'suite.zip.sha256'
    Write-Log "downloading suite: $Url"
    Invoke-WebRequest -Uri $Url -OutFile $zipPath -UseBasicParsing -Headers $headers
    Write-Log "downloading checksum sidecar: $ChecksumUrl"
    Invoke-WebRequest -Uri $ChecksumUrl -OutFile $shaPath -UseBasicParsing -Headers $headers

    $expected = ((Get-Content $shaPath | Select-Object -First 1).Split(' ')[0]).Trim().ToLowerInvariant()
    if (-not $expected) { Die "checksum sidecar is empty: $ChecksumUrl" }
    $actual = (Get-FileHash -Algorithm SHA256 -Path $zipPath).Hash.ToLowerInvariant()
    if ($actual -ne $expected) { Die "checksum mismatch for $Url (expected $expected, got $actual)" }
    Write-Log "checksum verified ($actual)"

    $extract = Join-Path $tmp 'extract'
    Expand-Archive -Path $zipPath -DestinationPath $extract -Force

    $wrenyard = Find-Artifact -Root $extract -Name 'wrenyard'
    $manifest = Find-Artifact -Root $extract -Name 'release-manifest.json'
    if (-not $manifest) { $manifest = Find-Artifact -Root $extract -Name 'manifest.json' }
    if (-not $wrenyard) { Die 'suite zip does not contain a wrenyard executable' }
    if (-not $manifest) { Die 'suite zip does not contain a release manifest' }

    # --- Install (an existing version directory is never reused) -------------
    # The checksum-verified archive must always win, so a same-version
    # reinstall replaces any locally tampered content. The extracted suite is
    # staged beside the version directory, validated there, and swapped in
    # with backup-and-restore semantics before `current` or any shim is
    # touched.
    New-Item -ItemType Directory -Path $VersionsDir -Force | Out-Null
    New-Item -ItemType Directory -Path $BinDir -Force | Out-Null

    $stagingDir = Join-Path $VersionsDir ('.' + $DirVersion + '.staging.' + [Guid]::NewGuid().ToString('N'))
    $backupDir = Join-Path $VersionsDir ('.' + $DirVersion + '.backup.' + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $stagingDir -Force | Out-Null
    Copy-Item -Path (Join-Path $extract '*') -Destination $stagingDir -Recurse -Force

    $wrenyardInstalled = Find-Artifact -Root $stagingDir -Name 'wrenyard'
    if (-not $wrenyardInstalled) { Die 'installed suite is missing the wrenyard executable' }

    # Validate the executable and manifest before wiring anything up.
    if ((Get-Item $wrenyardInstalled.FullName).Length -le 0) { Die 'wrenyard executable is empty' }
    try { Get-Content -Raw -Path $manifest.FullName | ConvertFrom-Json | Out-Null }
    catch { Die "release manifest is not valid JSON: $($manifest.FullName)" }

    # Replace VersionDir from the validated staging copy using backup-and-
    # restore semantics; the old version stays recoverable if the swap fails.
    if (Test-Path $VersionDir) {
        Move-Item -Path $VersionDir -Destination $backupDir -Force
    }
    try {
        Move-Item -Path $stagingDir -Destination $VersionDir -ErrorAction Stop
    } catch {
        if (Test-Path $backupDir) { Move-Item -Path $backupDir -Destination $VersionDir -Force }
        throw
    }
    Remove-Item -Path $backupDir -Recurse -Force -ErrorAction SilentlyContinue

    # Re-resolve the installed artifact paths through the activated version dir.
    $wrenyardInstalled = Find-Artifact -Root $VersionDir -Name 'wrenyard'

    $oldVersion = $null
    if (Test-Path $CurrentLink) {
        $current = Get-Item $CurrentLink
        if ($current.LinkType) { $oldVersion = Split-Path -Leaf $current.Target }
    }

    $currentOk = Switch-Link -Target $VersionDir -Path $CurrentLink
    if (-not $currentOk) {
        Write-Log 'could not create the current link; launchers will target the version directory directly'
    }

    # Only the wrenyard command is a public shim; the internal Foreman control
    # and the Forge runtime remain hidden inside the installed suite.
    $rel = Relative-To -Path $wrenyardInstalled.FullName -Root $VersionDir
    $target = if ($currentOk) { Join-Path $CurrentLink $rel.TrimStart('\') } else { $wrenyardInstalled.FullName }
    Write-Shim -Name 'wrenyard' -Target $target

    Write-Log "installed wrenyard $DirVersion at $VersionDir"
    Write-Host "wrenyard $DirVersion installed"
    Write-Host "  current:   $CurrentLink -> $VersionDir"
    Write-Host "  launcher:  $(Join-Path $BinDir 'wrenyard.cmd')"
    if ($oldVersion -and $oldVersion -ne $DirVersion) {
        Write-Log "previous version retained: $oldVersion"
        Write-Log "rollback: re-run with -Version $oldVersion -Prefix $Prefix"
    } else {
        Write-Host "rollback: old versions are retained under $VersionsDir"
    }
} finally {
    Remove-Item -Path $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
