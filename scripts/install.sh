#!/usr/bin/env bash
#
# wrenyard installer/updater
#
# POSIX bash (set -euo pipefail). Downloads checksum-verified suite and Pet
# zips from a GitHub release (or direct URLs), validates that the suite
# contains the required wrenyard executable and release manifest and that the
# Pet archive contains its packaged executable, and installs both under
# <prefix>/versions/<version> (Pet at apps/pet) before atomically switching the
# `current` symlink plus the single public wrenyard launcher symlink.
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
  --url <url>           Suite zip URL (default: derived from the GitHub release)
  --checksum-url <url>  Suite .sha256 sidecar URL (default: <zip-url>.sha256)
  --pet-url <url>       Pet zip URL (default: derived from the GitHub release)
  --pet-checksum-url <url>  Pet .sha256 sidecar URL (default: <pet-url>.sha256)
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
PET_URL=""
PET_CHECKSUM_URL=""
UPDATE=0

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
      URL="$2"; shift 2 ;;
    --checksum-url)
      [ "$#" -ge 2 ] || die "--checksum-url requires a value"
      CHECKSUM_URL="$2"; shift 2 ;;
    --pet-url)
      [ "$#" -ge 2 ] || die "--pet-url requires a value"
      PET_URL="$2"; shift 2 ;;
    --pet-checksum-url)
      [ "$#" -ge 2 ] || die "--pet-checksum-url requires a value"
      PET_CHECKSUM_URL="$2"; shift 2 ;;
    --update)
      UPDATE=1; shift ;;
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
      x86_64) TARGET="darwin-x64" ;;
      *) die "unsupported Darwin architecture: $(uname -m) (supported: arm64, x86_64)" ;;
    esac ;;
  Linux)
    case "$(uname -m)" in
      x86_64) TARGET="linux-x64" ;;
      *) die "unsupported Linux architecture: $(uname -m) (supported: x86_64)" ;;
    esac ;;
  *)
    die "unsupported host platform: $(uname -s) (supported: Darwin arm64/x86_64, Linux x86_64)" ;;
esac

# Packaged Pet executable basename inside the Pet archive: on macOS the binary
# lives at Wrenyard Pet.app/Contents/MacOS/Wrenyard Pet.
case "$(uname -s)" in
  Darwin) PET_EXE_BASENAME="Wrenyard Pet" ;;
  *)      PET_EXE_BASENAME="wrenyard-pet" ;;
esac

# Normalized suite zip: <repo>/releases/download/<tag>/wrenyard-<version>-<target>-suite.zip
case "$VERSION" in
  v*) TAG="$VERSION"; DIR_VERSION="${VERSION#v}" ;;
  *)  TAG="v$VERSION"; DIR_VERSION="$VERSION" ;;
esac
DEFAULT_URL="https://github.com/$REPO/releases/download/$TAG/wrenyard-$DIR_VERSION-$TARGET-suite.zip"
URL="${URL:-$DEFAULT_URL}"
CHECKSUM_URL="${CHECKSUM_URL:-$URL.sha256}"

# Packaged Pet is a separate release asset derived from the same repo/tag and
# installed into the same version tree under apps/pet.
DEFAULT_PET_URL="https://github.com/$REPO/releases/download/$TAG/wrenyard-pet-$DIR_VERSION-$TARGET.zip"
PET_URL="${PET_URL:-$DEFAULT_PET_URL}"
PET_CHECKSUM_URL="${PET_CHECKSUM_URL:-$PET_URL.sha256}"

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
log "downloading checksum sidecar: $CHECKSUM_URL"
fetch "$TMP_DIR/suite.zip.sha256" "$CHECKSUM_URL"

EXPECTED="$(awk '{print $1}' "$TMP_DIR/suite.zip.sha256" | tr '[:upper:]' '[:lower:]')"
[ -n "$EXPECTED" ] || die "checksum sidecar is empty: $CHECKSUM_URL"
ACTUAL="$(sha256_of "$TMP_DIR/suite.zip")"
[ "$ACTUAL" = "$EXPECTED" ] || die "checksum mismatch for $URL (expected $EXPECTED, got $ACTUAL)"
log "checksum verified ($ACTUAL)"

log "downloading pet: $PET_URL"
fetch "$TMP_DIR/pet.zip" "$PET_URL"
log "downloading pet checksum sidecar: $PET_CHECKSUM_URL"
fetch "$TMP_DIR/pet.zip.sha256" "$PET_CHECKSUM_URL"

