# `test/git/fixtures/`

Hand-crafted `.git/` snapshots, captured once via real-git on a developer
machine and checked into the repo. Tests assert that lite produces
byte-identical output for the same logical state. Real-git is **not** a
runtime/test dependency.

## Layout

```
<fixture>/
  dot-git/   <- the real .git/ directory (renamed so the outer repo tracks
                its contents as plain files, not a nested submodule).
  work/      <- the workdir at fixture-capture time.
```

Tests that need `<fixture>/.git/` on disk re-link `dot-git/` into `work/.git/`
(or copy bytes into a memfs).

## Fixtures

| Fixture              | Validates                                                                                                                                                                                                                                                                                                           |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `empty/`             | phase 5 — `init` byte fidelity (canonical empty-tree object `4b825dc6…`).                                                                                                                                                                                                                                           |
| `single-file/`       | phases 2, 3, 6, 7, 9 — loose-object read/write, refs, index v2 round-trip.                                                                                                                                                                                                                                          |
| `nested-dirs/`       | tree reader/writer; mixed file modes (100644 + 100755 + 120000 symlink).                                                                                                                                                                                                                                            |
| `with-untracked/`    | phase 8 — statusMatrix collapse over the full union of states (untracked, ignored, modified, deleted, staged-add, unmodified).                                                                                                                                                                                      |
| `with-info-exclude/` | phase 8 — `ignore`-library matcher fed by `.git/info/exclude`, including negation.                                                                                                                                                                                                                                  |
| `with-untr/`         | phase 11 — UNTR extension parsing. **Captured on macOS APFS**; the UNTR `Environment` blob inside the index encodes the absolute worktree path of the capturing machine, so byte-equality of the UNTR section is not asserted across machines. The fixture's job is to feed lite's parser a valid UNTR byte stream. |

## Regenerating

```
test/git/fixtures/generate.sh
```

The script pins everything that affects bytes:

- `GIT_AUTHOR_NAME` / `GIT_COMMITTER_NAME` = `sfdx source tracking`
- `GIT_AUTHOR_EMAIL` / `GIT_COMMITTER_EMAIL` = `source-tracking@noreply.salesforce.com`
- `GIT_AUTHOR_DATE` / `GIT_COMMITTER_DATE` = `2026-01-01T00:00:00 +0000`
- `core.autocrlf=false`, `core.filemode=true`, `core.symlinks=true`,
  `commit.gpgsign=false`, `gc.auto=0`.

Regeneration is idempotent for every fixture except `with-untr/`, which
records the absolute worktree path; expect a path-string diff on that one
fixture when regenerated on a different machine.

## What the fixtures do **not** capture

- Packfiles. `gc.auto=0` keeps everything as loose objects so the bytes
  match the formats the lite reader/writer implements.
- Reflogs. Source-tracking does not write or read reflogs, and lite never
  will.
- Timezone variation. Always `+0000`. Lite stamps timestamps the same way
  via `Clock.currentTimeMillis` truncated to seconds.
