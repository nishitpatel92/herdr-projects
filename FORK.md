# This fork

Our pinned Shepherdr: upstream ([eliasstravik/shepherdr](https://github.com/eliasstravik/shepherdr)) at one release
tag, plus a small set of our own commits. They add **proxy mode**: the web app reached through our own reverse proxy
(Caddy on a home server, over the home LAN and WireGuard) instead of Tailscale, with each device paired once
([docs/web-proxy.md](docs/web-proxy.md)). Everything else is upstream's.

pin: v3.1.37

## Branches and tags

- `main` is the pinned branch: upstream's history up to the pin, merged in, with our commits on top. It is never
  rebased or force-pushed.
- A sync merges a newer upstream tag into a `sync/<tag>` branch, which comes into `main` by a pull request merged with
  **"Create a merge commit"** only. A squash or rebase merge would cut upstream's history out of `main`, and every later
  sync would conflict on everything.
- After each merge into `main`, tag it `fork/<tag>-<n>` (`fork/v3.1.37-1`, then `-2` for our next change on the same
  pin) and push the tag: that is the version the machines install.
- What is ours: `git log --no-merges --oneline <pin>..main`, and as one diff `git diff <pin> main`.

## Our commits on the pin

<!-- commits:start -->
- (filled in by scripts/fork/sync.sh on each sync)
<!-- commits:end -->

## What we change, and where

New files, ours alone: `service/devices.ts`, `service/proxy.ts`, `service/proxy-pages.ts`, `service/proxy-cli.ts`, their
tests (`service/*.test.ts`, `test/test_fork_proxy.py`), `docs/web-proxy.md`, `scripts/fork/`, this file,
`.herdr-projects.json`. Edits to upstream's files are kept to one-line hunks, so a sync rarely conflicts:

- `service/auth.ts`: `Pass.via` may be `"proxy"`.
- `service/main.ts`: the import; `ownLink` prefers the proxy link; push's subject (`pushOrigin`); "Tailscale isn't
  running here" not said with proxy mode on; `deviceFrom` for a proxied device; `Bun.serve(withProxy({…}))`; the two
  web-visitor checks also `proxied(req)`; `proxyPass(req) ?? gate(…)`; `/api/proxy/*` handed to `proxyApi`.
- `bin/shepherdr`: `shepherdr web proxy|pair|devices|revoke` run `service/proxy-cli.ts`; their lines in the usage.
- `package.json`: a `check` script (`npm run check` runs `scripts/fork/check.sh`).

## The check

`scripts/fork/check.sh` (also `npm run check`) runs the steps of upstream's GitHub check here: shared lib copies, the
JavaScript and JSON parse, the TypeScript helpers, `tsc`, `bun test service core web`, the web build, the shell scripts,
`python3 -m unittest discover -s test`, and the installer into throwaway roots (full and `--web`: dry run, install,
doctor, uninstall). It uses CI's Bun version, fetching it into `$TMPDIR` when the one here is another.

Some upstream tests fail on a Mac on the pinned tag itself (CI runs on Linux). They are listed in
`scripts/fork/known-failures-Darwin.txt`, found by running the check on the pure tag; the check names them and fails
only on a failure that isn't listed. Make the list again on each sync: run the check on the pure new tag (a `git
archive` of it with `scripts/fork/` copied in) and keep only what fails there.

## Taking a newer upstream release (the checklist)

1. `scripts/fork/sync.sh <tag> --dry-run`: says whether it merges cleanly, which of our files upstream changed since
   the pin, and the conflicting files (exit 1). Nothing is changed.
2. Read upstream's `CHANGELOG.md` between the pin and the tag for anything about the service's auth (`service/auth.ts`,
   `peer.ts`, `tailscale.ts`), how `service/main.ts` serves, push alerts, or Serve from. Proxy mode may need to follow.
3. `scripts/fork/sync.sh <tag>`: the real run, on a new branch `sync/<tag>` from `main`.
4. On a conflict, keep upstream's code and put our one-line hunks back where the same logic now is (the list above);
   don't restructure upstream's code. `git commit`, then update FORK.md's `pin:` line and commit list by hand
   (`git log --no-merges --format='- %h %s' <tag>..HEAD`), and run `scripts/fork/check.sh`.
5. Read the interdiff it prints (our delta before and after): only moved lines should differ.
6. Remake `scripts/fork/known-failures-Darwin.txt` for the new tag if the check names a new failure that also fails on
   the pure tag (see The check). A failure that doesn't fail on the pure tag is ours to fix.
7. `scripts/fork/check.sh` passes on `sync/<tag>`.
8. Push `sync/<tag>` and open a pull request `Sync to upstream <tag>` into `main`. GitHub's Check workflow runs on it.
9. Review: someone who did not do the sync reads the interdiff, the proxy tests (`service/proxy*.test.ts`,
   `service/devices.test.ts`, `service/auth.test.ts`) and the check's output.
10. Merge with "Create a merge commit". Tag `main` `fork/<tag>-1` and push the tag.
11. Install on the machines (`./install.sh` from a checkout of the tag): a separate, live step.

## Upstream

We may propose a trusted reverse proxy mode with device pairing upstream, so this patch can one day go away. Nothing is
opened upstream without the owner's yes.
