# 4. UNTR cache: JSON via Effect Schema, in a sidecar file

Date: 2026-06-01

## Status

Proposed (implementation tracked in [untr-warm-plan.md](../untr-warm-plan.md)).

Note: an earlier draft (ADR-3) proposed a custom binary format embedded
in the `.git/index` extension area. Both the format and the location
decisions were revisited during plan review and the conclusions changed
enough that the prior ADR was deleted rather than marked superseded —
nothing in it was load-bearing that this ADR doesn't capture.

## Context

Cold `getStatus` on the lite shadow walks every directory under
`cfg.roots` and stats every file. A second `getStatus` with no
intervening mutation does the same work over again. Real git solves
this with the `UNTR` extension on `.git/index`
([index format docs][gitidx]): per-directory fingerprint + cached
untracked-file list, reused on the next status when fingerprints match.

We need to make four shape-of-the-system decisions:

1. **Wire format.** Hand-rolled binary or schema-driven JSON?
2. **Location.** Embedded as an extension on `.git/index`, or a separate
   sidecar file?
3. **Fingerprint.** Which `stat` fields make up the per-directory key?
4. **Ignore scope.** `.git/info/exclude` only (lite's status quo), or
   nested `.gitignore` evaluation (real-git parity)?

The shadow's `.git/` lives under
`<projectPath>/.sf/orgs/<orgId>/localSourceTracking/` and is intended
to be opaque to the user. Real-git can still operate on it (e.g. for
debugging) but real-git **always rebuilds its own UNTR from scratch**
when the extension is missing or has an unknown signature — so
real-git's behavior is identical whether we use real-git's format or
ours: it ignores both and walks.

## Decision

### 1. Format: JSON via Effect Schema

Real-git compatibility for cache extensions is **not** a goal. With that
constraint dropped, schema-driven JSON wins on every axis that matters:

- The codec is a few lines of `Schema.Struct` / `Schema.HashMap` /
  `Schema.parseJson` instead of ~300 lines of bit-level encode/decode.
- Schema validation produces structured `ParseError`s; we don't need a
  custom `TaggedError`.
- Forward-compatible field additions via `Schema.optional` with defaults
  — only bump `schemaVersion` on semantic incompatibility.
- The cache file is human-readable, useful for debugging.

Disk size goes up (~2-3x vs binary) and parse cost goes up a few ms.
Both immaterial: the cache is per-directory, not per-file, so we're
talking about hundreds-to-thousands of entries on a real project, not
hundreds-of-thousands.

We keep core index-entry compatibility — `IndexEntry`, header, sha
trailer in `.git/index` itself — because real-git **does** use those if
it ever opens the shadow. The cache extension is the only piece where
we depart from real-git's wire formats.

### 2. Location: sidecar file at `.git/sftracking/untr.json`

A "sidecar" is an auxiliary file living next to a primary file (analogy:
`.xmp` next to `.jpg`). The relationship is "primary is canonical;
sidecar is regenerable; deleting the sidecar doesn't harm the primary."

We chose sidecar over embedding the cache as an `.git/index` extension
because:

- Our extension-passthrough logic in
  [applyChanges.ts](../src/git/applyChanges.ts) explicitly drops
  cache-class extensions on every commit. An embedded cache would be
  destroyed by its own write path.
- A sidecar is one `fs.writeFile` (atomic temp+rename); an extension
  routes through `writeIndexV2`'s codec.
- Independent corruption recovery: torn sidecar → delete + rebuild from
  cold. The index is untouched.
- Clear ownership: `.git/sftracking/` is namespaced to source-tracking;
  `.git/index` is shared with anything that opens the shadow.

The sidecar can drift from the index if real-git mutates the index
without going through our `applyChanges`. Mitigations: the cache stores
per-directory fingerprints (not index OIDs), so a real-git mutation
that doesn't change directory listings doesn't make the cache
_incorrect_ — and any real-git mutation that does change directory
listings advances directory mtimes, which our per-dir fingerprint check
detects.

### 3. Fingerprint: `(mtimeMs, size, gitignoreMtimeMs)`

No `ino`. `@effect/platform`'s `File.Info.ino` is `Option<number>` —
JS-number-bounded, not u64-safe — so any ino we wrote would be derived
from a possibly-truncated value. `(mtime, size)` is also the only
signal `probeUntr` validates as advancing on directory mutation; ino
adds nothing the probe already excludes.

`gitignoreMtimeMs` is the per-directory `.gitignore` mtime (0 if
absent). It triggers per-dir invalidation when only a `.gitignore`'s
mtime advances (e.g. `touch .gitignore` with no content change), which
`(mtime, size)` on the directory itself wouldn't catch.

This matches the stat-trust truncation we shipped in
[applyChanges.ts](../src/git/applyChanges.ts) for the same reason — `dev`
and `ino` are stored truncated to u32 and the trust check uses
`(size, mtime)` only.

### 4. Ignore scope: per-directory `.gitignore` (parity with real git)

Lite's `coldStatus` today reads only `.git/info/exclude`
([statusMatrix.ts:37](../src/git/statusMatrix.ts#L37)). This plan brings
lite to parity with real-git: nested `.gitignore` at any tree depth.

The marginal cost of doing this here is small — the warm-build walk
already visits every directory; reading that dir's `.gitignore` if
present is one extra `fs.readFile` per directory that contains one.
Doing it as a follow-up would require a second walk-the-tree
implementation we'd then have to keep in sync.

The cache header tracks `excludeMtimeMs` (whole-cache invalidation).
Per-directory `gitignoreMtimeMs` lives in the per-entry fingerprint
(per-dir invalidation). Side effect: `coldStatus` will share the
per-directory matcher builder, so cold gains nested `.gitignore`
evaluation too. This fixes an existing scope cap and makes
cold-vs-warm equality assertions hold in tests.

## Consequences

- ~10 lines of codec, not ~300.
- Cache file is JSON, human-readable, debuggable with `jq`.
- Schema evolution via `Schema.optional` defaults; `schemaVersion`
  bumps reserved for semantic breaks.
- Real `git status` against the shadow rebuilds UNTR from scratch each
  time it runs. Acceptable: a user opening the shadow with real-git is
  a debug scenario, not a hot path.
- The sidecar can be deleted with no consequence beyond one cold
  rebuild.
- Lite gains nested `.gitignore` evaluation as a side effect of the
  per-directory matcher builder.

## Decisions captured but not load-bearing for this ADR

(Locked in by grilling, captured in [untr-warm-plan.md](../untr-warm-plan.md);
not hard-to-reverse so no ADR each.)

- Per-directory granularity (not per-package-root).
- Cache written at end of every `applyChanges`; read at start of every
  `getStatus`.
- Probe gating reuses [`probeUntr`](../src/git/untrProbe.ts).
- In-process `Ref<Option<{mtimeMs, cache}>>` reload-on-mtime-change
  keeps long-lived consumers (the VS Code extension host) correct
  across cross-process mutations.

[gitidx]: https://git-scm.com/docs/index-format#_untracked_cache
