<#
.SYNOPSIS
    wrenyard installer/updater (Windows)

.DESCRIPTION
    Downloads a digest-verified suite zip, validates the wrenyard executable
    and release manifest, and installs it under <Prefix>\versions\<version>
    before safely updating the `current` link and the public launcher shim.
    Old versions are retained.

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
    Suite zip URL. Requires -ChecksumUrl.
.PARAMETER ChecksumUrl
    Explicit suite .sha256 sidecar URL for -Url.
.PARAMETER SuiteOnly
    Install/update the suite without the Desktop app.
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
    [switch]$SuiteOnly,
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

$releaseInfo = $null
if (-not $Version) {
    if ($Update) {
        # Newest non-draft release from the full releases list, prereleases
        # included, so the latest v1.0.0-dev.* prerelease is selected.
        $releases = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases?per_page=100" -Headers $headers
        $releaseInfo = $releases | Where-Object { -not $_.draft } | Sort-Object published_at -Descending | Select-Object -First 1
        if (-not $releaseInfo) { Die "could not resolve the latest non-draft release tag for $Repo" }
        $Version = [string]$releaseInfo.tag_name -replace '^v', ''
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
$CustomUrl = [bool]$Url
$AssetName = "wrenyard-$DirVersion-win32-x64-suite.zip"
if (-not $Url) { $Url = "https://github.com/$Repo/releases/download/$Tag/wrenyard-$DirVersion-win32-x64-suite.zip" }
if ($CustomUrl -and -not $ChecksumUrl) { Die '-Url requires -ChecksumUrl' }
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

function Copy-DirectoryTree {
    param([string]$Source, [string]$Destination)
    # PowerShell Copy-Item still fails on deeply nested node_modules paths on
    # Windows even when the underlying filesystem supports long paths.
    # Robocopy uses the native long-path-aware copy implementation. Exit codes
    # 0-7 are successful outcomes; 8 and above report at least one failure.
    & robocopy.exe $Source $Destination /E /COPY:DAT /DCOPY:DAT /R:2 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) {
        Die "robocopy failed with exit code $LASTEXITCODE while staging $Source"
    }
}

function Remove-LinkOnly {
    param([string]$Path)
    # Never follow a symlink/junction into its version target: only the link
    # itself may be deleted. The existing `current` entry must be a reparse
    # point (symbolic link or junction); a plain directory is refused rather
    # than recursively deleted, so a misconfigured link can never take the
    # versions tree down with it.
    #
    # Windows-safe removal: PowerShell 7's Remove-Item throws a
    # NullReferenceException when deleting a directory symbolic link on
    # windows-latest during a second same-version install, so the link is
    # deleted with System.IO instead. Directory.Delete removes the link itself
    # for directory containers (symbolic links and junctions) without
    # recursing into or following the target; File.Delete covers the
    # non-container reparse-point case.
    $item = Get-Item -LiteralPath $Path -Force
    if (-not ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
        Die "'$Path' is not a link; refusing to delete it recursively"
    }
    if ($item.PSIsContainer) {
        [System.IO.Directory]::Delete($Path)
    } else {
        [System.IO.File]::Delete($Path)
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

function Get-Sha256 {
    param([string]$Path)
    # SHA-256 without a module-backed hashing cmdlet: the checksum must not
    # depend on Microsoft.PowerShell.Utility, which may be unavailable in
    # constrained PowerShell hosts. Uses only .NET APIs and
    # disposes the native stream and hash resources in a finally block.
    $stream = $null
    $sha = $null
    try {
        $stream = [System.IO.File]::OpenRead($Path)
        $sha = [System.Security.Cryptography.SHA256]::Create()
        $hash = $sha.ComputeHash($stream)
        return [System.BitConverter]::ToString($hash).Replace('-', '').ToLowerInvariant()
    } finally {
        if ($sha) { $sha.Dispose() }
        if ($stream) { $stream.Dispose() }
    }
}

# --- Download + checksum verification --------------------------------------
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("wrenyard-install-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
    $zipPath = Join-Path $tmp 'suite.zip'
    Write-Log "downloading suite: $Url"
    Invoke-WebRequest -Uri $Url -OutFile $zipPath -UseBasicParsing -Headers $headers
    if ($ChecksumUrl) {
        $shaPath = Join-Path $tmp 'suite.zip.sha256'
        Write-Log "downloading explicit checksum sidecar: $ChecksumUrl"
        Invoke-WebRequest -Uri $ChecksumUrl -OutFile $shaPath -UseBasicParsing -Headers $headers
        $expected = ((Get-Content $shaPath | Select-Object -First 1).Split(' ')[0]).Trim().ToLowerInvariant()
        if ($expected -notmatch '^[0-9a-f]{64}$') { Die "checksum sidecar is invalid: $ChecksumUrl" }
    } else {
        Write-Log "resolving GitHub asset digest: $AssetName"
        if (-not $releaseInfo -or [string]$releaseInfo.tag_name -ne $Tag) {
            $releaseInfo = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/tags/$Tag" -Headers $headers
        }
        $asset = $releaseInfo.assets | Where-Object { [string]$_.name -eq $AssetName } | Select-Object -First 1
        if (-not $asset) { Die "release $Tag has no asset named $AssetName" }
        $digestMatch = [regex]::Match([string]$asset.digest, '^sha256:([0-9a-fA-F]{64})$')
        if (-not $digestMatch.Success) { Die "release $Tag has no SHA-256 digest for $AssetName" }
        $expected = $digestMatch.Groups[1].Value.ToLowerInvariant()
    }
    $actual = Get-Sha256 -Path $zipPath
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
    # before `current` or any shim is touched.
    New-Item -ItemType Directory -Path $VersionsDir -Force | Out-Null
    New-Item -ItemType Directory -Path $BinDir -Force | Out-Null

    $stagingDir = Join-Path $VersionsDir ('.' + $DirVersion + '.staging.' + [Guid]::NewGuid().ToString('N'))
    $backupDir = Join-Path $VersionsDir ('.' + $DirVersion + '.backup.' + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $stagingDir -Force | Out-Null
    Copy-DirectoryTree -Source $extract -Destination $stagingDir

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

    # One-command bootstrap also installs the matching Desktop archive. The
    # Desktop update helper invokes this script through `wrenyard update` with
    # -SuiteOnly so the running app can replace itself after exit.
    if (-not $SuiteOnly) {
        $desktopAssetName = "wrenyard-desktop-$DirVersion-win32-x64.zip"
        if (-not $releaseInfo -or [string]$releaseInfo.tag_name -ne $Tag) {
            $releaseInfo = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/tags/$Tag" -Headers $headers
        }
        $desktopAsset = $releaseInfo.assets | Where-Object { [string]$_.name -eq $desktopAssetName } | Select-Object -First 1
        if (-not $desktopAsset) { Die "release $Tag has no asset named $desktopAssetName" }
        $desktopDigest = [regex]::Match([string]$desktopAsset.digest, '^sha256:([0-9a-fA-F]{64})$')
        if (-not $desktopDigest.Success) {
            Die "release $Tag has no SHA-256 digest for $desktopAssetName"
        }
        $desktopUrl = [string]$desktopAsset.browser_download_url
        $desktopZip = Join-Path $tmp 'desktop.zip'
        $desktopExtract = Join-Path $tmp 'desktop-extract'
        Write-Log "downloading Desktop: $desktopUrl"
        Invoke-WebRequest -Uri $desktopUrl -OutFile $desktopZip -UseBasicParsing -Headers $headers
        $desktopActual = Get-Sha256 -Path $desktopZip
        $desktopExpected = $desktopDigest.Groups[1].Value.ToLowerInvariant()
        if ($desktopActual -ne $desktopExpected) {
            Die "checksum mismatch for $desktopUrl (expected $desktopExpected, got $desktopActual)"
        }
        Expand-Archive -Path $desktopZip -DestinationPath $desktopExtract -Force
        $desktopExecutable = Get-ChildItem -Path $desktopExtract -Recurse -File -Filter 'wrenyard-desktop.exe' |
            Select-Object -First 1
        if (-not $desktopExecutable -or $desktopExecutable.Length -le 0) {
            Die 'Desktop archive does not contain wrenyard-desktop.exe'
        }

        $programsDir = Join-Path $env:LOCALAPPDATA 'Programs'
        $desktopDestination = Join-Path $programsDir 'Wrenyard Desktop'
        $desktopStaging = Join-Path $programsDir ('.wrenyard-desktop-install-' + [Guid]::NewGuid().ToString('N'))
        $desktopBackup = Join-Path $programsDir ('.wrenyard-desktop-previous-' + [Guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $programsDir -Force | Out-Null
        Copy-DirectoryTree -Source $desktopExecutable.Directory.FullName -Destination $desktopStaging
        $stagedExecutable = Join-Path $desktopStaging 'wrenyard-desktop.exe'
        if (-not (Test-Path $stagedExecutable) -or (Get-Item $stagedExecutable).Length -le 0) {
            Die 'staged Desktop executable is invalid'
        }
        if (Test-Path $desktopDestination) { Move-Item $desktopDestination $desktopBackup -Force }
        try {
            Move-Item $desktopStaging $desktopDestination -ErrorAction Stop
        } catch {
            if (Test-Path $desktopBackup) { Move-Item $desktopBackup $desktopDestination -Force }
            throw
        }
        Remove-Item $desktopBackup -Recurse -Force -ErrorAction SilentlyContinue

        $startMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
        New-Item -ItemType Directory -Path $startMenu -Force | Out-Null
        $shell = New-Object -ComObject WScript.Shell
        $shortcut = $shell.CreateShortcut((Join-Path $startMenu '啾啾工坊.lnk'))
        $shortcut.TargetPath = Join-Path $desktopDestination 'wrenyard-desktop.exe'
        $shortcut.WorkingDirectory = $desktopDestination
        $shortcut.Save()
        Write-Log "installed Desktop $DirVersion at $desktopDestination"
    }

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
