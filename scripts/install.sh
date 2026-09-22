#!/usr/bin/env bash
#
# wrenyard installer/updater
#
# POSIX bash (set -euo pipefail). Downloads a digest-verified suite zip whose
# canonical URL and SHA-256 come from the complete version manifest (or a
# direct URL with an explicit checksum sidecar), validates the required wrenyard
# executable
# and release manifest, and installs it under <prefix>/versions/<version>
# before atomically switching the `current` symlink plus the public launcher.
#
# The update metadata is a static complete version manifest fetched over
# HTTPS: the installer never calls the GitHub Release API.
#
# This script only ever moves prebuilt artifacts into place. It never invokes
# go, npm, or pnpm, and it never builds anything on the consumer machine.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: install.sh [options]

Options:
  --version <ver>       Version to install (e.g. 1.0.0-dev.0)
  --prefix <dir>        Install root (default: ~/.local/share/wrenyard)
  --bin-dir <dir>       Launcher symlink directory (default: <prefix>/bin)
  --url <url>           Suite zip URL (requires --checksum-url)
  --checksum-url <url>  Explicit suite .sha256 sidecar URL for --url
  --suite-only          Install/update the suite without the Desktop app
  --update              Install the newest published version (prereleases included)
                        from the static update metadata
  -h, --help            Show this help

Environment:
  WRENYARD_GITHUB_REPOSITORY  GitHub repository for default URLs (default: wrenyard/wrenyard)
  WRENYARD_UPDATE_BASE_URL    Static update metadata base URL
                              (default: https://raw.githubusercontent.com/<repo>/updates)
  WRENYARD_PREFIX             Default install prefix
  GH_TOKEN / GITHUB_TOKEN     Optional token for private mirrors; never echoed,
                              only sent through a mode-0600 netrc file
EOF
}

log() { printf 'install.sh: %s\n' "$*" >&2; }
die() { log "error: $*"; exit 1; }

VERSION=""
PREFIX="${WRENYARD_PREFIX:-$HOME/.local/share/wrenyard}"
BIN_DIR=""
URL=""
CHECKSUM_URL=""
CUSTOM_URL=0
UPDATE=0
SUITE_ONLY=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --version)
      [ "$#" -ge 2 ] || die "--version requires a value"
      VERSION="$2"; shift 2 ;;
    --prefix)
      [ "$#" -ge 2 ] || die "--prefix requires a value"
      PREFIX="$2"; shift 2 ;;
    --bin-dir)
      [ "$#" -ge 2 ] || die "--bin-dir requires a value"
      BIN_DIR="$2"; shift 2 ;;
    --url)
      [ "$#" -ge 2 ] || die "--url requires a value"
      URL="$2"; CUSTOM_URL=1; shift 2 ;;
    --checksum-url)
      [ "$#" -ge 2 ] || die "--checksum-url requires a value"
      CHECKSUM_URL="$2"; shift 2 ;;
    --update)
      UPDATE=1; shift ;;
    --suite-only)
      SUITE_ONLY=1; shift ;;
    -h|--help)
      usage; exit 0 ;;
    *)
      die "unknown argument: $1" ;;
  esac
done

REPO="${WRENYARD_GITHUB_REPOSITORY:-wrenyard/wrenyard}"
[ -n "$REPO" ] || die "WRENYARD_GITHUB_REPOSITORY must not be empty"

