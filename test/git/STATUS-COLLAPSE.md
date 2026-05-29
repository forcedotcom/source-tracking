# StatusEntry collapse table

Lite's public `StatusEntry` is a single discriminated union
([isogit-migration.md:85](../../isogit-migration.md#L85)):

```ts
type StatusEntry = {
  readonly path: RepoPath;
  readonly status: 'unmodified' | 'modified' | 'added' | 'deleted' | 'ignored';
};
```

The status walker still works internally in terms of git's three-axis
cell representation `(head, workdir, stage)` ∈ `{0, 1, 2, 3}^3` — that
is the layout iso-git's `statusMatrix` uses, and it is the layout
lite's index walker carries through phase 6/7/8. This table is the
projection from those cells to the public union; lite emits the
right-hand value for each row and never exposes the cells.

| `head` | `workdir` | `stage` | git's name                                  | Lite's `status` |
| ------ | --------- | ------- | ------------------------------------------- | --------------- |
| 0      | 0         | 0       | absent                                      | (not emitted)   |
| 0      | 0         | 3       | added, then deleted in workdir              | `'deleted'`     |
| 0      | 2         | 0       | untracked                                   | `'added'`       |
| 0      | 2         | 2       | added, identical workdir/index              | `'added'`       |
| 0      | 2         | 3       | added, modified in workdir                  | `'added'`       |
| 0      | 0         | 2       | added, deleted in workdir but staged        | `'deleted'`     |
| 1      | 1         | 1       | unmodified                                  | `'unmodified'`  |
| 1      | 2         | 1       | modified, unstaged                          | `'modified'`    |
| 1      | 0         | 1       | deleted, unstaged                           | `'deleted'`     |
| 1      | 2         | 2       | modified, staged                            | `'modified'`    |
| 1      | 1         | 2       | modified+restaged identical                 | `'modified'`    |
| 1      | 0         | 0       | deleted, staged                             | `'deleted'`     |
| 1      | 2         | 3       | modified+restaged, then re-edited           | `'modified'`    |
| 1      | 1         | 0       | deleted, staged, restored in workdir        | `'modified'`    |
| 1      | 0         | 3       | deleted, staged, then a new copy in workdir | `'deleted'`     |

`'ignored'` is **not** a `(head, workdir, stage)` row. It is emitted by
the walker when the workdir entry matches a pattern in
`.git/info/exclude` (via the `ignore` library) **and** the file is not
already tracked (head = 0 ∧ stage = 0). Tracked files matching an
exclude pattern follow the rules above — ignore patterns are negative
filters, not status overrides, matching real-git.

## Rationale

Source-tracking's shadow has no partial-stage workflow: every
`applyChanges` stages and commits in one atomic step under
`withIndexLock`. The `(head, workdir, stage)` axes can therefore
collapse aggressively without information loss for source-tracking's
callers:

- Anything where the workdir disagrees with the head and the file is
  not gone → `'modified'`.
- Anything where the head is empty → `'added'`.
- Anything where the workdir is empty and the head is populated →
  `'deleted'`.
- The match (head = workdir = stage, all `1`) → `'unmodified'`.

This matches the cells iso-git's `statusMatrix` consumer in
[`localShadowRepo.ts:156-163`](../../src/shared/local/localShadowRepo.ts#L156-L163)
already projects (`isAdded`, `isDeleted`, modified-set membership).
The collapse here moves that projection into lite so callers do not
have to think in terms of cells.
