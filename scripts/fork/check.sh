#!/usr/bin/env bash
# This fork's whole check (FORK.md): the steps of upstream's GitHub check (.github/workflows/check.yml), run here.
#   scripts/fork/check.sh [--all | --since <commit>]   (npm run check runs it; it always runs everything: the options
#                                                      are the board's and change nothing)
# - Bun: the version CI pins. When the one on the PATH is another (an older Bun can't read the lockfile), that version
#   is fetched once from Bun's GitHub releases, checked against their SHA-256 list, into $TMPDIR/shepherdr-fork-bun.
# - Tests that already fail on the pinned upstream tag on this kind of machine (scripts/fork/known-failures-<OS>.txt)
#   are reported, not counted: upstream's CI runs on Linux, and some of its tests need Linux. Any other failure fails.
# - The installer runs into a throwaway root and a throwaway HOME under $TMPDIR, removed at the end.
set -u
cd "$(dirname "$0")/../.." || exit 2
ROOT=$(pwd)
TMP=${TMPDIR:-/tmp}
work=$(mktemp -d "$TMP/fork-check.XXXXXX") || exit 2
trap 'rm -rf "$work"' EXIT
failed=""
step() { printf '\n== %s\n' "$1"; }
bad() { echo "FAILED: $1"; failed="$failed
  $1"; }

# --- Bun at CI's version (scripts/fork/bun.sh) ----------------------------------------------------------------------
BUN=$(bash scripts/fork/bun.sh) || exit 2
PATH="$(dirname "$BUN"):$PATH"
export PATH
echo "Bun $(bun --version) ($BUN)"

known="scripts/fork/known-failures-$(uname -s).txt"
grep -v '^#' "$known" 2>/dev/null | sed '/^$/d' > "$work/known"
# judge <suite> <file of failed test names>: each one said as known or new; a new one (or a failure with no name
# found) fails the check
judge() {
  if [ ! -s "$2" ]; then bad "$1 (failed, no test named: read the log above)"; return; fi
  newer=""
  while IFS= read -r t; do
    if grep -qxF -e "$t" "$work/known"; then echo "  known (fails on the pinned tag here too): $t"
    else echo "  NEW: $t"; newer="$newer
    $t"; fi
  done < "$2"
  [ -z "$newer" ] || bad "$1:$newer"
}

step "shared lib copies match lib/"
python3 bin/sync-shared --check || bad "sync-shared"

step "JavaScript parses"
js=0
for f in $(find mods lib core -name '*.js' 2>/dev/null); do node --input-type=module --check < "$f" || { echo "doesn't parse: $f"; js=1; }; done
[ $js = 0 ] || bad "JavaScript parses"

step "TypeScript helpers build"
for f in $(find mods -name '*.ts'); do bun build --no-bundle --target bun "$f" > /dev/null || { bad "bun build $f"; break; }; done

step "JSON parses"
for f in keys.json layouts/*.json lib/addons.json lib/features.json $(find mods -name '*.json'); do
  python3 -m json.tool "$f" > /dev/null || bad "JSON $f"
done

step "service, shared core and web app (types, tests, build)"
bun install --frozen-lockfile || bad "bun install --frozen-lockfile"
bun web/build-plugins.ts || bad "build-plugins"
bunx tsc --noEmit -p . || bad "tsc"
bun test service core web > "$work/bun.log" 2>&1
rc=$?
tail -5 "$work/bun.log"
if [ $rc != 0 ]; then
  sed -n 's/^(fail) //p' "$work/bun.log" | sed 's/ \[[0-9.]*m*s\]$//' | sort -u > "$work/bun.fail"
  judge "bun test" "$work/bun.fail"
fi
bun run build > "$work/build.log" 2>&1 || { tail -20 "$work/build.log"; bad "bun run build"; }

step "shell scripts parse"
for f in install.sh bin/herdr-browser guard/herdr-app $(find mods -name '*.sh') scripts/fork/*.sh; do
  bash -n "$f" || bad "bash -n $f"
  case "$(head -1 "$f")" in *bash*) ;; *) sh -n "$f" || bad "sh -n $f" ;; esac
done

step "tests (repo rules, installer, herdr-task, this fork's)"
python3 -m unittest discover -s test > "$work/py.log" 2>&1
rc=$?
tail -3 "$work/py.log"
if [ $rc != 0 ]; then
  # "FAIL: test_x (module.Class.test_x)" (Python 3.11+) or "FAIL: test_x (module.Class)" (older): module.Class.test_x
  grep -E '^(FAIL|ERROR): ' "$work/py.log" | sed -E 's/^(FAIL|ERROR): ([^ ]+) \((.*)\)$/\2 \3/' \
    | awk '{ n = length($1); if (substr($2, length($2) - n) == "." $1) print $2; else print $2 "." $1 }' | sort -u > "$work/py.fail"
  judge "unittest" "$work/py.fail"
fi

step "installer into a brand-new throwaway home (dry run, install, doctor, uninstall; web only too)"
mkdir -p "$work/home"
for mode in full web; do
  root="$work/root-$mode"
  extra=""; [ $mode = web ] && extra="--web"
  { HOME="$work/home" ./install.sh --root "$root" $extra --dry-run --yes > "$work/inst-$mode.log" 2>&1 &&
    HOME="$work/home" ./install.sh --root "$root" $extra --yes >> "$work/inst-$mode.log" 2>&1 &&
    HOME="$work/home" python3 bin/shepherdr doctor --root "$root" >> "$work/inst-$mode.log" 2>&1 &&
    HOME="$work/home" python3 bin/shepherdr uninstall --root "$root" >> "$work/inst-$mode.log" 2>&1; } \
    && echo "install ($mode): ok" || { tail -20 "$work/inst-$mode.log"; bad "install ($mode)"; }
done

if [ -n "$failed" ]; then printf '\nThe check failed:%s\n' "$failed"; exit 1; fi
printf '\nThe check passed.\n'