# Path hygiene: the prefix and bin-dir are embedded in install paths, so only
# accept conservative absolute values. Version validation runs after --update
# resolution below, once a non-empty version is guaranteed.
case "$PREFIX" in
  ''|/*) ;;
  *) die "prefix must be an absolute path: $PREFIX" ;;
esac
BIN_DIR="${BIN_DIR:-$PREFIX/bin}"
case "$BIN_DIR" in
  ''|/*) ;;
  *) die "bin-dir must be an absolute path: $BIN_DIR" ;;
esac

command -v curl >/dev/null 2>&1 && HAVE_CURL=1 || HAVE_CURL=0
command -v wget >/dev/null 2>&1 && HAVE_WGET=1 || HAVE_WGET=0
[ "$HAVE_CURL" -eq 1 ] || [ "$HAVE_WGET" -eq 1 ] || die "need curl or wget on PATH"

# Optional private-mirror auth. The token is used through a mode-0600 netrc
# file so it never appears in argv, logs, or process listings.
TMP_DIR=""
META_DIR=""
NETRC=""
trap 'rm -rf "$TMP_DIR" "$META_DIR" "$NETRC"' EXIT
TOKEN="${GH_TOKEN:-${GITHUB_TOKEN:-}}"
if [ -n "$TOKEN" ]; then
  NETRC="$(mktemp "${TMPDIR:-/tmp}/wrenyard-auth.XXXXXX")"
  printf 'machine github.com login x-oauth-basic password %s\n' "$TOKEN" > "$NETRC"
  chmod 600 "$NETRC"
fi

# One private temp directory holds every fetched metadata document for the
# whole run. It is created before the first fetch and is always removed by the
# EXIT trap alongside the download temp dir. It is initialized here so a
# metadata-free run (custom URL plus checksum sidecar) still cleans up safely.
META_DIR="$(mktemp -d "${TMPDIR:-/tmp}/wrenyard-meta.XXXXXX")"

fetch() {
  local dest="$1" src="$2"
  if [ "$HAVE_CURL" -eq 1 ]; then
    curl -fsSL --retry 3 ${NETRC:+--netrc-file "$NETRC"} -o "$dest" "$src"
  else
    wget -q ${NETRC:+--netrc-file "$NETRC"} -O "$dest" "$src"
  fi
}

sha256_of() {
  local file="$1"
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file" | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{print $1}'
  else
    die "need shasum or sha256sum on PATH for checksum verification"
  fi
}

# The static version manifest is parsed with macOS's native plutil because the
# public installer bootstraps on a bare macOS host with no Node, Go or Python.
# The URLs in the manifest are canonical GitHub release downloads, while the
# manifest itself is a static file served from the updates base.
UPDATE_BASE_URL="${WRENYARD_UPDATE_BASE_URL:-https://raw.githubusercontent.com/$REPO/updates}"

# Read a required top-level JSON string with the native plist parser. Any parse
# failure (missing key, wrong type, malformed document) fails closed.
json_top_string() {
  local file="$1" key="$2"
  /usr/bin/plutil -extract "$key" raw -expect string -o - "$file"
}

# Fetch one static manifest document into the private metadata dir exactly
# once: a document already fetched during this run is never downloaded again.
fetch_document() {
  local cache_name="$1" url="$2"
  local dest="$META_DIR/$cache_name"
  [ -f "$dest" ] && return 0
  mkdir -p "$(dirname "$dest")"
  log "fetching update metadata: $url"
  fetch "$dest" "$url" || die "could not fetch update metadata: $url (base $UPDATE_BASE_URL)"
  [ -s "$dest" ] || die "update metadata is empty: $url"
}

# Resolve --update from the complete version manifest at the top level of
# dev.json before version validation so that --update works without a
# --version. The manifest becomes the run's selected version document: it is
# fetched exactly once and reused for the asset lookups below.
if [ -z "$VERSION" ]; then
  if [ "$UPDATE" -eq 1 ]; then
    fetch_document dev.json "$UPDATE_BASE_URL/dev.json"
    DEV_DOC="$META_DIR/dev.json"
    SCHEMA="$(json_top_string "$DEV_DOC" schema_version)" \
      || die "update metadata is malformed: dev.json"
    [ "$SCHEMA" = "wrenyard.update.v1" ] \
      || die "unsupported update metadata schema in dev.json (expected wrenyard.update.v1)"
    VERSION="$(json_top_string "$DEV_DOC" version)" \
      || die "dev.json publishes no version"
    [ -n "$VERSION" ] || die "dev.json publishes no version"
    log "latest published version: $VERSION"
  else
    die "a --version is required (or pass --update to install the latest published version)"
  fi
fi

# Path hygiene: the version is embedded in directory and symlink names, so only
# accept a conservative value that can never escape the prefix.
case "$VERSION" in
  ''|*'/'*|*'..'*|*' '*) die "a --version is required and must not contain '/', '..', or spaces" ;;
esac

# Supported host target for the platform-qualified default suite artifact.
case "$(uname -s)" in
  Darwin)
    case "$(uname -m)" in
      arm64)  TARGET="darwin-arm64" ;;
      *) die "unsupported Darwin architecture: $(uname -m) (supported: arm64)" ;;
    esac ;;
  *)
    die "unsupported host platform: $(uname -s) (supported: macOS arm64; use install.ps1 on Windows x64)" ;;
esac

# Normalized suite zip: <repo>/releases/download/v<version>/wrenyard-<version>-<target>-suite.zip
# The version manifest supplies the canonical asset URLs and their SHA-256
# digests; the manifest is fetched once and every asset record is validated
# against the canonical name and URL before anything is downloaded.
case "$VERSION" in
  v*) DIR_VERSION="${VERSION#v}" ;;
  *)  DIR_VERSION="$VERSION" ;;
esac
TAG="v$DIR_VERSION"
DOC_VERSION_NAME="versions/$DIR_VERSION.json"
if [ -z "${DEV_DOC:-}" ]; then
  # A custom --url with an explicit --checksum-url and no Desktop is a purely
  # direct install: it must not touch the static update metadata at all, so a
  # local release smoke test works even when the published manifest is behind.
  if [ "$CUSTOM_URL" -eq 1 ] && [ -n "$CHECKSUM_URL" ] && [ "$SUITE_ONLY" -eq 1 ]; then
    DOC=""
  else
    fetch_document "$DOC_VERSION_NAME" "$UPDATE_BASE_URL/$DOC_VERSION_NAME"
    DOC="$META_DIR/$DOC_VERSION_NAME"
  fi
else
  # --update already fetched the complete version manifest at the top level of
  # dev.json; the same cached document supplies the asset lookups below.
  DOC="$DEV_DOC"
fi

# When a static version document is present it is the single source of truth:
# schema, requested version, exactly four asset records, each with a distinct
# canonical name, the canonical release URL and a raw 64-hex SHA-256 digest.
if [ -n "$DOC" ]; then
  DOC_SCHEMA="$(json_top_string "$DOC" schema_version)" \
    || die "update metadata is malformed: $DOC_VERSION_NAME"
  [ "$DOC_SCHEMA" = "wrenyard.update.v1" ] \
    || die "unsupported update metadata schema in $DOC_VERSION_NAME (expected wrenyard.update.v1)"
  DOC_VERSION="$(json_top_string "$DOC" version)" \
    || die "update metadata has no version: $DOC_VERSION_NAME"
  case "$DOC_VERSION" in
    v*) DOC_VERSION="${DOC_VERSION#v}" ;;
  esac
  [ "$DOC_VERSION" = "$DIR_VERSION" ] \
    || die "update metadata version mismatch for $DOC_VERSION_NAME (expected $DIR_VERSION, got $DOC_VERSION)"

  # The canonical manifest carries exactly four assets; the array length is read
  # with the native parser before any record is dereferenced by index.
  ASSET_RECORDS="$(/usr/bin/plutil -extract assets raw -expect array -o - "$DOC")" \
    || die "update metadata has no assets array: $DOC_VERSION_NAME"
  case "$ASSET_RECORDS" in
    ''|*[!0-9]*) die "update metadata assets are malformed: $DOC_VERSION_NAME" ;;
  esac
  EXPECTED_ASSET_COUNT=4
  [ "$ASSET_RECORDS" -eq "$EXPECTED_ASSET_COUNT" ] \
    || die "expected exactly $EXPECTED_ASSET_COUNT release assets in $DOC_VERSION_NAME, found $ASSET_RECORDS"

  # The suite asset name is the canonical four-asset contract name; it is
  # initialized even on the direct custom-URL bypass so late references are safe.
  SUITE_ASSET_NAME="wrenyard-$DIR_VERSION-$TARGET-suite.zip"

  # Validate the fixed canonical asset set. Each of the four records
  # is read with the native parser, must carry one of the four distinct allowed
  # names, a raw 64-hex digest and the canonical release URL, and each name is
  # assigned straight to the URL/digest variable it feeds. Duplicates are
  # rejected via the accumulating SEEN_NAMES case match, so exactly four valid
  # records also means the complete set.
  DESKTOP_ASSET_NAME="wrenyard-desktop-$DIR_VERSION-$TARGET.zip"
  SEEN_NAMES="|"
  index=0
  while [ "$index" -lt "$EXPECTED_ASSET_COUNT" ]; do
    NAME="$(/usr/bin/plutil -extract "assets.$index.name" raw -expect string -o - "$DOC")" \
      || die "update metadata has a malformed asset name: $DOC_VERSION_NAME"
    URL_ENTRY="$(/usr/bin/plutil -extract "assets.$index.url" raw -expect string -o - "$DOC")" \
      || die "update metadata has a malformed asset URL: $DOC_VERSION_NAME"
    SHA_ENTRY="$(/usr/bin/plutil -extract "assets.$index.sha256" raw -expect string -o - "$DOC")" \
      || die "update metadata has a malformed asset digest: $DOC_VERSION_NAME"
    printf '%s\n' "$SHA_ENTRY" | grep -Eq '^[0-9a-f]{64}$' \
      || die "$DOC_VERSION_NAME has an invalid SHA-256 digest for $NAME"
    case "$NAME" in
      "$SUITE_ASSET_NAME"|"$DESKTOP_ASSET_NAME"| \
      "wrenyard-$DIR_VERSION-win32-x64-suite.zip"|"wrenyard-desktop-$DIR_VERSION-win32-x64.zip") ;;
      *) die "$DOC_VERSION_NAME has an unexpected asset name: $NAME" ;;
    esac
    case "$SEEN_NAMES" in
      *"|$NAME|"*) die "$DOC_VERSION_NAME has duplicate asset records for $NAME" ;;
    esac
    SEEN_NAMES="$SEEN_NAMES$NAME|"
    EXPECTED_URL="https://github.com/$REPO/releases/download/$TAG/$NAME"
    [ "$URL_ENTRY" = "$EXPECTED_URL" ] \
      || die "$DOC_VERSION_NAME asset $NAME URL is not canonical (expected $EXPECTED_URL)"
    if [ "$NAME" = "$SUITE_ASSET_NAME" ]; then
      DEFAULT_URL="$URL_ENTRY"
      SUITE_SHA256="$SHA_ENTRY"
    fi
    if [ "$NAME" = "$DESKTOP_ASSET_NAME" ]; then
      DESKTOP_URL="$URL_ENTRY"
      DESKTOP_SHA256="$SHA_ENTRY"
    fi
    index=$((index + 1))
  done

  [ -n "${SUITE_SHA256:-}" ] || die "$DOC_VERSION_NAME has no asset named $SUITE_ASSET_NAME"
  if [ "$SUITE_ONLY" -eq 0 ]; then
    [ -n "${DESKTOP_SHA256:-}" ] || die "$DOC_VERSION_NAME has no asset named $DESKTOP_ASSET_NAME"
  fi
fi

# A supplied URL overrides the metadata-derived default instead of being
# replaced by it; a custom URL always needs its explicit checksum sidecar.
URL="${URL:-$DEFAULT_URL}"
[ "$CUSTOM_URL" -eq 0 ] || [ -n "$CHECKSUM_URL" ] || die "--url requires --checksum-url"

VERSIONS_DIR="$PREFIX/versions"
VERSION_DIR="$VERSIONS_DIR/$DIR_VERSION"
CURRENT_LINK="$PREFIX/current"

# Recursively locate an artifact by exact file name inside a suite root; the zip
# layout may nest everything under one top-level directory.
find_artifact() {
  local root="$1" name="$2"
  find "$root" -type f -name "$name" 2>/dev/null | head -n 1 || true
}

# ---------------------------------------------------------------------------
# Download + checksum verification
# ---------------------------------------------------------------------------
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/wrenyard-install.XXXXXX")"

log "downloading suite: $URL"
fetch "$TMP_DIR/suite.zip" "$URL"
if [ -n "$CHECKSUM_URL" ]; then
  log "downloading explicit checksum sidecar: $CHECKSUM_URL"
  fetch "$TMP_DIR/suite.zip.sha256" "$CHECKSUM_URL"
  EXPECTED="$(awk '{print $1}' "$TMP_DIR/suite.zip.sha256" | tr '[:upper:]' '[:lower:]')"
  printf '%s\n' "$EXPECTED" | grep -Eq '^[0-9a-f]{64}$' || die "checksum sidecar is invalid: $CHECKSUM_URL"
else
  log "using release metadata digest for $SUITE_ASSET_NAME"
  EXPECTED="$SUITE_SHA256"
fi
ACTUAL="$(sha256_of "$TMP_DIR/suite.zip")"
[ "$ACTUAL" = "$EXPECTED" ] || die "checksum mismatch for $URL (expected $EXPECTED, got $ACTUAL)"
log "checksum verified ($ACTUAL)"

mkdir -p "$TMP_DIR/extract"
if command -v unzip >/dev/null 2>&1; then
  unzip -q "$TMP_DIR/suite.zip" -d "$TMP_DIR/extract"
elif command -v tar >/dev/null 2>&1; then
  tar -xf "$TMP_DIR/suite.zip" -C "$TMP_DIR/extract"
else
  die "need unzip (or a tar that can read zip archives) on PATH"
fi

WRENYARD_SRC="$(find_artifact "$TMP_DIR/extract" 'wrenyard')"
MANIFEST_SRC="$(find_artifact "$TMP_DIR/extract" 'release-manifest.json')"
if [ -z "$MANIFEST_SRC" ]; then
  MANIFEST_SRC="$(find_artifact "$TMP_DIR/extract" 'manifest.json')"
fi
[ -n "$WRENYARD_SRC" ] || die "suite zip does not contain a wrenyard executable"
[ -n "$MANIFEST_SRC" ] || die "suite zip does not contain a release manifest"

# ---------------------------------------------------------------------------
# Install into a fresh version directory. An existing version directory is
# never reused: the checksum-verified archives must always win, so a same-
# version reinstall replaces any locally tampered content. The new suite is
# staged beside the version directory, validated there, and swapped in with
# backup-and-restore semantics before `current` or any launcher is touched.
# ---------------------------------------------------------------------------
mkdir -p "$PREFIX" "$BIN_DIR" "$VERSIONS_DIR"

STAGING_DIR="$VERSIONS_DIR/.${DIR_VERSION}.staging.$$"
BACKUP_DIR="$VERSIONS_DIR/.${DIR_VERSION}.backup.$$"
rm -rf "$STAGING_DIR" "$BACKUP_DIR"
mkdir -p "$STAGING_DIR"
cp -R "$TMP_DIR/extract"/. "$STAGING_DIR"/

find "$STAGING_DIR" -type f \( -name 'wrenyard' -o -name 'forge' -o -name 'node' \) -exec chmod +x {} +

INSTALLED_WRENYARD="$(find_artifact "$STAGING_DIR" 'wrenyard')"
[ -n "$INSTALLED_WRENYARD" ] || die "installed suite is missing the wrenyard executable"

# Swap the validated staging copy into VERSION_DIR with backup-and-restore
# semantics: keep any previous version intact, restore it if the swap fails,
# and never activate the new tree before it is fully in place.
if [ -e "$VERSION_DIR" ]; then
  mv "$VERSION_DIR" "$BACKUP_DIR"
fi
if ! mv "$STAGING_DIR" "$VERSION_DIR"; then
  if [ -d "$BACKUP_DIR" ]; then
    mv "$BACKUP_DIR" "$VERSION_DIR"
  fi
  die "failed to activate version $DIR_VERSION at $VERSION_DIR"
fi
rm -rf "$BACKUP_DIR"

# Re-resolve the installed artifact paths through the activated version dir.
INSTALLED_WRENYARD="$(find_artifact "$VERSION_DIR" 'wrenyard')"

# Switch a symlink by creating a temporary link in the same directory and
# renaming it into place. The rename is atomic within the filesystem, so the
# target name always resolves to a complete, immutable version directory.
switch_link() {
  local target="$1" path="$2" tmp
  tmp="$path.tmp.$$"
  rm -rf "$tmp"
  ln -s "$target" "$tmp"
  if [ -e "$path" ] || [ -L "$path" ]; then
    [ -L "$path" ] || die "refusing to replace a non-symlink at $path"
    rm -f "$path"
  fi
  mv "$tmp" "$path"
}

OLD_VERSION=""
if [ -L "$CURRENT_LINK" ]; then
  OLD_VERSION="$(readlink "$CURRENT_LINK" | sed 's#.*/##')"
