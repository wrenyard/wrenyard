#!/usr/bin/env bash
#
# wrenyard one-command bootstrap (macOS arm64): read the static update feed,
# download the digest-verified suite zip, then run its install engine with the
# archive and every other argument passed through. Exits with the engine's code.
set -euo pipefail
log() { printf 'install.sh: %s\n' "$*" >&2; }
die() { log "error: $*"; exit 1; }

BASE="${WRENYARD_UPDATE_BASE_URL:-https://raw.githubusercontent.com/wrenyard/wrenyard/updates}"
VERSION=""; PASSTHROUGH=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --version) [ "$#" -ge 2 ] || die "--version requires a value"; VERSION="$2"; shift 2 ;;
    *) PASSTHROUGH+=("$1"); shift ;;
  esac
done
[ "$(uname -s)" = "Darwin" ] || die "unsupported host: $(uname -s) (use install.ps1 on Windows x64)"
[ "$(uname -m)" = "arm64" ] || die "unsupported architecture: $(uname -m) (supported: arm64)"
command -v curl >/dev/null 2>&1 || die "curl is required"

DIR_VERSION="${VERSION#v}"
FEED_URL="$BASE/dev.json"
[ -z "$VERSION" ] || FEED_URL="$BASE/versions/$DIR_VERSION.json"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/wrenyard-bootstrap.XXXXXX")"
trap 'rm -rf "$TMP_DIR"' EXIT
FEED="$TMP_DIR/feed.json"

log "fetching update feed: $FEED_URL"
curl -fsSL --retry 3 -o "$FEED" "$FEED_URL" || die "could not fetch update feed: $FEED_URL"
# Parsed with macOS's native plutil: the bootstrap must run on a bare host.
pluck() { /usr/bin/plutil -extract "$1" raw -expect string -o - "$FEED" || die "update feed is malformed ($1)"; }
[ "$(pluck schema_version)" = "wrenyard.update.v1" ] || die "unsupported update feed schema"

# The feed version must be valid SemVer (build metadata allowed) and, when the
# caller requested a version explicitly, must match it exactly.
SEMVER_RE='^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$'
FEED_VERSION="$(pluck version)"
[ -n "$FEED_VERSION" ] || die "update feed publishes no version"
printf '%s\n' "$FEED_VERSION" | grep -Eq "$SEMVER_RE" || die "update feed version is not valid semver: $FEED_VERSION"
if [ -n "$VERSION" ]; then
  [ "${VERSION#v}" = "$FEED_VERSION" ] || die "requested version ${VERSION#v} does not match feed version $FEED_VERSION"
else
  VERSION="$FEED_VERSION"
fi
DIR_VERSION="${VERSION#v}"

# Both platform assets must be present with raw 64-hex digests before download.
# Uppercase hex is accepted and normalized so the comparison with shasum holds.
SUITE_NAME="wrenyard-$DIR_VERSION-darwin-arm64-suite.zip"
DESKTOP_NAME="wrenyard-desktop-$DIR_VERSION-darwin-arm64.zip"
COUNT="$(/usr/bin/plutil -extract assets raw -expect array -o - "$FEED")" || die "update feed has no assets array"
SUITE_URL=""; SUITE_SHA=""; DESKTOP_FOUND=0; index=0
while [ "$index" -lt "$COUNT" ]; do
  NAME="$(pluck "assets.$index.name")"; SHA="$(pluck "assets.$index.sha256")"
  SHA="$(printf '%s' "$SHA" | tr 'A-F' 'a-f')"
  printf '%s\n' "$SHA" | grep -Eq '^[0-9a-f]{64}$' || die "update feed has an invalid digest for $NAME"
  case "$NAME" in
    "$SUITE_NAME") SUITE_URL="$(pluck "assets.$index.url")"; SUITE_SHA="$SHA" ;;
    "$DESKTOP_NAME") DESKTOP_FOUND=1 ;;
  esac
  index=$((index + 1))
done
[ -n "$SUITE_URL" ] || die "update feed has no asset $SUITE_NAME"
[ "$DESKTOP_FOUND" -eq 1 ] || die "update feed has no asset $DESKTOP_NAME"

log "downloading suite: $SUITE_URL"
curl -fsSL --retry 3 -o "$TMP_DIR/suite.zip" "$SUITE_URL" || die "could not download suite: $SUITE_URL"
ACTUAL="$(shasum -a 256 "$TMP_DIR/suite.zip" | awk '{print $1}')"
[ "$ACTUAL" = "$SUITE_SHA" ] || die "checksum mismatch for $SUITE_URL (expected $SUITE_SHA, got $ACTUAL)"

ditto -x -k "$TMP_DIR/suite.zip" "$TMP_DIR" || die "could not extract suite"
[ -x "$TMP_DIR/wrenyard" ] || die "suite does not contain a runnable wrenyard executable"
"$TMP_DIR/wrenyard" install --help >/dev/null 2>&1 || die "wrenyard install is unavailable in the downloaded suite"

"$TMP_DIR/wrenyard" install --version "$VERSION" --suite-zip "$TMP_DIR/suite.zip" ${PASSTHROUGH[@]+"${PASSTHROUGH[@]}"}
