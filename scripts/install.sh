#!/usr/bin/env bash
#
# wrenyard installer/updater
#
# POSIX bash (set -euo pipefail). Downloads a digest-verified suite zip from a
# GitHub release (or a direct URL with an explicit checksum sidecar), validates
# the required wrenyard executable
# and release manifest, and installs it under <prefix>/versions/<version>
# before atomically switching the `current` symlink plus the public launcher.
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
  --update              Install the newest non-draft release (prereleases included)
  -h, --help            Show this help

Environment:
  WRENYARD_GITHUB_REPOSITORY  GitHub repository for default URLs (default: wrenyard/wrenyard)
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
TOKEN="${GH_TOKEN:-${GITHUB_TOKEN:-}}"
NETRC=""
if [ -n "$TOKEN" ]; then
  NETRC="$(mktemp "${TMPDIR:-/tmp}/wrenyard-auth.XXXXXX")"
  printf 'machine api.github.com login x-oauth-basic password %s\n' "$TOKEN" > "$NETRC"
  printf 'machine github.com login x-oauth-basic password %s\n' "$TOKEN" >> "$NETRC"
  chmod 600 "$NETRC"
fi

api_get() {
  local url="$1"
  if [ "$HAVE_CURL" -eq 1 ]; then
    curl -fsSL --retry 3 ${NETRC:+--netrc-file "$NETRC"} "$url"
  else
    wget -q ${NETRC:+--netrc-file "$NETRC"} -O - "$url"
  fi
}

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

# Resolve the newest non-draft release (prereleases included) from the full
# GitHub releases list, so a private v1.0.0-dev.* prerelease is selected for
# --update. Drafts are never selected.
resolve_latest() {
  local api="https://api.github.com/repos/$REPO/releases?per_page=100"
  local body tag=""
  body="$(api_get "$api")" || die "could not fetch releases for $REPO"
  tag="$(printf '%s\n' "$body" | awk '
    /"tag_name"/ {
      tag = $0; sub(/^.*"tag_name"[[:space:]]*:[[:space:]]*"/, "", tag); sub(/".*$/, "", tag)
    }
    /"draft"/ { draft = ($0 ~ /"draft"[[:space:]]*:[[:space:]]*true/) ? 1 : 0 }
    /"published_at"/ {
      pub = $0; sub(/^.*"published_at"[[:space:]]*:[[:space:]]*"/, "", pub); sub(/".*$/, "", pub)
      if (!draft && pub > best) { best = pub; best_tag = tag }
    }
    END { print best_tag }
  ')"
  [ -n "$tag" ] || die "could not resolve the latest non-draft release tag for $REPO"
  log "latest release tag: $tag"
  case "$tag" in
    v*) printf '%s\n' "${tag#v}" ;;
    *)  printf '%s\n' "$tag" ;;
  esac
}

# GitHub computes a sha256 digest for each uploaded release asset. Resolve that
# server-side digest by exact asset name so the public release does not need a
# second user-visible checksum file beside every archive.
resolve_release_asset_sha256() {
  local tag="$1" wanted="$2"
  local api="https://api.github.com/repos/$REPO/releases/tags/$tag"
  local body digest=""
  body="$(api_get "$api")" || die "could not fetch release $tag for $REPO"
  digest="$(printf '%s\n' "$body" | awk -v wanted="$wanted" '
    /"name"[[:space:]]*:/ {
      name = $0
      sub(/^.*"name"[[:space:]]*:[[:space:]]*"/, "", name)
      sub(/".*$/, "", name)
      matched = (name == wanted)
      next
    }
    matched && /"digest"[[:space:]]*:/ {
      value = $0
      sub(/^.*"digest"[[:space:]]*:[[:space:]]*"/, "", value)
      sub(/".*$/, "", value)
      if (value ~ /^sha256:[0-9a-fA-F]{64}$/) {
        print substr(value, 8)
        exit
      }
    }
  ')"
  [ -n "$digest" ] || die "release $tag has no SHA-256 digest for $wanted"
  printf '%s\n' "$digest" | tr '[:upper:]' '[:lower:]'
}

# Resolve --update before version validation so that --update works without a
# --version and a non-empty version is guaranteed before any URL is derived.
if [ -z "$VERSION" ]; then
  if [ "$UPDATE" -eq 1 ]; then
    VERSION="$(resolve_latest)"
  else
    die "a --version is required (or pass --update to install the latest release)"
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

# Normalized suite zip: <repo>/releases/download/<tag>/wrenyard-<version>-<target>-suite.zip
case "$VERSION" in
  v*) TAG="$VERSION"; DIR_VERSION="${VERSION#v}" ;;
  *)  TAG="v$VERSION"; DIR_VERSION="$VERSION" ;;
esac
DEFAULT_URL="https://github.com/$REPO/releases/download/$TAG/wrenyard-$DIR_VERSION-$TARGET-suite.zip"
URL="${URL:-$DEFAULT_URL}"
ASSET_NAME="wrenyard-$DIR_VERSION-$TARGET-suite.zip"
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
trap 'rm -rf "$TMP_DIR" "$NETRC"' EXIT

log "downloading suite: $URL"
fetch "$TMP_DIR/suite.zip" "$URL"
if [ -n "$CHECKSUM_URL" ]; then
  log "downloading explicit checksum sidecar: $CHECKSUM_URL"
  fetch "$TMP_DIR/suite.zip.sha256" "$CHECKSUM_URL"
  EXPECTED="$(awk '{print $1}' "$TMP_DIR/suite.zip.sha256" | tr '[:upper:]' '[:lower:]')"
  printf '%s\n' "$EXPECTED" | grep -Eq '^[0-9a-f]{64}$' || die "checksum sidecar is invalid: $CHECKSUM_URL"
else
  log "resolving GitHub asset digest: $ASSET_NAME"
  EXPECTED="$(resolve_release_asset_sha256 "$TAG" "$ASSET_NAME")"
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

find "$STAGING_DIR" -type f \( -name 'wrenyard' -o -name 'forge' -o -name 'foreman' -o -name 'foreman.mjs' -o -name 'node' \) -exec chmod +x {} +

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
  DESKTOP_ASSET_NAME="wrenyard-desktop-$DIR_VERSION-$TARGET.zip"
  DESKTOP_URL="https://github.com/$REPO/releases/download/$TAG/$DESKTOP_ASSET_NAME"
  DESKTOP_EXPECTED="$(resolve_release_asset_sha256 "$TAG" "$DESKTOP_ASSET_NAME")"
  log "downloading Desktop: $DESKTOP_URL"
  fetch "$TMP_DIR/desktop.zip" "$DESKTOP_URL"
  DESKTOP_ACTUAL="$(sha256_of "$TMP_DIR/desktop.zip")"
  [ "$DESKTOP_ACTUAL" = "$DESKTOP_EXPECTED" ] \
    || die "checksum mismatch for $DESKTOP_URL (expected $DESKTOP_EXPECTED, got $DESKTOP_ACTUAL)"

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
