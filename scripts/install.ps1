<#
.SYNOPSIS
    wrenyard installer/updater (Windows)

.DESCRIPTION
    Downloads a digest-verified suite zip whose canonical URL and SHA-256 come
    from the complete version manifest, validates the wrenyard executable
    and release manifest, and installs it under <Prefix>\versions\<version>
    before safely updating the `current` link and the public launcher shim.
    Old versions are retained.

    This script only moves prebuilt artifacts into place. It never invokes
    go/npm/pnpm, never changes execution policy, and never writes secrets to
    logs (optional private-mirror auth travels as an Authorization header).
    The update metadata is a static complete version manifest fetched over
    HTTPS: the installer never calls the GitHub Release API.

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
    Install the newest published release from the static update metadata
    (prereleases included).

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
$UpdateBaseUrl = if ($env:WRENYARD_UPDATE_BASE_URL) { $env:WRENYARD_UPDATE_BASE_URL } else { "https://raw.githubusercontent.com/$Repo/updates" }
$UPDATE_SCHEMA_VERSION = 'wrenyard.update.v1'
$EXPECTED_ASSET_COUNT = 4

# --- Optional private-mirror auth -------------------------------------------
# The token is passed as an Authorization header and never written to logs.
$token = if ($env:GH_TOKEN) { $env:GH_TOKEN } elseif ($env:GITHUB_TOKEN) { $env:GITHUB_TOKEN } else { '' }
$headers = @{ 'User-Agent' = 'wrenyard-install' }
if ($token) { $headers['Authorization'] = "Bearer $token" }

# --- Static update metadata ------------------------------------------------
# The installer consumes the complete version manifest (dev.json is a single
# full manifest document, not a release list) over HTTPS; it never calls
# the GitHub Release API. A document is fetched at most once per run and cached
# in $documentCache under --update, so the selected manifest supplies the asset
# lookups without a second versions request.
$documentCache = @{}

function Get-UpdateDocument {
    param([string]$Name)
    if ($documentCache.ContainsKey($Name)) { return $documentCache[$Name] }
    $uri = "$UpdateBaseUrl/$Name"
    Write-Log "fetching update metadata: $uri"
    $text = $null
    try {
        $response = Invoke-WebRequest -Uri $uri -UseBasicParsing -Headers $headers -ErrorAction Stop
        $text = $response.Content
    } catch {
        Die "could not fetch update metadata: $uri (base $UpdateBaseUrl)"
    }
    if (-not $text) { Die "update metadata is empty: $uri" }
    $parsed = $null
    try { $parsed = $text | ConvertFrom-Json } catch { Die "update metadata is not valid JSON: $uri" }
    $documentCache[$Name] = $parsed
    return $parsed
}

function Assert-ExactVersionDocument {
    param([string]$Name, [string]$ExpectedVersion)
    $doc = Get-UpdateDocument $Name
    if ([string]$doc.schema_version -ne $UPDATE_SCHEMA_VERSION) {
        Die "unsupported update metadata schema in $Name (expected $UPDATE_SCHEMA_VERSION)"
    }
    $docVersion = [string]$doc.version -replace '^v', ''
    if ($docVersion -ne $ExpectedVersion) {
        Die "update metadata version mismatch for $Name (expected $ExpectedVersion, got $docVersion)"
    }
    $assets = @($doc.assets)
    if ($assets.Count -ne $EXPECTED_ASSET_COUNT) {
        Die "expected exactly $EXPECTED_ASSET_COUNT release assets in $Name, found $($assets.Count)"
    }
    # The four canonical cross-target assets are the published contract on both
    # platforms. Every record must carry one of these distinct names, so exactly
    # four valid and distinct records also means the complete set; an unknown or
    # repeated name is rejected.
    $expectedNames = @(
        "wrenyard-$ExpectedVersion-darwin-arm64-suite.zip",
        "wrenyard-desktop-$ExpectedVersion-darwin-arm64.zip",
        "wrenyard-$ExpectedVersion-win32-x64-suite.zip",
        "wrenyard-desktop-$ExpectedVersion-win32-x64.zip"
    )
    $seen = @{}
    foreach ($asset in $assets) {
        $assetName = [string]$asset.name
        if (-not $assetName) { Die "update metadata asset without a name in $Name" }
        if ($expectedNames -notcontains $assetName) {
            Die "$Name has an unexpected asset name: $assetName"
        }
        if ($seen.ContainsKey($assetName)) { Die "$Name has duplicate asset records for $assetName" }
        $seen[$assetName] = $true
        # Raw 64-hex digests only: a prefixed sha256: digest is not the
        # published contract and is rejected rather than normalized.
        if ([string]$asset.sha256 -notmatch '^[0-9a-f]{64}$') {
            Die "update metadata has an invalid SHA-256 digest for $assetName"
        }
        $expectedUrl = "https://github.com/$Repo/releases/download/v$ExpectedVersion/$assetName"
        if ([string]$asset.url -ne $expectedUrl) {
            Die "update metadata asset $assetName URL is not canonical (expected $expectedUrl)"
        }
    }
    foreach ($expectedName in $expectedNames) {
        if (-not $seen.ContainsKey($expectedName)) {
            Die "$Name has no asset named $expectedName"
        }
    }
    return $doc
}

