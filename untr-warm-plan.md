# UNTR warm-status plan

Goal: on a `getStatus` where nothing has changed since the last
`applyChanges`, skip the per-file workdir walk and ignore-matching pass.
Every call still verifies its assumptions via per-directory `stat`s, so
correctness is not sacrificed for speed.

This plan targets the lite shadow only. Iso continues to do what it does.

We do not commit to absolute wall time targets in this plan. CI runners
vary; the right success metric is "warm path runs without re-walking,"
verified by spans, not by stopwatch.

## Background — what cold status spends time on

`coldStatus` ([src/git/statusMatrix.ts](src/git/statusMatrix.ts)) does
three things on every call:

1. Walk every directory under each `cfg.roots` entry, stat every file
   (`walkOneRoot`).
2. Compute (head, index, workdir) tuples and resolve a `StatusEntry` per
   path.
3. Apply the `Ignore` matcher to each untracked file to classify it as
   `'added'` or `'ignored'`.

(1) and (3) are invariant when nothing has changed between two calls.
(2) is cheap once (1)'s result is in hand. The warm path caches the
output of (1) and (3) at per-directory granularity, validates by
re-statting each cached directory, and only re-walks directories whose
fingerprints have changed.

## Decisions

|                     | Choice                                                                                                                                                                                                                                                                |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| On-disk location    | Sidecar file at `.git/sftracking/untr.json`, NOT an index extension.                                                                                                                                                                                                  |
| Format              | JSON via Effect Schema. Real-git compat is out of scope; binary saves nothing material at this granularity.                                                                                                                                                           |
| Invalidation        | mtime + size on directory; mismatch → re-scan that directory only.                                                                                                                                                                                                    |
| Cached granularity  | Per-directory: untracked basenames + their resolved `'added' \| 'ignored'` status. Cuts both walk cost and ignore-match cost on warm.                                                                                                                                 |
| Lifecycle           | Write at end of every `commitChanges`; read at start of every `getStatus`.                                                                                                                                                                                            |
| In-process holder   | `Ref<Option<UntrCache>>` on `RepoHandle.internals`, populated lazily on first `getStatus` per process. Decoded once per process, not per call.                                                                                                                        |
| Ignore-rule changes | Track `.git/info/exclude` mtime in the cache header (full-invalidate if changed) AND each directory's local `.gitignore` mtime in its per-dir fingerprint (per-dir invalidate). Lite gains nested `.gitignore` evaluation as part of this — see "Ignore scope" below. |
| Probe               | Reuse `probeUntr`. Skip warm path entirely if probe failed.                                                                                                                                                                                                           |

### Sidecar over index extension

Earlier draft proposed embedding the cache as an extension on
`.git/index`. Switched to a sidecar because:

- Real-git running between two of our calls won't see the cache — no risk
  of confusing it. (Index-extension passthrough we just added in
  applyChanges drops cache-class signatures anyway.)
- Decoupled from `writeIndexV2`'s extension-encoding path.
- Can be deleted/corrupted without touching the index — recovery is
  always "rebuild from cold."

### Ignore scope

Real git evaluates nested `.gitignore` files at every level of the tree.
Lite's `coldStatus` today does not — [loadIgnoreMatcher](src/git/statusMatrix.ts#L37)
reads only `.git/info/exclude`.

This plan brings lite to parity with real git: nested `.gitignore`
evaluation, with per-directory fingerprinting so a `.gitignore` edit
deep in the tree only invalidates that directory's cache slice.

Cost-benefit: doing this here is much cheaper than doing it as a
follow-up. The warm-build walk already visits every directory; reading
that dir's `.gitignore` (if any) and stamping its mtime into the
fingerprint is one extra `fs.readFile` per directory that _contains_ a
`.gitignore`, which is a small minority of directories. The same walk
constructs the per-directory `Ignore` matcher the warm path needs.

Concrete changes implied:

- `loadIgnoreMatcher` is replaced by a per-directory matcher
  construction. Each directory's effective matcher = parent's matcher
  combined with that directory's `.gitignore` if present.
