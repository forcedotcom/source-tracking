# UNTR (untracked-cache) extension format

Lifted from real-git's
[`Documentation/technical/index-format.txt`](https://github.com/git/git/blob/master/Documentation/technical/index-format.txt)
§"Untracked cache" and cross-checked against `read-cache.c` /
`dir.c`. This is the byte layout lite must produce; it is identical to
the bytes real-git ≥ 2.32 writes when `core.untrackedCache=true`.

This document resolves the open question at
[isogit-migration.md:263](../../isogit-migration.md#L263). It is the
format spec that phase 11 implements against.

## Where it lives

UNTR is an _index extension_. The index v2 layout is:

```
[ 12-byte header ][ entries ][ extension* ][ trailing SHA-1 of all preceding bytes ]
```

Each extension begins with a 4-byte signature and a 4-byte big-endian
size, followed by `size` bytes of payload. UNTR's signature is the
ASCII bytes `U N T R` (`0x55 0x4e 0x54 0x52`). Phase 9's index writer
emits all extensions after the entries and before the trailer; phase 11
appends UNTR there. Real-git ignores unknown extensions, so toggling
the feature flag back to iso-git is corruption-free.

## Payload layout

```
+------------------------------+
| environment header           |  variable-length, NUL-terminated
+------------------------------+
| info_exclude_stat (varint)   |  see "stat_data" below
+------------------------------+
| core_excludes_stat (varint)  |  see "stat_data" below
+------------------------------+
| exclude_per_dir SHA-1        |  20 bytes; SHA-1 of .git/info/exclude
|                              |  (lite emits this as the per-dir SHA
|                              |  for every directory, since lite reads
|                              |  no per-directory .gitignore files)
+------------------------------+
| info_exclude_oid             |  20 bytes; SHA-1 of the
|                              |  .git/info/exclude blob, repeated
|                              |  per real-git's two-slot layout
+------------------------------+
| number_of_directories N      |  varint (LEB128)
+------------------------------+
| directory[0]                 |  N records, depth-first per the
| directory[1]                 |  block ordering described below
| ...                          |
| directory[N-1]               |
+------------------------------+
| valid_bitmap                 |  ceil(N/8) bytes, LSB-first, bit i =
|                              |  "directory[i] is currently valid"
+------------------------------+
| check_only_bitmap            |  ceil(N/8) bytes, LSB-first, bit i =
|                              |  "directory[i] was only stat-checked"
+------------------------------+
| oid_bitmap                   |  ceil(N/8) bytes; bit i set iff
|                              |  directory[i] carries an exclude_oid
+------------------------------+
| stat_data block per dir      |  one cache_time + stat_data per
|                              |  directory[i] whose valid bit is 1
+------------------------------+
| exclude_oid per dir          |  one 20-byte SHA-1 per directory[i]
|                              |  whose oid_bitmap bit is 1
+------------------------------+
| untracked_files per dir      |  one block per dir: varint
|                              |  number_of_untracked, then NUL-
|                              |  terminated relative paths
+------------------------------+
```

### `environment` header

The header records the worktree environment used when the cache was
written. Real-git encodes a free-form ASCII string ending in `\0` of
the form `Location <abs_worktree>, system <uname.sysname>`. Lite mirrors
this layout. **Consequence:** UNTR fixtures captured on machine A do
not byte-equal UNTR bytes generated on machine B; tests that assert
UNTR-bytes equality must mask the environment header. Lite's writer
captures the worktree path from `cfg.dir`.

### `stat_data` (10 fields, varint each)

Per real-git ≤ 2.32 layout:

```
ctime_sec   (varint)
ctime_nsec  (varint)
mtime_sec   (varint)
mtime_nsec  (varint)
dev         (varint)
ino         (varint)
uid         (varint)
gid         (varint)
size        (varint, truncated to lower 32 bits)
mode        (varint)
```

`varint` here is git's `encode_varint` / `decode_varint` (LEB128 with
the high bit signaling continuation, little-endian).

### `directory` record

Each directory record is itself a payload:

```
varint  num_subdirs
varint  num_files
NUL-terminated  dir_name (relative to its parent; "" for root)
```

The N records appear in depth-first preorder. The root directory is
`directory[0]`; its `num_subdirs` says how many of the next records
are its children, recursively.

### Ordering of stat / oid / untracked-file blocks

The stat-data, exclude-oid, and untracked-files blocks come in the
same order as the directories in `directory[…]`, but are gated by the
three bitmaps. A bit set in `valid_bitmap` means the cache_time +
stat_data slot is present and trusted; a bit set in `oid_bitmap`
means an exclude_oid slot is present.

## What lite has to invariants-check before writing UNTR

Per [isogit-migration.md §Performance](../../isogit-migration.md#L165),
on first `switchTo` per gitdir lite probes:

```
mkdir tmpdir → stat → touch child → stat
```

and verifies that `mtime_nsec`, `ctime`, and `ino` advance as
expected. Failure (any of `unstable_ino`, `coarse_mtime`,
`ctime_static`) sets `untr.disabled = true` in `.git/config` and skips
the extension forever on that filesystem.

## What lite does **not** record

- `info/exclude` per-directory `.gitignore` SHAs — lite reads no
  per-directory ignore files; the `exclude_per_dir` slot is always the
  SHA of `.git/info/exclude` itself.
- `core.excludesFile` — lite does not honor the user-global excludes
  file. `core_excludes_stat` is written as zeros.
- Sparse-checkout state — out of scope for lite.

## Bytes-fidelity assertion strategy (phase 11 tests)

Two tiers:

1. **Round-trip:** lite writes UNTR, lite reads it back; structural
   equivalence (directory tree, stat fields, bitmaps).
2. **Cross-impl:** capture real-git's `test-tool dump-untracked-cache`
   output once into the `with-untr/` fixture. Lite's parsed structure
   must match. Bytes-fidelity (excluding the environment header) is
   asserted against the captured fixture on a single canonical
   capturing machine.

Real-git's `git fsck` is **not** run in CI per
[isogit-migration.md §Testing](../../isogit-migration.md#L221) — fsck
runs on the developer's machine when regenerating the fixture and the
expected output is captured into the fixture itself.