PET_EXPECTED="$(awk '{print $1}' "$TMP_DIR/pet.zip.sha256" | tr '[:upper:]' '[:lower:]')"
[ -n "$PET_EXPECTED" ] || die "pet checksum sidecar is empty: $PET_CHECKSUM_URL"
PET_ACTUAL="$(sha256_of "$TMP_DIR/pet.zip")"
[ "$PET_ACTUAL" = "$PET_EXPECTED" ] || die "checksum mismatch for $PET_URL (expected $PET_EXPECTED, got $PET_ACTUAL)"
log "pet checksum verified ($PET_ACTUAL)"

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

# Extract the Pet archive separately and validate its packaged executable
# before anything is staged into the prefix.
mkdir -p "$TMP_DIR/pet-extract"
if command -v unzip >/dev/null 2>&1; then
  unzip -q "$TMP_DIR/pet.zip" -d "$TMP_DIR/pet-extract"
elif command -v tar >/dev/null 2>&1; then
  tar -xf "$TMP_DIR/pet.zip" -C "$TMP_DIR/pet-extract"
else
  die "need unzip (or a tar that can read zip archives) on PATH"
fi

PET_EXE_SRC="$(find_artifact "$TMP_DIR/pet-extract" "$PET_EXE_BASENAME")"
[ -n "$PET_EXE_SRC" ] || die "pet zip does not contain the packaged executable ($PET_EXE_BASENAME)"
[ -f "$PET_EXE_SRC" ] && [ -s "$PET_EXE_SRC" ] || die "packaged pet executable is not a non-empty regular file: $PET_EXE_SRC"

# ---------------------------------------------------------------------------
# Install into a fresh version directory. An existing version directory is
# never reused: the checksum-verified archives must always win, so a same-
# version reinstall replaces any locally tampered content. The new suite and
# Pet trees are staged beside the version directory, validated there, and
# swapped in with backup-and-restore semantics before `current` or any launcher
# is touched.
# ---------------------------------------------------------------------------
mkdir -p "$PREFIX" "$BIN_DIR" "$VERSIONS_DIR"

STAGING_DIR="$VERSIONS_DIR/.${DIR_VERSION}.staging.$$"
BACKUP_DIR="$VERSIONS_DIR/.${DIR_VERSION}.backup.$$"
rm -rf "$STAGING_DIR" "$BACKUP_DIR"
mkdir -p "$STAGING_DIR"
cp -R "$TMP_DIR/extract"/. "$STAGING_DIR"/

# Pet shares the version tree with the suite so both activate in one atomic
# swap: the archive contents are staged under apps/pet.
mkdir -p "$STAGING_DIR/apps/pet"
cp -R "$TMP_DIR/pet-extract"/. "$STAGING_DIR/apps/pet"/

find "$STAGING_DIR" -type f \( -name 'wrenyard' -o -name 'forge' -o -name 'foreman' -o -name 'foreman.mjs' -o -name 'node' -o -name 'wrenyard-pet' -o -name 'Wrenyard Pet' \) -exec chmod +x {} +

INSTALLED_WRENYARD="$(find_artifact "$STAGING_DIR" 'wrenyard')"
[ -n "$INSTALLED_WRENYARD" ] || die "installed suite is missing the wrenyard executable"

INSTALLED_PET_EXE="$(find_artifact "$STAGING_DIR/apps/pet" "$PET_EXE_BASENAME")"
[ -n "$INSTALLED_PET_EXE" ] || die "installed pet is missing the packaged executable ($PET_EXE_BASENAME)"
[ -f "$INSTALLED_PET_EXE" ] && [ -s "$INSTALLED_PET_EXE" ] || die "installed pet executable is not a non-empty regular file: $INSTALLED_PET_EXE"

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
# Report
# ---------------------------------------------------------------------------
log "installed wrenyard $DIR_VERSION at $VERSION_DIR"
printf '%s\n' "wrenyard $DIR_VERSION installed (suite + pet)"
printf '%s\n' "  current:   $CURRENT_LINK -> $VERSION_DIR"
printf '%s\n' "  launcher:  $BIN_DIR/wrenyard"
printf '%s\n' "  pet:       $VERSION_DIR/apps/pet"
if [ -n "$OLD_VERSION" ] && [ "$OLD_VERSION" != "$DIR_VERSION" ]; then
  log "previous version retained: $OLD_VERSION"
  log "rollback: $CURRENT_LINK -> $VERSIONS_DIR/$OLD_VERSION (re-run with --version $OLD_VERSION)"
  printf '%s\n' "rollback: switch manually with:"
  printf '%s\n' "  ln -sfn $VERSIONS_DIR/$OLD_VERSION $CURRENT_LINK"
else
  printf '%s\n' "rollback: old versions are retained under $VERSIONS_DIR"
fi
