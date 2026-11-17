#!/usr/bin/env bash
# Take a newer upstream Shepherdr release into this fork (FORK.md has the checklist around it).
#   scripts/fork/sync.sh <tag> --dry-run [--ref <upstream ref>] [--from <branch>]
#       what a merge of <tag> (or any upstream ref, e.g. upstream/main) into <branch> (default main) would do: changes
#       nothing (git merge-tree). Exit 0: it merges cleanly; 1: conflicts (the files are listed); 2: can't run.
#   scripts/fork/sync.sh <tag> [--from <branch>] [--no-check]
#       the real run: a branch sync/<tag> from <branch> with <tag> merged in (a merge commit, never a rebase), FORK.md's
#       pin and commit list brought up to date, scripts/fork/check.sh run, and our delta before and after printed (the
#       interdiff the reviewer reads). On a conflict it stops on that branch with the files listed.
# It never pushes, never force-pushes and never tags: it prints the commands for that.
set -u
die() { echo "sync: $1" >&2; exit "${2:-2}"; }
cd "$(git rev-parse --show-toplevel 2>/dev/null)" || die "not in a git checkout"

tag="" dry=0 ref="" from=main check=1
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) dry=1 ;;
    --ref) ref=${2:-}; shift ;;
    --from) from=${2:-}; shift ;;
    --no-check) check=0 ;;
    -h|--help) sed -n '2,11p' "$0"; exit 0 ;;
    -*) die "unknown option $1" ;;
    *) [ -z "$tag" ] || die "one tag only"; tag=$1 ;;
  esac
  shift
done
[ -n "$tag" ] || die "which upstream tag? scripts/fork/sync.sh <tag> [--dry-run]"
[ -z "$ref" ] || [ $dry = 1 ] || die "--ref is for dry runs only: a real sync takes a release tag"

# git merge-tree --write-tree needs git 2.38
v=$(git --version | sed 's/[^0-9.]*\([0-9][0-9]*\)\.\([0-9][0-9]*\).*/\1 \2/')
set -- $v
[ "$1" -gt 2 ] || { [ "$1" = 2 ] && [ "$2" -ge 38 ]; } || die "git 2.38 or newer is needed (this is $(git --version))"

# upstream: the Shepherdr repo (it was called herdr-projects before)
OWNER=eliasstravik/shepherdr
OWNER=${OWNER%/*}
url=$(git remote get-url upstream 2>/dev/null) || die "no remote named upstream: git remote add upstream https://github.com/$OWNER/shepherdr.git"
case "$url" in
  */$OWNER/shepherdr|*/$OWNER/shepherdr.git|*:$OWNER/shepherdr.git|*/$OWNER/herdr-projects|*/$OWNER/herdr-projects.git|*:$OWNER/herdr-projects.git) ;;
  *) die "the upstream remote is $url, not $OWNER's Shepherdr" ;;
esac

[ -z "$(git status --porcelain --untracked-files=no)" ] || die "the checkout has changes: commit or set them aside first"
git rev-parse -q --verify "refs/heads/$from" > /dev/null || die "no branch $from here"
if [ "$from" = main ] && git rev-parse -q --verify refs/remotes/origin/main > /dev/null; then
  git fetch -q origin main || die "can't fetch origin"
  [ "$(git rev-parse main)" = "$(git rev-parse origin/main)" ] || die "main isn't origin/main: pull or push it first (or --from <branch>)"
fi

git fetch -q upstream --tags || die "can't fetch upstream"
git fetch -q upstream main || die "can't fetch upstream main"
pin=$(sed -n 's/^pin: *\(v[^ ]*\) *$/\1/p' FORK.md 2>/dev/null | head -1)
[ -n "$pin" ] || die "FORK.md has no pin: line"
git rev-parse -q --verify "refs/tags/$pin^{commit}" > /dev/null || die "the pin $pin isn't a tag here"
if [ -n "$ref" ]; then
  target=$ref
  git rev-parse -q --verify "$ref^{commit}" > /dev/null || die "no such ref: $ref"