- The cache stores `dirGitignoreMtimeMs: u64` per directory (0 if no
  `.gitignore` in that directory) alongside `dirMtimeMs` and `dirSize`.
- A `.gitignore` edit inside a directory bumps that directory's
  `dirMtimeMs` _and_ its `dirGitignoreMtimeMs` — either signal alone
  triggers per-dir invalidation, but tracking the file mtime separately
  also covers `touch`-without-content-change semantics (which `dirSize`
  wouldn't catch).
- The header's `excludeMtimeMs` invalidates the _whole_ cache (since
  `info/exclude` applies globally).

## On-disk format (sidecar, JSON via Effect Schema)

Cache file: `.git/sftracking/untr.json`. Schema-driven JSON, not a
hand-rolled binary format. Real-git compat was already out of scope; the
binary format only saved bytes and parse cycles, both immaterial at the
per-directory granularity we cache.

```ts
const UntrEntryStatus = Schema.Literal('added', 'ignored');

const UntrEntry = Schema.Struct({
  path: RepoPath, // dir, posix, relative to workdir
  fingerprint: Schema.Struct({
    mtimeMs: Schema.Number,
    size: Schema.Number,
    gitignoreMtimeMs: Schema.Number, // 0 if no .gitignore in this dir
  }),
  untracked: Schema.Array(Schema.Struct({ name: Schema.String, status: UntrEntryStatus })),
});

export const UntrCache = Schema.Struct({
  schemaVersion: Schema.Literal(1), // bump on incompatible change
  excludeMtimeMs: Schema.Number, // 0 if .git/info/exclude absent
  entries: Schema.HashMap({ key: Schema.String, value: UntrEntry }),
});
export type UntrCache = Schema.Schema.Type<typeof UntrCache>;

const UntrCacheJson = Schema.parseJson(UntrCache); // bytes/string ↔ HashMap-bearing struct
```

Notes:

- All timestamps are `ms` (matches `@effect/platform`'s
  `Option<Date>.getTime()` representation). One representation throughout.
- The fingerprint is `(mtimeMs, size, gitignoreMtimeMs)`. No `ino`.
  `@effect/platform`'s `Info.ino` is `Option<number>` — JS-number-bounded,
  not u64-safe. `(mtime, size)` is the signal `probeUntr` validates as
  advancing on directory mutation; `gitignoreMtimeMs` covers
  `touch`-without-content-change semantics on the local `.gitignore`.
  Matches the stat-trust truncation we shipped in
  [applyChanges.ts](src/git/applyChanges.ts).
- Tracked-file status is NOT cached. The index is the source of truth for
  tracked paths and we already read it on every `getStatus`.
- Resolved untracked status (`added` / `ignored`) IS cached. The
  invalidate-on-`info/exclude`-mtime-change rule (header) and per-dir
  `.gitignore`-mtime rule (entry) cover the inputs to that resolution.