fi

switch_link "$VERSION_DIR" "$CURRENT_LINK"

# Launcher targets are expressed through `current` so they follow updates
# automatically, e.g. <prefix>/current/bin/wrenyard.
current_target() {
  local path="$1"
  case "$path" in
    "$VERSION_DIR"/*) printf '%s%s\n' "$CURRENT_LINK" "${path#"$VERSION_DIR"}" ;;
    *) printf '%s\n' "$path" ;;
  esac
}

# Only the wrenyard command is a public launcher; the internal Foreman control
# and the Forge runtime remain hidden inside the installed suite.
switch_link "$(current_target "$INSTALLED_WRENYARD")" "$BIN_DIR/wrenyard"

# ---------------------------------------------------------------------------
# Install the matching Desktop archive for one-command bootstrap. The CLI's
# update path passes --suite-only because the running Desktop uses its external
# helper to replace itself transactionally after exit.
# ---------------------------------------------------------------------------
if [ "$SUITE_ONLY" -eq 0 ]; then
  log "downloading Desktop: $DESKTOP_URL"
  fetch "$TMP_DIR/desktop.zip" "$DESKTOP_URL"
  DESKTOP_ACTUAL="$(sha256_of "$TMP_DIR/desktop.zip")"
  [ "$DESKTOP_ACTUAL" = "$DESKTOP_SHA256" ] \
    || die "checksum mismatch for $DESKTOP_URL (expected $DESKTOP_SHA256, got $DESKTOP_ACTUAL)"

  mkdir -p "$TMP_DIR/desktop-extract"
  if command -v unzip >/dev/null 2>&1; then
    unzip -q "$TMP_DIR/desktop.zip" -d "$TMP_DIR/desktop-extract"
  else
    tar -xf "$TMP_DIR/desktop.zip" -C "$TMP_DIR/desktop-extract"
  fi
  DESKTOP_SOURCE="$(find "$TMP_DIR/desktop-extract" -type d -name '啾啾工坊.app' -print -quit)"
  [ -n "$DESKTOP_SOURCE" ] || die "Desktop archive does not contain 啾啾工坊.app"
  /usr/bin/codesign --verify --deep --strict "$DESKTOP_SOURCE" \
    || die "Desktop archive signature verification failed"

  APPLICATIONS_DIR="$HOME/Applications"
  DESKTOP_DESTINATION="$APPLICATIONS_DIR/啾啾工坊.app"
  DESKTOP_STAGING="$APPLICATIONS_DIR/.wrenyard-desktop-install.$$"
  DESKTOP_BACKUP="$APPLICATIONS_DIR/.wrenyard-desktop-previous.$$"
  mkdir -p "$APPLICATIONS_DIR"
  rm -rf "$DESKTOP_STAGING" "$DESKTOP_BACKUP"
  /usr/bin/ditto "$DESKTOP_SOURCE" "$DESKTOP_STAGING"
  /usr/bin/codesign --verify --deep --strict "$DESKTOP_STAGING" \
    || die "staged Desktop signature verification failed"
  if [ -e "$DESKTOP_DESTINATION" ]; then mv "$DESKTOP_DESTINATION" "$DESKTOP_BACKUP"; fi
  if ! mv "$DESKTOP_STAGING" "$DESKTOP_DESTINATION"; then
    [ ! -e "$DESKTOP_BACKUP" ] || mv "$DESKTOP_BACKUP" "$DESKTOP_DESTINATION"
    die "failed to install Desktop at $DESKTOP_DESTINATION"
  fi
  rm -rf "$DESKTOP_BACKUP"
  /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister \
    -f "$DESKTOP_DESTINATION" >/dev/null 2>&1 || true
  log "installed Desktop $DIR_VERSION at $DESKTOP_DESTINATION"
fi

# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------
log "installed wrenyard $DIR_VERSION at $VERSION_DIR"
printf '%s\n' "wrenyard $DIR_VERSION installed"
printf '%s\n' "  current:   $CURRENT_LINK -> $VERSION_DIR"
printf '%s\n' "  launcher:  $BIN_DIR/wrenyard"
if [ -n "$OLD_VERSION" ] && [ "$OLD_VERSION" != "$DIR_VERSION" ]; then
  log "previous version retained: $OLD_VERSION"
  log "rollback: $CURRENT_LINK -> $VERSIONS_DIR/$OLD_VERSION (re-run with --version $OLD_VERSION)"
  printf '%s\n' "rollback: switch manually with:"
  printf '%s\n' "  ln -sfn $VERSIONS_DIR/$OLD_VERSION $CURRENT_LINK"
else
  printf '%s\n' "rollback: old versions are retained under $VERSIONS_DIR"
fi
