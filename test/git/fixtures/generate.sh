#!/usr/bin/env bash
# Regenerate every fixture .git/ snapshot from real-git, deterministically.
#
# Pinned env so commit oids are reproducible across machines:
#   GIT_AUTHOR_NAME / GIT_COMMITTER_NAME = "sfdx source tracking"
#   GIT_AUTHOR_EMAIL / GIT_COMMITTER_EMAIL = "source-tracking@noreply.salesforce.com"
#   GIT_AUTHOR_DATE / GIT_COMMITTER_DATE = "2026-01-01T00:00:00 +0000"
#
# Each fixture is laid out as:
#   <fixture>/dot-git/   <-- the real .git/ directory, renamed so it is
#                            tracked in the parent source-tracking repo.
#   <fixture>/work/      <-- the workdir snapshot at fixture-capture time.
#
# We copy dot-git/ -> .git/ (and work/ -> the workdir) in test setup; the
# rename keeps the fixtures from confusing the outer repo's git client.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

export GIT_AUTHOR_NAME="sfdx source tracking"
export GIT_COMMITTER_NAME="sfdx source tracking"
export GIT_AUTHOR_EMAIL="source-tracking@noreply.salesforce.com"
export GIT_COMMITTER_EMAIL="source-tracking@noreply.salesforce.com"
export GIT_AUTHOR_DATE="2026-01-01T00:00:00 +0000"
export GIT_COMMITTER_DATE="2026-01-01T00:00:00 +0000"
export TZ=UTC

# pin config that affects bytes
git_init() {
  local dir="$1"
  rm -rf "$dir"
  mkdir -p "$dir"
  git -C "$dir" init -q -b main
  git -C "$dir" config core.autocrlf false
  git -C "$dir" config core.filemode true
  git -C "$dir" config core.symlinks true
  git -C "$dir" config commit.gpgsign false
  git -C "$dir" config tag.gpgsign false
  git -C "$dir" config gc.auto 0
  git -C "$dir" config core.untrackedCache false
}

freeze() {
  # Move the live .git/ into dot-git/ so the outer repo tracks it as plain
  # files, not as a nested git directory.
  local fixture="$1"
  rm -rf "$fixture/dot-git"
  mv "$fixture/work/.git" "$fixture/dot-git"
  # Strip noise that lite never produces or reads: sample hooks, the
  # default description string, COMMIT_EDITMSG, reflog (logs/). Keeping
  # them would force fixture bytes to diverge from anything lite writes.
  rm -rf "$fixture/dot-git/hooks" "$fixture/dot-git/logs"
  rm -f  "$fixture/dot-git/description" "$fixture/dot-git/COMMIT_EDITMSG"
  # Park the workdir copy. Tests that need bytes-on-disk re-link dot-git
  # back into work/.git.
}

# ---------------------------------------------------------------- empty
empty() {
  local fixture="empty"
  rm -rf "$fixture"
  mkdir -p "$fixture/work"
  git_init "$fixture/work"
  git -C "$fixture/work" commit -q --allow-empty -m "init"
  freeze "$fixture"
}

# --------------------------------------------------------- single-file
single_file() {
  local fixture="single-file"
  rm -rf "$fixture"
  mkdir -p "$fixture/work"
  git_init "$fixture/work"
  printf 'hello\n' > "$fixture/work/hello.txt"
  git -C "$fixture/work" add hello.txt
  git -C "$fixture/work" commit -q -m "add hello"
  freeze "$fixture"
}

# --------------------------------------------------------- nested-dirs
nested_dirs() {
  local fixture="nested-dirs"
  rm -rf "$fixture"
  mkdir -p "$fixture/work"
  git_init "$fixture/work"
  # plain file (mode 100644)
  mkdir -p "$fixture/work/a/b"
  printf 'plain\n' > "$fixture/work/a/b/plain.txt"
  # executable file (mode 100755)
  printf '#!/bin/sh\necho hi\n' > "$fixture/work/a/b/run.sh"
  chmod +x "$fixture/work/a/b/run.sh"
  # symlink (mode 120000) -> link target string is the blob
  ln -s "../b/plain.txt" "$fixture/work/a/link-to-plain"
  # second branch of the tree
  mkdir -p "$fixture/work/c"
  printf 'second\n' > "$fixture/work/c/two.txt"
  git -C "$fixture/work" add -A
  git -C "$fixture/work" commit -q -m "nested"
  freeze "$fixture"
}