- No corruption trailer. `writeFile` goes through atomic temp+rename
  (same pattern as [refs.ts:writeAtomically](src/git/refs.ts#L136)) so
  partial writes can't produce a torn file.
- Schema evolution: add new fields as `Schema.optional` with defaults to
  avoid bumping `schemaVersion`. Bump only on semantic incompatibility.
- `Schema.HashMap` ([node_modules/effect/dist/dts/Schema.d.ts:4656](node_modules/effect/dist/dts/Schema.d.ts#L4656))
  encodes/decodes as `Array<[K, V]>` on the wire; the in-memory shape stays
  `HashMap.HashMap<string, UntrEntry>` end to end.

## Architecture

### New module: `src/git/untrCache.ts`

Hosts the `UntrCache` schema (above) plus Effect-shaped disk I/O. Public
surface:

```ts
// Schema definitions live here (UntrEntry, UntrCache, UntrCacheJson) —
// see "On-disk format" above.

export const readUntrCache: (gitdir: string) => Effect.Effect<Option.Option<UntrCache>, never, FileSystem | Path>;

export const writeUntrCache: (
  gitdir: string,
  cache: UntrCache
) => Effect.Effect<void, WorkdirIoError, FileSystem | Path>;
```

`readUntrCache` returns `Option.none()` for any failure mode — file
missing, JSON parse error, Schema decode error (covers schemaVersion
mismatch, missing fields, type errors). Schema's `ParseError` is logged
at trace level and absorbed; the warm path treats absence as "go cold."

`writeUntrCache` does `Schema.encodeSync(UntrCacheJson)` then atomic
temp+rename, mirroring [refs.ts:writeAtomically](src/git/refs.ts#L136).

### New module: `src/git/untrBuild.ts`

Builds the cache from a fresh workdir scan. Used at the end of
`applyChanges` (and lazily on first warm `getStatus` if no cache exists).

```ts
export const buildUntrCache: (
  cfg: SwitchCfg,
  matcher: Ignore,
  excludeMtimeMs: number
) => Effect.Effect<UntrCache, WorkdirIoError, FileSystem | Path>;
```

Implementation: per-root recursive walk like `walkOneRoot` but emits
`UntrEntry` per directory. Resolves each untracked file's `'added' \|
'ignored'` status via the same `Ignore` matcher used by cold, so the
cached values match what cold would produce. Bounded concurrency uses
`cfg.fdPermits` (NOT a hardcoded 256 — fix the same gap that exists in
`coldStatus` today, since we're touching this code).

### New module: `src/git/statusMatrixWarm.ts`

The warm path. Public surface mirrors `cold`:

```ts
export const warm: (
  cfg: SwitchCfg,
  cache: UntrCache,
  matcher: Ignore,
  excludeMtimeMs: number
) => Effect.Effect<readonly StatusEntry[], WorkdirIoError, FileSystem | Path>;
```

Note the return type: `Effect<readonly StatusEntry[]>`, not `Stream<...>`.
See "Stream-vs-array" below.

Algorithm:

1. If `excludeMtimeMs !== cache.excludeMtimeMs`, return `Option.none()` to
   the caller (signals full-invalidate); caller falls back to cold.
2. Read index + HEAD tree (same as cold; needed for tracked-file status).
3. For each cached directory:
   - `fs.stat(dir)` → if mtime+size match fingerprint → emit cached
     untracked entries directly (`{path, status}` from cache).
   - Mismatch → `walkOneDirectory(dir)` (a new helper that does NOT
     recurse into subdirs — those have their own cache entries) and
     resolve their statuses live.
4. For tracked paths, reuse `cellPure` / `cellHashing` from `cold`. These
   don't depend on the workdir walk.

Per-directory fallback note: each cached directory contributes a
self-contained slice of the path-set. The path-union step that cold
performs at [statusMatrix.ts:241-246](src/git/statusMatrix.ts#L241-L246)
is replaced by:

- HEAD-tree paths (deterministic from `streamHeadTree`)
- Index paths (deterministic from `readIndex`)
- Per-directory: cached basenames OR freshly walked basenames

The union → filter → sort step still runs once over all paths. Per-dir
fallback doesn't grow into a special case — it just changes how each
dir's basename slice is sourced.

### Wiring in `Repo`

Extend `RepoHandle.internals`:

```ts
type RepoHandle = {
  readonly cfg: SwitchCfg;
  readonly capabilities: Capabilities;
  readonly internals: {
    readonly untrEnabled: boolean;
    readonly cacheRef: Ref.Ref<
      Option.Option<{
        readonly mtimeMs: number; // sidecar mtime when loaded
        readonly cache: UntrCache;
      }>
    >;
  };
  readonly scope: Scope.CloseableScope;
};
```

`untrEnabled = capabilities.supportsUntr && probeResult.kind === 'ok'`.

`cacheRef` is populated lazily by the first `getStatus` of a process:
`fs.stat` the sidecar → read disk → decode → store the
`(mtimeMs, cache)` pair. On `applyChanges`, rebuild and write both ref
and disk (paired with the new sidecar's mtime). On any decode failure,
ref stays `none`, disk file is deleted, next `getStatus` rebuilds via
cold + writes a fresh cache.

In-process layer rationale: `Schema.decodeSync(UntrCacheJson)` plus
`JSON.parse` is not free at scale, and we want repeat `getStatus` calls
in the same process to skip even that work. `Ref` is the simplest
primitive that does it. `Effect.Cache` is over-fit here: there's no TTL,
no capacity bound, no per-key lookup.

The `mtimeMs` field paired with the cache is what makes the in-process
layer safe across cross-process mutations — see "Cross-process and
long-lived-process invalidation" below.

In `Repo.statusMatrix`:

```ts
const statusMatrix = () =>
  Stream.unwrap(
    requireHandle(handleRef, 'statusMatrix').pipe(
      Effect.map((h) => (h.internals.untrEnabled ? warmOrFallback(h) : provideFsAndPathStream(coldStatus(h.cfg))))
    )
  );
```

`warmOrFallback`:

1. `fs.stat` the sidecar to get its current `mtimeMs`. (One stat per
   `getStatus` call — negligible.)
2. If `cacheRef` is `none` OR the recorded `mtimeMs` is stale relative
   to disk, `readUntrCache` and store the fresh `(mtimeMs, cache)` pair
   in `cacheRef`. This catches the case where another process wrote a
   new sidecar since we last loaded.
3. Call `warm` with the now-fresh cache. On any signal that says
   "cache invalid" (excludeMtime drift, decode fail, sidecar absent),
   fall back to `cold` and rebuild.

In `Repo.applyChanges`, add the cache rebuild as a fourth concurrent
write alongside index + ref:

```ts
yield *
  Effect.all(
    [
      writeIndex(args.cfg.gitdir, entries, stableExts),
      writeDirectRef(args.cfg.gitdir, MAIN_REF, commitOid),
      h.internals.untrEnabled
        ? buildUntrCache(args.cfg, matcher, excludeMtimeMs).pipe(
            Effect.tap((cache) => Ref.set(h.internals.cacheRef, Option.some(cache))),
            Effect.flatMap((cache) => writeUntrCache(args.cfg.gitdir, cache))
          )
        : Effect.void,
    ],
    { concurrency: 'unbounded' }
  );
```

This happens INSIDE the `withIndexLock` critical section already wrapping
`buildAndCommit`, so two processes can't race on the cache file.

## Cross-process and long-lived-process invalidation

This library is consumed by both short-lived `sf` CLI invocations and
the Salesforce VS Code extensions. The extension host is a single Node
process that lives for hours; users routinely run `git checkout`,
`git revert`, or `sf deploy/retrieve` from a separate terminal during
an extension session. The cache must stay correct across all of those.

### Invariants this design relies on

1. **Tracked-file status is recomputed every call.** `coldStatus` and
   `warm` both re-read `.git/index` and re-stream `HEAD`'s tree on every
   `getStatus` ([statusMatrix.ts:225-234](src/git/statusMatrix.ts#L225-L234)
   for the cold version; warm follows the same shape). The cache stores
   only _untracked-file resolution_ and per-directory fingerprints —
   nothing that depends on which commit HEAD points at.
2. **Per-directory fingerprints are validated by re-statting on every
   `getStatus`.** A cached entry is trusted only if the directory's
   current `(mtime, size, gitignoreMtimeMs)` matches what we recorded.
   Mismatch → walk that directory live.
3. **Sidecar mtime gates the in-process `Ref`.** Every `getStatus`
   stats the sidecar. If its mtime advanced since we last loaded
   `cacheRef`, we reload from disk before validating per-dir
   fingerprints. This is what makes the long-lived process safe.

### Scenarios

**A. User runs `git checkout other-branch` outside our process.**

- `.git/index` rewritten; workdir files added/removed/rewritten.
- `.git/info/exclude` untouched → header `excludeMtimeMs` still matches.
- Sidecar untouched → in-process `Ref` mtime check passes; cache loaded
  remains the cache that was current pre-checkout.
- Tracked-file status is correct because we re-read the (post-checkout)
  index.
- Per-directory fingerprints: any directory whose listing changed has
  its mtime advance → fingerprint mismatch → re-walk that directory.
  A directory where only file _contents_ changed may not advance dir
  mtime, but cached entries are about _untracked_ files only and
  contents-only changes don't add or remove untracked files, so the
  cached untracked list is still correct. Tracked-file modifications
  come from the (always-fresh) index comparison.
- ✅ Correct.

**B. User runs `git revert` / `git reset --hard` outside our process.**

Mechanically identical to A: index + workdir mutated, `info/exclude`
and sidecar untouched. Same analysis. ✅ Correct.

**C. Separate process runs `sf deploy/retrieve` (which calls our
`applyChanges`).**

- That process atomically rewrites `.git/index` AND the sidecar under
  `withIndexLock`.
- Our extension's next `getStatus`: sidecar mtime advanced →
  `cacheRef` reloaded from disk → per-dir fingerprints validated →
  fresh state.
- ✅ Correct.

**D. Two extension calls overlap on the same gitdir.**

`withIndexLock` serializes `applyChanges` calls; the second sees the
post-first state. ✅ Correct.

### The remaining edge case

A real-git operation that:

- Modifies file _contents_ of a tracked file,
- Without adding/removing files in any directory,
- Without touching any `.gitignore` or `.git/info/exclude`,

does not advance any directory's mtime, does not advance the sidecar
mtime, and so does not trigger any reload. The cache stays loaded. But
the modified file is _tracked_ — its status comes from the
always-re-read index, which now disagrees with the workdir oid. The
existing cold/warm hash check on tracked-and-present-in-workdir paths
([cellHashing](src/git/statusMatrix.ts#L204)) detects this. ✅ Correct.

### Cost

One `fs.stat(sidecar)` per `getStatus`. Negligible against any walk or
hash work the call would otherwise do.

## Stream-vs-array

`coldStatus` returns a `Stream<StatusEntry>` but is structurally
non-streaming: the path-union barrier ([statusMatrix.ts:241-246](src/git/statusMatrix.ts#L241-L246))
forces all paths to materialize before any cell can emit, and downstream
consumers (`collectStatus` at [repo.ts:144](src/git/repo.ts#L144), the
shadow's `getStatus`) all `Stream.runCollect` immediately.

The warm path returns `Effect<readonly StatusEntry[]>` — honest about its
shape. Callers that want a `Stream` can wrap with `Stream.fromIterable`
at their boundary. We don't promise streaming we don't deliver.

### Why not retrofit cold into a real stream

We considered making `cold` actually stream. Two structural barriers
prevent it:

1. **Deletion detection.** A `'deleted'` status requires "in head or
   index, not in workdir" — you can only know after walking the entire
   workdir. The best partial-streaming shape is a two-phase split:
   stream non-deletions from the workdir walk, then a barriered second
   phase emits `(head ∪ index) − workdir` as `'deleted'`. The deletion
   set is barrier-bound either way.
2. **Sort order.** [statusMatrix.ts:240-244](src/git/statusMatrix.ts#L240-L244)
   sorts before emitting. Tests rely on stable order. Keeping the sort
   re-barriers the stream; dropping it forces a test rewrite.

Memory savings would be ~20MB at 200k scale (the `pure`/`hashed`/`cells`
arrays). The unavoidable head/index/workdir maps dominate; first-result
latency is irrelevant because every consumer `runCollect`s; backpressure
is pointless because no consumer is slow.

Cleanup scoped as a follow-up: change `cold`'s return type to
`Effect<readonly StatusEntry[]>` to match warm. Honest signature, no
new infrastructure. If a genuinely-streaming status API is ever needed
(e.g. a watcher emitting diffs), build it on top of UNTR's per-directory
cache where each directory's slice IS naturally independent.

## Concurrency

- Building the cache: `concurrency: cfg.fdPermits` on the per-directory
  walk. (Coincidentally fixes the hardcoded-256 issue in `walkOneRoot`
  for the warm-build call site.)
- Reading the cache: a single `fs.readFile` of the sidecar file, then
  `concurrency: cfg.fdPermits` on the per-directory fingerprint stats.
- Writing the cache: a single `fs.writeFile`. Use the same atomic
  temp+rename pattern as [refs.ts:writeAtomically](src/git/refs.ts#L136)
  so a crash mid-write can't leave a torn cache (which would force one
  cold-rebuild on next start, no data loss).

## Error behavior

- Cache file missing → fall back to cold. No error surfaced.
- Cache file present, decode fails → log warning, delete file, fall back
  to cold. Next `applyChanges` rebuilds.
- `excludeMtimeMs` mismatch → invalidate whole cache, fall back to cold,
  next `applyChanges` rebuilds.
- Single directory's fingerprint stat fails (e.g. dir deleted between
  cache write and next `getStatus`) → drop that dir's cache slice, walk
  it fresh inline. Other dirs' cache entries still apply.
- `untrEnabled === false` (probe failed or memfs) → never read or write
  the cache; cold path always.

All silent-recover. The cache is never load-bearing for correctness.

## Probe persistence

[untrProbe.ts](src/git/untrProbe.ts) currently runs on every `switchTo`
and only logs failures — the doc claims persistence to `.git/config` but
that's not implemented. Two options:

1. **Implement persistence as part of this plan.** First switch probes,
   writes `untr.disabled = true` on failure, subsequent switches read
   the flag and skip the probe.
2. **Accept per-switch probe cost.** Mkdir + two stats + a writeFile;
   small constant.

Decision: option 2. Persistence is a separate cleanup — adding it here
grows the scope without proportionate benefit.

## Testing

### Unit tests in `test/unit/git/untrCache.test.ts`

- Round-trip a sample cache through `Schema.encodeSync(UntrCacheJson)` /
  `Schema.decodeSync(UntrCacheJson)` with both `added` and `ignored`
  statuses present.
- Empty cache (no directories, no untracked entries) round-trips.
- `readUntrCache` on a missing file → `Option.none()`.
- `readUntrCache` on a malformed JSON file → `Option.none()` (Schema
  ParseError absorbed at the boundary).
- `readUntrCache` on `schemaVersion: 2` → `Option.none()` (forward-compat).
- `writeUntrCache` produces a file `Schema.decodeSync(UntrCacheJson)` can
  re-decode to the original `UntrCache` (HashMap equality).

### Unit tests in `test/unit/git/statusMatrixWarm.test.ts`

- Warm result equals cold result on an unchanged workdir (deep-equal on
  the StatusEntry array, sorted by path).
- Touching a file invalidates only that directory's cache entry; other
  dirs' fingerprints still hit.
- Adding a new file to a tracked directory: cached fingerprint mismatches
  (new dir size), warm walks just that dir, picks up the new entry.
- Editing `.git/info/exclude` invalidates the whole cache.
- `untrEnabled === false` → warm path never engages even with a present
  cache file.
- Cache file with corrupt JSON → silently treated as missing; next call
  rebuilds.

### NUT in `test/nuts/local/localTrackingScaleWarm.nut.ts`

The NUT runs in CI on GitHub Actions runners (variable, often slow).
No wall-time assertions. Coverage:

- **Span assertion (load-bearing):** warm path emits a `statusMatrixWarm`
  span; `walkOneRoot` does NOT appear on the second `getStatus` of the
  same process. Confirms the cache _engaged_.
- **Op-count assertion (load-bearing):** the second `getStatus` records
  at most `cachedDirectoryCount + cfg.roots.length` `fs.stat` spans (one
  per cached dir to validate fingerprints, plus one per root) and zero
  `hashBlob` / `readWorkdirBytes` spans against untracked paths. Cold
  records ~workdir-size stats and a `hashBlob` per untracked file. This
  catches "cache engaged but doing redundant work" — e.g. accidentally
  re-walking a cached directory, or re-decoding the JSON every call
  instead of reusing the in-process `Ref`. Span-presence alone wouldn't
  catch either.
- **Functional assertion (load-bearing):** warm-path output deep-equals
  a `getStatus(noCache: true)` cold-rebuild after a series of edits +
  commits. Catches drift bugs.

To make the op-count assertion work, the production code must wrap each
counted operation in an `Effect.fn` (or similar) that emits a span — at
minimum `fs.stat`, `fs.readFile`, `hashBlob`. Some are already traced
([statTrustOid](src/git/statusMatrix.ts#L116), [hashWorkdirOid](src/git/statusMatrix.ts#L132));
verify span coverage on the warm-build side as part of the implementation.

Span-capture harness: lite already configures spans via the OTel/NodeSdk
layer. We need a test-time `InMemorySpanExporter` registered to a
`Repo.layer.test` (or similar), exposing a count-by-name API for the
op-count assertion. If one doesn't exist yet, this NUT also ships the
harness. Place it under [test/perf-utils/](test/perf-utils/) so other
NUTs can adopt it.

## Effect-best-practices compliance

- `Effect.fn` for tracing on top-level entry points (`buildUntrCache`,
  `warm`, `writeUntrCache`, `readUntrCache`).
- `Effect.fnUntraced` on per-directory inner helpers (matches the
  `stageAdd` / `writeLooseObject` pattern we just established).
- Effect Schema for the `UntrCache` codec — no hand-rolled parser, no
  custom `TaggedError` for parse failures (Schema's `ParseError` is
  absorbed at the cache-load boundary).
- `Option<T>` (no null/undefined) at module boundaries.
- `HashMap` for the in-memory `entries` map; encode to bytes only at
  write time.
- No `process.env`; gating is via `Capabilities.supportsUntr` and the
  probe result, both already in the codebase.
- `catchTag` / `catchAll → fall back to cold` only at the cache-load
  boundary; no catch-and-swallow inside.

## Sequencing within the diff

One PR, three commits, in this order:

1. `untrCache.ts` + its unit tests. Self-contained codec; no behavior
   change.
2. `untrBuild.ts` + `statusMatrixWarm.ts` + the warm/cold equality unit
   tests. Builds and reads but is not yet wired into `Repo`.
3. `Repo` + `applyChanges` wiring + the warm-path NUT. Behavior change
   lands here.

Reviewable independently; bisectable if a regression appears.

## Risk register

| Risk                                                                                                                   | Mitigation                                                                                                                                                                      |
| ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cache fingerprint matches but the directory was touched in a way mtime didn't capture (e.g. `cp -a` preserving mtimes) | The probe filters out filesystems where mtime doesn't advance on mutation. For real (cp -a) cases, `getStatus(noCache: true)` is the existing escape hatch.                     |
| Cache file grows unbounded over many commits                                                                           | Each commit fully rewrites — no append. Cache size is bounded by directory count, not commit history.                                                                           |
| Two processes commit concurrently                                                                                      | Cache write happens inside `withIndexLock`; serialized.                                                                                                                         |
| Resolved `'ignored'` cached, then `info/exclude` mtime advances by exactly the same value (stat granularity)           | Real-git relies on the same fingerprint and gets the same race. The probe explicitly checks for coarse mtime; on filesystems that pass probe, this race is millisecond-bounded. |
| Schema evolution                                                                                                       | `schemaVersion: 1` in the header. Version mismatch → cache treated as missing; no migration. Bump when semantics change.                                                        |
| Sidecar file in `.git/sftracking/` confuses other tooling                                                              | The directory is namespaced under `.git/`, which all git tooling treats as opaque. Real-git ignores it.                                                                         |

## Out of scope

- Real-git compatibility for the cache (decided against in grilling).
- Cache compression. Cache size is bounded by directory count, not by
  workdir size; not a measured concern.
- Sub-directory invalidation (real-git's "valid" subdirectory bit; we
  can add it as a follow-up if measurement shows benefit).
- Background refresh / async preload. Cold is acceptable as fallback.
- Persisting the probe result to `.git/config`. Tracked separately.
- A `getStatus(noCache: false)` fast-path that skips the per-directory
  re-stat. We always validate; the cache earns its keep on (1) skipping
  the per-file walk and (2) skipping ignore-matching, both of which are
  larger than the per-directory stat cost.

## Done criteria

- All unit tests pass.
- The new NUT's span assertion confirms `walkOneRoot` does not run on
  the warm path.
- The new NUT's op-count assertion confirms warm `getStatus` performs
  at most `cachedDirectoryCount + cfg.roots.length` `fs.stat` calls and
  zero hashes of untracked workdir files.
- The new NUT's functional assertion confirms warm output equals
  `getStatus(noCache: true)` after a series of commits + edits.
- Iso path unaffected.
