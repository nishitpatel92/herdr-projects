#!/usr/bin/env bash
# The Bun this fork's check and setup use (FORK.md): prints its path. The one on the PATH when it is the version
# upstream's GitHub check pins (.github/workflows/check.yml); else that version, fetched once from Bun's GitHub releases
# and checked against their SHA-256 list, into $TMPDIR/shepherdr-fork-bun/<version> (an older Bun can't read the lockfile).
set -u
cd "$(dirname "$0")/../.." || exit 2
want=$(sed -n 's/^ *bun-version: *//p' .github/workflows/check.yml | head -1)
[ -n "$want" ] || { echo "bun.sh: no bun-version in .github/workflows/check.yml" >&2; exit 2; }
have=$(command -v bun || true)
if [ -n "$have" ] && [ "$("$have" --version)" = "$want" ]; then echo "$have"; exit 0; fi
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) asset=bun-darwin-aarch64 ;;
  Darwin-x86_64) asset=bun-darwin-x64 ;;
  Linux-aarch64|Linux-arm64) asset=bun-linux-aarch64 ;;
  *) asset=bun-linux-x64 ;;
esac
dir="${TMPDIR:-/tmp}/shepherdr-fork-bun/$want"
if [ ! -x "$dir/$asset/bun" ]; then
  echo "Bun $want (CI's) isn't on the PATH${have:+ (found $("$have" --version))}: fetching it into $dir" >&2
  mkdir -p "$dir" || exit 2
  base="https://github.com/oven-sh/bun/releases/download/bun-v$want"
  { curl -fsSL -o "$dir/$asset.zip" "$base/$asset.zip" && curl -fsSL -o "$dir/SHASUMS256.txt" "$base/SHASUMS256.txt"; } \
    || { echo "bun.sh: can't fetch Bun $want" >&2; exit 2; }
  sum=$(shasum -a 256 "$dir/$asset.zip" 2>/dev/null || sha256sum "$dir/$asset.zip")
  grep -q "^${sum%% *}  $asset.zip\$" "$dir/SHASUMS256.txt" \
    || { echo "bun.sh: Bun $want's checksum doesn't match: not used" >&2; rm -f "$dir/$asset.zip"; exit 2; }
  (cd "$dir" && unzip -qo "$asset.zip") || exit 2
fi
echo "$dir/$asset/bun"
