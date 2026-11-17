#!/usr/bin/env bash
# A fresh worktree of this fork made ready (the board's workspace setup, FORK.md): its packages from the lockfile as it
# is, with CI's Bun (scripts/fork/bun.sh), and the web app's plugin list (web/generated), as docs/develop.md asks.
set -u
cd "$(dirname "$0")/../.." || exit 2
BUN=$(bash scripts/fork/bun.sh) || exit 2
"$BUN" install --frozen-lockfile && "$BUN" web/build-plugins.ts