else
  target=$tag
  git rev-parse -q --verify "refs/tags/$tag^{commit}" > /dev/null || die "no upstream tag $tag (git ls-remote --tags upstream lists them)"
  git merge-base --is-ancestor "$tag" upstream/main || die "$tag isn't on upstream's main"
fi
git merge-base --is-ancestor "$pin" "$target" || die "$target doesn't come after the pin $pin"
[ "$(git rev-parse "$pin^{commit}")" != "$(git rev-parse "$target^{commit}")" ] || die "$target is the pin already"

ours=$(git diff --name-only "$pin" "$from")
theirs=$(git diff --name-only "$pin" "$target")
both=$(printf '%s\n' "$ours" | grep -xF -f <(printf '%s\n' "$theirs") || true)
echo "pin $pin → $target ($(git rev-list --count "$pin..$target") upstream commits), into $from"
echo "files our patch touches: $(printf '%s\n' "$ours" | grep -c .)"
echo "of those, changed upstream since the pin:"
printf '%s\n' "${both:-(none)}" | sed 's/^/  /'

if [ $dry = 1 ]; then
  out=$(git merge-tree --write-tree --name-only --no-messages "$from" "$target")
  rc=$?
  if [ $rc = 0 ]; then echo "dry run: $target merges into $from cleanly"; exit 0; fi
  if [ $rc = 1 ]; then echo "dry run: conflicts in:"; printf '%s\n' "$out" | sed '1d; /^$/d; s/^/  /'; exit 1; fi
  die "git merge-tree failed ($rc)"
fi

branch="sync/$tag"
git rev-parse -q --verify "refs/heads/$branch" > /dev/null && die "$branch exists already"
git switch -q -c "$branch" "$from" || die "can't make $branch"
if ! git merge -q --no-ff --no-edit -m "Sync to upstream $tag" "$tag"; then
  echo "sync: conflicts on $branch:" >&2
  git diff --name-only --diff-filter=U | sed 's/^/  /' >&2
  echo "Resolve them as FORK.md's checklist says (keep upstream's code, put our one-line hunks back), git commit, then go on with the checklist by hand from \"update FORK.md\"." >&2
  exit 1
fi

# FORK.md: the new pin and our commits on top of it
list=$(git log --no-merges --format='- %h %s' "$tag..HEAD" -- . ':(exclude)FORK.md')
awk -v pin="$tag" -v list="$list" '
  /^pin: / { print "pin: " pin; next }
  /<!-- commits:start -->/ { print; print list; skip = 1; next }
  /<!-- commits:end -->/ { skip = 0 }
  !skip { print }' FORK.md > FORK.md.tmp && mv FORK.md.tmp FORK.md
git commit -q -am "FORK.md: pin $tag" || die "can't commit FORK.md"

# our delta before and after: the interdiff (only moved lines should differ)
tmp=$(mktemp -d "${TMPDIR:-/tmp}/fork-sync.XXXXXX")
git diff "$pin" "$from" -- . ':(exclude)FORK.md' > "$tmp/before.diff"
git diff "$tag" "$branch" -- . ':(exclude)FORK.md' > "$tmp/after.diff"
strip() { grep -E '^(diff |[-+])' "$1" | grep -vE '^(\+\+\+|---) '; }
if diff -u <(strip "$tmp/before.diff") <(strip "$tmp/after.diff") > "$tmp/interdiff"; then
  echo "our delta is the same after the sync (no line of our patch changed)"
else
  echo "our delta changed; the interdiff ($tmp/interdiff):"; cat "$tmp/interdiff"
fi
echo "before: $tmp/before.diff  after: $tmp/after.diff"

if [ $check = 1 ]; then
  bash scripts/fork/check.sh || { echo "sync: the check failed on $branch: fix it there before the pull request" >&2; exit 1; }
fi
cat <<EOF

$branch is ready. Next (FORK.md's checklist):
  git push -u origin $branch
  gh pr create --repo <this fork> --base main --head $branch --title "Sync to upstream $tag"
Merge it with "Create a merge commit" only, then tag main: git tag fork/$tag-1 main && git push origin fork/$tag-1
EOF