# ------------------------------------------------------- with-untracked
with_untracked() {
  local fixture="with-untracked"
  rm -rf "$fixture"
  mkdir -p "$fixture/work"
  git_init "$fixture/work"
  # baseline: tracked, then mutated to exercise statusMatrix collapse
  printf 'one\n' > "$fixture/work/tracked-unmodified.txt"
  printf 'two\n' > "$fixture/work/tracked-modified.txt"
  printf 'three\n' > "$fixture/work/tracked-deleted.txt"
  git -C "$fixture/work" add -A
  git -C "$fixture/work" commit -q -m "baseline"

  # modify a tracked file (workdir != HEAD == index)
  printf 'two-changed\n' > "$fixture/work/tracked-modified.txt"
  # delete a tracked file (workdir missing, HEAD == index)
  rm "$fixture/work/tracked-deleted.txt"
  # add a brand-new untracked file
  printf 'untracked\n' > "$fixture/work/untracked.txt"
  # stage a new file (added: HEAD missing, index == workdir)
  printf 'staged\n' > "$fixture/work/staged-add.txt"
  git -C "$fixture/work" add staged-add.txt
  # ignored file: written to .gitignore + matching content
  printf 'ignored.log\n' > "$fixture/work/.gitignore"
  printf 'ignored\n' > "$fixture/work/ignored.log"
  # NB: lite reads .git/info/exclude only, but capturing the workdir-side
  # .gitignore matches what real-git's status reports here.

  freeze "$fixture"
}

# -------------------------------------------------- with-info-exclude
with_info_exclude() {
  local fixture="with-info-exclude"
  rm -rf "$fixture"
  mkdir -p "$fixture/work"
  git_init "$fixture/work"
  printf 'tracked\n' > "$fixture/work/tracked.txt"
  git -C "$fixture/work" add -A
  git -C "$fixture/work" commit -q -m "baseline"
  # non-trivial info/exclude patterns, including negation
  cat > "$fixture/work/.git/info/exclude" <<'EOF'
# written by source-tracking fixture
**/.*
**/node_modules/**
**/__tests__/**
**/.gitignore
.DS_Store
# negation: keep .keep files even though dotfiles are excluded
!**/.keep
EOF
  # files that exercise the rules
  mkdir -p "$fixture/work/node_modules/foo"
  printf 'pkg\n' > "$fixture/work/node_modules/foo/index.js"
  mkdir -p "$fixture/work/src/__tests__"
  printf 'test\n' > "$fixture/work/src/__tests__/x.test.js"
  printf 'ds\n' > "$fixture/work/.DS_Store"
  printf 'kept\n' > "$fixture/work/.keep"
  freeze "$fixture"
}

# ------------------------------------------------------------- with-untr
# Populates the UNTR (untracked-cache) extension. Requires real-git >= 2.32
# and a filesystem whose stat invariants UNTR depends on (we capture on
# macOS APFS during fixture authoring; the bytes are checked into the repo
# regardless).
with_untr() {
  local fixture="with-untr"
  rm -rf "$fixture"
  mkdir -p "$fixture/work"
  git_init "$fixture/work"
  git -C "$fixture/work" config core.untrackedCache true
  printf 'tracked\n' > "$fixture/work/tracked.txt"
  mkdir -p "$fixture/work/sub"
  printf 'nested\n' > "$fixture/work/sub/nested.txt"
  git -C "$fixture/work" add -A
  git -C "$fixture/work" commit -q -m "baseline"
  printf 'u\n' > "$fixture/work/untracked-root.txt"
  printf 'u2\n' > "$fixture/work/sub/untracked-nested.txt"
  # populate the UNTR extension by running status with the cache enabled
  git -C "$fixture/work" -c core.untrackedCache=true status --porcelain >/dev/null
  freeze "$fixture"
}

main() {
  empty
  single_file
  nested_dirs
  with_untracked
  with_info_exclude
  with_untr
  echo "fixtures regenerated under $HERE"
}

main "$@"