function Get-ExactAsset {
    param([object]$Document, [string]$Name, [string]$DocumentName)
    $matches_ = @($Document.assets | Where-Object { [string]$_.name -eq $Name })
    if ($matches_.Count -eq 0) { Die "$DocumentName has no asset named $Name" }
    if ($matches_.Count -gt 1) { Die "$DocumentName has duplicate asset records for $Name" }
    return , $matches_[0]
}

# --- Resolve -Update from the complete version manifest ---------------------
# dev.json is one complete version manifest document: the top-level version is
# the selected release, and the same cached document supplies the asset lookups
# below without fetching versions/<version>.json a second time.
$versionDoc = $null
$versionDocumentName = ''
if (-not $Version) {
    if ($Update) {
        $devDoc = Get-UpdateDocument 'dev.json'
        if ([string]$devDoc.schema_version -ne $UPDATE_SCHEMA_VERSION) {
            Die "unsupported update metadata schema in dev.json (expected $UPDATE_SCHEMA_VERSION)"
        }
        $manifestVersion = [string]$devDoc.version
        if (-not $manifestVersion) { Die 'dev.json publishes no version' }
        $Version = $manifestVersion
        $versionDoc = $devDoc
        $versionDocumentName = 'dev.json'
        Write-Log "latest published version: $Version"
    } else {
        Die 'a -Version is required (or pass -Update to install the latest published version)'
    }
}

# --- Path hygiene ----------------------------------------------------------
if ($Version -match '[/\\]' -or $Version -match '\.\.' -or $Version -match '\s') {
    Die "invalid version: $Version"
}

$DirVersion = $Version -replace '^v', ''
if ($env:PROCESSOR_ARCHITECTURE -ne 'AMD64' -and $env:PROCESSOR_ARCHITECTURE -ne 'x86_64') {
    Die "unsupported processor architecture: $env:PROCESSOR_ARCHITECTURE (supported: AMD64/x86_64)"
}
$CustomUrl = [bool]$Url
# The canonical suite asset name is defined even on the direct custom-URL
# bypass, where no static document is inspected at all.
$AssetName = "wrenyard-$DirVersion-win32-x64-suite.zip"
# A custom URL with an explicit checksum sidecar and -SuiteOnly is a purely
# direct install: it must not touch the static update metadata at all, so a
# local release smoke test works even when the published manifest is behind.
$directBypass = $CustomUrl -and [bool]$ChecksumUrl -and $SuiteOnly
if (-not $directBypass) {
    if (-not $versionDocumentName) { $versionDocumentName = "versions/$DirVersion.json" }
    # Every selected document - including the cached dev.json from -Update - is
    # validated here; the cached document previously skipped validation.
    $versionDoc = Assert-ExactVersionDocument -Name $versionDocumentName -ExpectedVersion $DirVersion
    $suiteAsset = Get-ExactAsset -Document $versionDoc -Name $AssetName -DocumentName $versionDocumentName
    $AssetName = [string]$suiteAsset.name
    if (-not $Url) { $Url = [string]$suiteAsset.url }
    $suiteSha256 = [string]$suiteAsset.sha256
    $desktopSha256 = ''
    if (-not $SuiteOnly) {
        $desktopAsset = Get-ExactAsset -Document $versionDoc -Name "wrenyard-desktop-$DirVersion-win32-x64.zip" -DocumentName $versionDocumentName
        $desktopUrlFromDocument = [string]$desktopAsset.url
        $desktopSha256 = [string]$desktopAsset.sha256
    }
}
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

function Expand-NativeZip {
    param([string]$Archive, [string]$Destination)
    $systemRoot = [System.Environment]::GetEnvironmentVariable('SystemRoot')
    if (-not $systemRoot) { Die 'SystemRoot is unavailable; cannot locate Windows tar.exe' }
    $tarPath = Join-Path $systemRoot 'System32\tar.exe'
    if (-not [System.IO.File]::Exists($tarPath)) {
        Die "Windows system tar.exe was not found at $tarPath"
    }
    [System.IO.Directory]::CreateDirectory($Destination) | Out-Null
    try {
        & $tarPath -x --no-same-owner --no-same-permissions -f $Archive -C $Destination
    } catch {
        Die "Windows system tar.exe could not extract $Archive"
    }
    $tarExitCode = $LASTEXITCODE
    if ($tarExitCode -ne 0) {
        Die "Windows system tar.exe failed to extract $Archive (exit $tarExitCode)"
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
        Write-Log "using release metadata digest: $AssetName"
        $expected = $suiteSha256
    }
    $actual = Get-Sha256 -Path $zipPath
    if ($actual -ne $expected) { Die "checksum mismatch for $Url (expected $expected, got $actual)" }
    Write-Log "checksum verified ($actual)"

    $extract = Join-Path $tmp 'extract'
    Expand-NativeZip -Archive $zipPath -Destination $extract

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
        $desktopUrl = $desktopUrlFromDocument
        $desktopZip = Join-Path $tmp 'desktop.zip'
        $desktopExtract = Join-Path $tmp 'desktop-extract'
        Write-Log "downloading Desktop: $desktopUrl"
        Invoke-WebRequest -Uri $desktopUrl -OutFile $desktopZip -UseBasicParsing -Headers $headers
        $desktopActual = Get-Sha256 -Path $desktopZip
        $desktopExpected = $desktopSha256
        if ($desktopActual -ne $desktopExpected) {
            Die "checksum mismatch for $desktopUrl (expected $desktopExpected, got $desktopActual)"
        }
        Expand-NativeZip -Archive $desktopZip -Destination $desktopExtract
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
