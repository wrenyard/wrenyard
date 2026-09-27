# wrenyard one-command bootstrap (Windows x64): read the static update feed,
# download the digest-verified suite zip, then run its install engine with the
# archive and every other argument passed through. Exits with the engine's code.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
function Write-Log { Write-Host "install.ps1: $($args -join ' ')" }
function Die([string]$Message) { throw "install.ps1: $Message" }
function Get-Sha256([string]$Path) {
    # SHA-256 through .NET directly: no module-backed hashing cmdlet required.
    $stream = $null; $sha = $null
    try {
        $stream = [System.IO.File]::OpenRead($Path)
        $sha = [System.Security.Cryptography.SHA256]::Create()
        return [System.BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '').ToLowerInvariant()
    } finally { if ($sha) { $sha.Dispose() }; if ($stream) { $stream.Dispose() } }
}

$Base = if ($env:WRENYARD_UPDATE_BASE_URL) { $env:WRENYARD_UPDATE_BASE_URL } else { 'https://raw.githubusercontent.com/wrenyard/wrenyard/updates' }
$Version = ''; $Passthrough = @(); $index = 0
while ($index -lt $args.Count) {
    if ($args[$index] -eq '--version') {
        if ($index + 1 -ge $args.Count) { Die '--version requires a value' }
        $Version = [string]$args[$index + 1]; $index += 2
    } else { $Passthrough += [string]$args[$index]; $index += 1 }
}
if ($env:OS -ne 'Windows_NT') {
    Die "unsupported host operating system (use install.sh on macOS arm64)"
}
if ($env:PROCESSOR_ARCHITECTURE -ne 'AMD64' -and $env:PROCESSOR_ARCHITECTURE -ne 'x86_64') {
    Die "unsupported processor architecture: $env:PROCESSOR_ARCHITECTURE (supported: AMD64/x86_64)"
}

$DirVersion = $Version -replace '^v', ''
$FeedUrl = if ($Version) { "$Base/versions/$DirVersion.json" } else { "$Base/dev.json" }
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("wrenyard-bootstrap-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp | Out-Null
$engineExit = 0
try {
    $feedPath = Join-Path $tmp 'feed.json'
    Write-Log "fetching update feed: $FeedUrl"
    try { Invoke-WebRequest -Uri $FeedUrl -OutFile $feedPath -UseBasicParsing -ErrorAction Stop }
    catch { Die "could not fetch update feed: $FeedUrl" }
    $feed = $null
    try { $feed = Get-Content -Raw -LiteralPath $feedPath | ConvertFrom-Json }
    catch { Die "update feed is not valid JSON: $FeedUrl" }
    if ([string]$feed.schema_version -ne 'wrenyard.update.v1') { Die 'unsupported update feed schema' }

    # The feed version must be valid SemVer (build metadata allowed) and, when
    # the caller requested a version explicitly, must match it exactly.
    $semverPattern = '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$'
    $feedVersion = [string]$feed.version
    if (-not $feedVersion) { Die 'update feed publishes no version' }
    if ($feedVersion -notmatch $semverPattern) { Die "update feed version is not valid semver: $feedVersion" }
    if ($Version) {
        if (($Version -replace '^v', '') -ne $feedVersion) {
            Die "requested version $($Version -replace '^v','') does not match feed version $feedVersion"
        }
    } else { $Version = $feedVersion }
    $DirVersion = $Version -replace '^v', ''

    # Both platform assets must be present with raw 64-hex digests before download.
    # Uppercase hex is accepted and normalized so the comparison with .NET holds.
    $suiteName = "wrenyard-$DirVersion-win32-x64-suite.zip"
    $desktopName = "wrenyard-desktop-$DirVersion-win32-x64.zip"
    $suiteUrl = ''; $suiteSha = ''; $desktopFound = $false
    foreach ($asset in @($feed.assets)) {
        $name = [string]$asset.name; $sha = ([string]$asset.sha256).ToLowerInvariant()
        if ($sha -notmatch '^[0-9a-f]{64}$') { Die "update feed has an invalid digest for $name" }
        if ($name -eq $suiteName) { $suiteUrl = [string]$asset.url; $suiteSha = $sha }
        if ($name -eq $desktopName) { $desktopFound = $true }
    }
    if (-not $suiteUrl) { Die "update feed has no asset $suiteName" }
    if (-not $desktopFound) { Die "update feed has no asset $desktopName" }

    $suiteZip = Join-Path $tmp 'suite.zip'
    Write-Log "downloading suite: $suiteUrl"
    try { Invoke-WebRequest -Uri $suiteUrl -OutFile $suiteZip -UseBasicParsing -ErrorAction Stop }
    catch { Die "could not download suite: $suiteUrl" }
    $actual = Get-Sha256 -Path $suiteZip
    if ($actual -ne $suiteSha) { Die "checksum mismatch for $suiteUrl (expected $suiteSha, got $actual)" }

    Write-Log 'extracting suite'
    & tar.exe -x --no-same-owner --no-same-permissions -f $suiteZip -C $tmp
    if ($LASTEXITCODE -ne 0) { Die "could not extract suite: $suiteZip" }
    $engine = Join-Path $tmp 'wrenyard.exe'
    if (-not (Test-Path -LiteralPath $engine)) { Die 'suite does not contain wrenyard.exe' }
    & $engine install --help *> $null
    if ($LASTEXITCODE -ne 0) { Die 'wrenyard install is unavailable in the downloaded suite' }

    $engineArgs = @('install', '--version', $Version, '--suite-zip', $suiteZip) + $Passthrough
    & $engine @engineArgs
    $engineExit = $LASTEXITCODE
} finally { Remove-Item -Path $tmp -Recurse -Force -ErrorAction SilentlyContinue }
exit $engineExit
