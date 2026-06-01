# `src/git/` implementation plan

Companion to [isogit-migration.md](isogit-migration.md). The spec answers _what_ and _why_; this doc answers _in what order_ and _gated by what_. Edit one when scope shifts; edit the other when sequencing shifts.

---

## Ground rules

- Each phase is mergeable on its own — no half-built API surface behind a flag inside `src/git/`. The consumer-side flag (`SF_SOURCE_TRACKING_USE_LITE_GIT`) is the only gate, and it doesn't go live until phase 12.
- Each phase ships its own tests. Byte-fidelity assertions use golden fixtures (phase 0); behavioral assertions can use synthetic inputs.
- iso-git stays in `package.json` until phase 14. Both code paths coexist for one release cycle.
- "Done" for a phase = tests green + lint clean + the next phase's prereqs satisfied.

---

## Phase 0 — Fixtures and baseline

**Why first:** every later phase asserts byte fidelity against real-git output. Without fixtures captured upfront, every PR re-litigates "is this the right bytes." Baseline numbers are also required by the acceptance gate ([isogit-migration.md:367-377](isogit-migration.md#L367-L377)).

**Deliverables**

- `test/git/fixtures/` directory with hand-crafted `.git/` snapshots, captured on a dev machine via real-git:
  - `empty/` — `git init` + `git commit --allow-empty -m init` (validates phase 5).
  - `single-file/` — one file added + committed (validates phases 3, 7, 9).
  - `nested-dirs/` — multi-level tree, mixed file modes (100644 + 100755 + symlink) (validates tree reader/writer).
  - `with-untracked/` — staged + unstaged + untracked + ignored mix (validates statusMatrix collapse table).
  - `with-untr/` — populated UNTR extension; capture from real-git ≥ 2.32 with `core.untrackedCache=true` (validates phase 11).
  - `with-info-exclude/` — non-trivial `.git/info/exclude` content (validates ignore matcher integration).
- `test/git/fixtures/README.md` — recipe for regenerating each fixture (real-git command sequence + env/clock pinning).
- Baseline perf numbers checked in as `test/git/baselines.json`:
  - Cold `statusMatrix` wall time on `~/eng/repros/perf-tracking-bug`.
  - `applyChanges` (50k files) wall time.
  - Max event-loop delay during cold `statusMatrix`.
- UNTR format spike notes (separate doc, ~1 page): exact byte layout lifted from [git's index-format.txt](https://github.com/git/git/blob/master/Documentation/technical/index-format.txt). Resolves the open question at [isogit-migration.md:263](isogit-migration.md#L263) before phase 11 commits to a date.
- StatusEntry collapse table — concrete mapping from git's `(head, workdir, stage)` 0|1|2|3 cells to the public union at [isogit-migration.md:85](isogit-migration.md#L85). Lands in `src/git/README.md` or as a JSDoc on the schema.

**Tests:** none yet — this phase produces test inputs.

**Exit:** fixtures committed, baseline numbers captured on a clean main, UNTR spike merged.

---

## Phase 1 — Service scaffolding

**Why:** every later phase plugs into this shape. Land it empty so PRs after it are pure additions.

**Deliverables**

- `src/git/` directory + `NOTICE.md` ([isogit-migration.md:382-397](isogit-migration.md#L382-L397)).
- `Repo` `Effect.Service` shell with all 9 methods returning `Effect.die("not implemented")` or equivalent. Public types from [isogit-migration.md:51-77](isogit-migration.md#L51-L77).
- All schemas: `Oid`, `RepoPath`, `RefName`, `StatusEntry`, `Author`, `SwitchCfg` ([isogit-migration.md:80-86](isogit-migration.md#L80-L86)). With `Equivalence`/`Hash` derivations.
- All tagged errors ([isogit-migration.md:90-98](isogit-migration.md#L90-L98)).
- `FileSystem` + `Path` + `Clock` Layer wiring; `Capabilities.supportsUntr` flag plumbed through.
- `switchTo` lifecycle: `handleRef`, `swapSemaphore`, `currentHandleScope`, prior-scope close ([isogit-migration.md:107-119](isogit-migration.md#L107-L119)).
- `RepoNotConfiguredError` returned by every other method when no `switchTo` has occurred.

**Tests**

- Schema round-trips (encode/decode, brand rejection of bad inputs).
- `switchTo` swap: in-flight Effect against handle A continues to see handle A after B is installed; B sees its own config; prior scope finalizers run.
- `RepoNotConfiguredError` emitted from every public method pre-`switchTo`.

**Exit:** `Repo.Default` layer constructible in a Node test; type-check passes for all public signatures; no behavior yet.

---

## Phase 2 — Loose-object I/O

**Why:** smallest unit of git byte-fidelity. Everything reads or writes blobs, trees, commits.

**Deliverables**

- `writeLooseObject(type, content) → Oid` — zlib-deflate, `<type> <size>\0<content>`, write to `.git/objects/<oid[0:2]>/<oid[2:]>`.
- `readLooseObject(oid) → { type, content }` — inverse, with header parse + sha verification → `ObjectCorruptError`, missing → `ObjectNotFoundError`.
- `hashBlob(bytes) → Oid` (public API; pure function over bytes, no fs).
- Hashing path: `crypto.subtle.digest('SHA-1')` only (no `sha.js` fallback per [isogit-migration.md:295](isogit-migration.md#L295)).

**Tests**

- Golden fixtures: read every loose object from `single-file/` and `nested-dirs/`, assert decoded `(type, content)`.
- Round-trip: `writeLooseObject` of known content produces the oid real-git produced for the same fixture.
- `ObjectCorruptError` on truncated bytes; `ObjectNotFoundError` on missing path.
- Symlink content hashing: link target string is the blob ([isogit-migration.md:43](isogit-migration.md#L43)).

**Exit:** `hashBlob` and `readBlob` (object-level) usable from tests; commits/trees still unimplemented.

---

## Phase 3 — Refs

**Why:** trivial format, unblocks `init` and `resolveRef`. Lock infrastructure is _not_ needed yet — refs are written only by `init` and `applyChanges`, both serialized by `swapSemaphore` + (later) `index.lock`.

**Deliverables**

- Read `.git/HEAD` (symbolic ref form: `ref: refs/heads/main\n`).
- Read `.git/refs/heads/main` (40-hex + LF).
- `resolveRef(ref)` — symbolic deref one level (HEAD → branch → oid). Single hop only; lite has no other ref types.
- Write paths for both files (atomic via temp + rename).
- `RefNotFoundError` on missing ref name.

**Tests**

- Read `HEAD` and `refs/heads/main` from `empty/` and `single-file/` fixtures, assert correct oid.
- Write + read round-trip.
- `resolveRef('refs/heads/feature')` → `RefNotFoundError`.

**Exit:** `resolveRef` fully implemented; phase 5 can write refs.

---

## Phase 4 — Cross-process lock

**Why:** isolated, well-specified ([isogit-migration.md:133-155](isogit-migration.md#L133-L155)), needed before any write operation. Building it now means phases 5 and 9 use it without ceremony.

**Deliverables**

- `withIndexLock<A>(effect: Effect<A>): Effect<A, RepoLockedError>` — acquire via `open({flag:'wx'})`, hold during `effect`, release via `rename` on success / `remove` on failure.
- Age-based stale-lock auto-clear ([isogit-migration.md:145](isogit-migration.md#L145)) keyed on `Clock` + `FileSystem.stat`.
- `SF_SOURCE_TRACKING_LOCK_TIMEOUT_SECONDS` and `SF_SOURCE_TRACKING_LOCK_AUTOCLEAR_SECONDS` env reads.
- Exponential backoff with jitter, ~1s cap.
- Metrics: `repo.lock.wait_ms`, `repo.lock.contention_count`.

**Tests**

- Two concurrent `withIndexLock` calls (in-process) serialize.
- Pre-existing `index.lock` younger than threshold + within timeout → backoff then succeed.
- Pre-existing `index.lock` older than threshold → auto-clear + log + acquire.
- Pre-existing `index.lock` younger than threshold + past timeout → `RepoLockedError` with `ageMs`/`ageHumanReadable`.
- Failure path inside `effect` → `index.lock` removed, no leftover.

**Exit:** lock primitive ready for `init` (in case it ever writes the index — it doesn't today) and `applyChanges`.

---

## Phase 5 — `init`

**Why:** first user-visible API. Uses phases 2–4. Validates the empty-tree pattern.

**Deliverables**

- Full `init` writes per [isogit-migration.md:331-339](isogit-migration.md#L331-L339): `HEAD`, empty-tree object, initial commit object, `refs/heads/main`, empty `info/exclude`, minimal `config`.
- Idempotency rules ([isogit-migration.md:343-348](isogit-migration.md#L343-L348)): valid → no-op; missing → write; partial → `IndexCorruptError`.
- `setInfoExclude(content)` — write verbatim, rebuild matcher (matcher itself lands in phase 8; for now just write the file).
- `core.untrackedCache = true` written iff `Capabilities.supportsUntr`.

**Tests**

- Fresh `init` produces byte-identical `HEAD`, `refs/heads/main`, `objects/4b/825d...` to the `empty/` fixture (modulo timestamp — test injects `TestClock` per [isogit-migration.md:246](isogit-migration.md#L246)).
- `init` over an existing valid shadow: no-op, no file mtime change.
- `init` over `{HEAD present, refs/heads/main missing}`: `IndexCorruptError`.
- After `init`: `resolveRef('HEAD')` and `resolveRef('refs/heads/main')` succeed.

**Exit:** consumers can construct a working empty shadow.

---

## Phase 6 — Index v2 reader

**Why:** statusMatrix needs it; tree reader can land in parallel. Reader before writer keeps the diff small.

**Deliverables**

- Parse `.git/index` v2: header, entries, trailing SHA, known extensions (TREE — read but don't trust yet; UNTR — skip in phase 6, parsed in phase 11).
- `Effect.Cache` keyed on `(gitdir, indexMtime)` ([isogit-migration.md:166](isogit-migration.md#L166)).
- Reject v3/v4 with `IndexCorruptError`.

**Tests**

- Parse index from `single-file/` and `nested-dirs/` fixtures; assert entry count, paths, oids, modes, stat fields.
- Cache hit on second read with unchanged mtime.
- Cache miss on mtime advance.
- v3 fixture (synthesized, header-only) → `IndexCorruptError`.

**Exit:** index entries available as a `Stream<IndexEntry>` to phase 8.

---

## Phase 7 — Tree reader + `streamHeadTree`

**Why:** unblocks move-detection callers and feeds phase 9's tree writer with read symmetry.

**Deliverables**

- `readTree(oid) → Stream<{ path, oid, mode }>` — recursive walk of tree objects, posix paths, depth-first.
- `streamHeadTree()` — `resolveRef('HEAD')` → tree oid → `readTree`.
- `readBlob(oid)` public API: phase 2 primitive + cache.

**Tests**

- `streamHeadTree` against `nested-dirs/`: emits expected `(path, oid)` pairs in stable order.
- `readBlob` returns content matching `git cat-file blob <oid>` output (precaptured in fixture).
- Submodule entry (mode 160000) emitted, not recursed ([isogit-migration.md:31](isogit-migration.md#L31)).

**Exit:** move-detection's read needs are met; phase 9 has read symmetry to test against.

---

## Phase 8 — Cold `statusMatrix` (no UNTR)

**Why:** the perf-critical hot path. Land it without UNTR first; warm path is phase 11.

**Deliverables**

- `FileSystem.readDirectory(path, { recursive: true })` cold walker, scoped to `roots` ([isogit-migration.md:127](isogit-migration.md#L127)).
- Three-way merge: index entries (phase 6) + workdir bytes/stat + HEAD-tree (phase 7) → `StatusEntry`.
- StatusEntry collapse per the table from phase 0.
- `ignore`-library matcher fed by `.git/info/exclude` ([isogit-migration.md:172](isogit-migration.md#L172)).
- Stat-trust: skip rehashing files whose stat matches the index entry ([isogit-migration.md:167](isogit-migration.md#L167)).
- Partial-failure model: `EACCES`/`EMFILE`/`ENFILE` retry with `Schedule.exponential`; persistent failures → warning chunk, not failure ([isogit-migration.md:99](isogit-migration.md#L99)). `ENOENT` mid-walk: silent drop.
- Global fd semaphore wired in.
- Metrics: `repo.status.entries_count`.

**Tests**

- Against `with-untracked/`: emits exact set of `StatusEntry` real-git's `git status --porcelain=v2` reports.
- `with-info-exclude/`: ignored files surface as `"ignored"`, not `"untracked"`/`"added"`.
- Permission-denied dir surfaces as warning, walk completes for siblings.
- Stat-trust: file with matching stat but different content is reported `"unmodified"` (matches real-git behavior for trusted stat).
- Cold-scan perf bench against `~/eng/repros/perf-tracking-bug`: target ≤ 50% baseline ([isogit-migration.md:371](isogit-migration.md#L371)).

**Exit:** statusMatrix passes oracle vs iso-git on all fixtures.

---

## Phase 9 — Index v2 writer + tree writer + `applyChanges`

**Why:** completes the write surface. Lands as one phase because they're mutually testable: writing an index without a tree to validate against, or vice versa, leaves the byte assertion half-blind.

**Deliverables**

- Tree writer: emit tree objects bottom-up from a path/oid map; canonical entry ordering (real-git: byte-wise sort with directory suffix `/`).
- Index v2 writer: header, entries (in path order), SHA-1 trailer. UNTR extension skipped here; appended in phase 11.
- `applyChanges({ adds, removes, message, author })`:
  - Read current index + HEAD tree.
  - For each `add`: hash workdir bytes (phase 2), write loose blob, update index entry.
  - For each `remove`: drop from index.
  - Empty-streams short-circuit ([isogit-migration.md:328](isogit-migration.md#L328)): return current HEAD oid, no commit.
  - Write new tree(s), commit object, update `refs/heads/main`.
  - Whole sequence under `withIndexLock` (phase 4).
- Dedup adds/removes via `HashSet<RepoPath>` ([isogit-migration.md:353](isogit-migration.md#L353)).

**Tests**

- Against `single-file/` and `nested-dirs/` fixtures: `init` empty repo, replay the same adds, assert byte-identical `.git/objects/`, `.git/index`, `.git/refs/heads/main`.
- Round-trip: `applyChanges` then `streamHeadTree` reflects the writes.
- Empty streams → no new commit, HEAD unchanged.
- `applyChanges` of 50k synthetic files within budget ([isogit-migration.md:374](isogit-migration.md#L374)).
- Concurrent `applyChanges` (two test processes against same gitdir) serialize via lock; both succeed.

**Exit:** every public API except UNTR-aware warm scan is implemented and tested in isolation.

---

## Phase 10 — Migration oracle tests

**Why:** the spec demands round-trip compatibility ([isogit-migration.md:202](isogit-migration.md#L202)). Easier to land as its own phase than retrofit later.

**Deliverables**

- `test/git/migration.oracle.test.ts`: iso-git init → lite read → lite applyChanges → iso-git read → iso-git applyChanges → lite read. Assert each read matches a single-impl baseline.
- Oracle covers: status, applyChanges, hashBlob, readBlob, resolveRef, streamHeadTree.
- Marked Node-only; deleted in phase 14.

**Tests**

- N/A — this phase _is_ the tests.

**Exit:** oracle green on `single-file/`, `nested-dirs/`, `with-untracked/` scenarios.

---

## Phase 11 — UNTR write/read/probe + warm `statusMatrix`

**Why:** the headline win, but isolable from cold-scan correctness. Lands last among lite-internal work because it's the most format-spec-sensitive piece and benefits from everything else being stable.

**Deliverables**

- UNTR extension writer per phase 0 spike: `cache_time`, full `stat_data` block, `exclude_per_dir` SHA = SHA-1 of `.git/info/exclude` for every dir entry ([isogit-migration.md:161](isogit-migration.md#L161)).
- UNTR reader: parse on index load when `Capabilities.supportsUntr` and `core.untrackedCache=true`.
- One-time probe per gitdir on first `switchTo` ([isogit-migration.md:165](isogit-migration.md#L165)). On failure: persist `untr.disabled=true`, log, increment `repo.untr.disabled` counter with `reason` tag.
- Warm-scan walker keyed on UNTR invariants: per-dir stat compare, recurse only on mismatch.
- Capabilities-`false` Layer: skip both probe and extension write.

**Tests**

- Read UNTR from `with-untr/` fixture, assert parsed structure matches real-git's `test-tool dump-untracked-cache` output (capture once into fixture).
- Write UNTR after `applyChanges`, then `git fsck` (run manually on dev machine, capture expected output as fixture; not run in CI per [isogit-migration.md:221](isogit-migration.md#L221)).
- Iso-git oracle: lite writes UNTR, iso-git reads index ignoring it, no corruption ([isogit-migration.md:180](isogit-migration.md#L180)).
- Probe failure scenarios: `unstable_ino`, `coarse_mtime`, `ctime_static` each force `untr.disabled=true`.
- Warm-scan perf bench: target < 500ms on `~/eng/repros/perf-tracking-bug` ([isogit-migration.md:372](isogit-migration.md#L372)).
- `Capabilities.supportsUntr=false` Layer: cold scan still correct, no UNTR bytes written.

**Exit:** all 9 public APIs feature-complete; perf targets met.

---

## Phase 12 — Source-tracking integration

**Why:** wire lite into `localShadowRepo.ts` behind the flag, default off.

**Deliverables**

- `SF_SOURCE_TRACKING_USE_LITE_GIT` flag in `localShadowRepo.ts`, read once per process at constructor ([isogit-migration.md:199](isogit-migration.md#L199)).
- ShadowRepo class becomes thin wrapper around `Repo` ([isogit-migration.md:237](isogit-migration.md#L237)).
- `MAX_FILE_ADD` batching + `SF_SOURCE_TRACKING_BATCH_SIZE` removed.
- `moveDetection.ts` switched to `streamHeadTree` (one pass) instead of N `readBlob` calls ([isogit-migration.md:239](isogit-migration.md#L239)).
- `fileFilter()` rules ([isogit-migration.md:300-310](isogit-migration.md#L300-L310)) written into `.git/info/exclude` on init via `setInfoExclude`.
- `redirectToCliRepoError` rewritten with `catchTags` over the closed error set ([isogit-migration.md:318](isogit-migration.md#L318)). Message keys land in `messages/sourceTracking.md`.
- `ignore` added as a direct dep (currently transitive via SDR — [isogit-migration.md:173](isogit-migration.md#L173)).

**Tests**

- Existing source-tracking unit tests pass with flag off (zero behavior change).
- Existing source-tracking unit tests pass with flag on.
- `localTrackingScale.nut.ts` passes both ways.
- `localTrackingFileMovesScale.nut.ts` passes both ways.

**Exit:** lite reachable in production code paths via flag.

---

## Phase 13 — Internal dogfood

**Why:** the spec mandates one release cycle of internal validation before flipping the default ([isogit-migration.md:206](isogit-migration.md#L206)).

**Deliverables**

- Optional startup integrity check active when `SF_SOURCE_TRACKING_INTEGRITY_CHECK` is set.
- Flag flipped on internally (CI env, dev machines); production stays off.
- Telemetry dashboards for `repo.lock.*`, `repo.status.entries_count`, `repo.untr.disabled` reviewed weekly.
- Acceptance gate ([isogit-migration.md:367-377](isogit-migration.md#L367-L377)) re-run against the dogfood build.

**Tests**

- Real workloads. Track `eventLoopDelayCapture` regression canary ([isogit-migration.md:189](isogit-migration.md#L189)).

**Exit:** acceptance gate green on production-shaped workloads; no telemetry red flags for one full release.

---

## Phase 14 — Remove iso-git

**Deliverables**

- Default flag → true; one release later, flag removed entirely.
- `isomorphic-git`, `graceful-fs`, `@types/graceful-fs` removed from `package.json` ([isogit-migration.md:230](isogit-migration.md#L230)).
- `graceful-fs` imports removed from `test/nuts/local/*.nut.ts` ([isogit-migration.md:320](isogit-migration.md#L320)).
- `test/git/migration.oracle.test.ts` deleted.
- `engines.node` bump to `>=22.0.0` if not already ([isogit-migration.md:228](isogit-migration.md#L228)).
- `eventLoopDelayCapture` retained as canary ([isogit-migration.md:213](isogit-migration.md#L213)).

**Tests**

- Full source-tracking suite; nuts; perf bench against `~/eng/repros/perf-tracking-bug`.

**Exit:** iso-git gone; lite is the only path.

---

## Sequencing summary

```
0 fixtures+baseline ──┐
                      ├─► 1 scaffolding ──► 2 loose objects ──┬─► 3 refs ──► 5 init ─┐
                      │                                       │                      │
                      │                                       └─► 4 lock ────────────┤
                      │                                                              │
                      └─► (UNTR spike feeds 11)                                       │
                                                                                     │
                          6 index reader ──┬─► 7 tree reader ──► 8 cold status ──────┤
                                           │                                          │
                                           └─► 9 writer + applyChanges ───────────────┤
                                                                                     │
                                                              10 oracle tests ───────┤
                                                                                     │
                                                              11 UNTR + warm ────────┤
                                                                                     │
                                                              12 integration ────────┤
                                                                                     │
                                                              13 dogfood ────────────┤
                                                                                     │
                                                              14 remove iso-git ─────┘
```

Phases 4 and 6/7 can land in parallel with 2/3 once scaffolding is in. Everything else is serial.

---

## Risk register

| Risk                                    | Earliest detection | Mitigation                                                                                                          |
| --------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------- |
| UNTR format misread                     | Phase 0 spike      | Spike is timeboxed and produces a fixture; if format is intractable, descope warm scan from v1 and ship cold-only.  |
| memfs `open({flag:'wx'})` non-atomicity | Phase 4 tests      | Documented gap ([isogit-migration.md:155](isogit-migration.md#L155)); in-process re-entrancy guard suffices for v1. |
| Cold scan perf target missed            | Phase 8 bench      | Profile fd budget, walker concurrency model; UNTR (phase 11) is the fallback path to hitting headline numbers.      |
| Iso-git oracle divergence on edge cases | Phase 10           | Each divergence triages to: lite bug, iso-git bug-we-shouldn't-replicate, or spec ambiguity. Document the call.     |
| `engines.node` bump blocks consumers    | Phase 14           | Bump can ride a major version of source-tracking; coordinate with Heroku/CLI release calendar.                      |

---

## What this plan does _not_ commit to

- Calendar dates. Phases are sized roughly 1–2 PRs each; the team owns scheduling.
- PR-to-phase mapping. Some phases (e.g. 1) might split into two PRs; some (e.g. 3+4) might combine.
- Web-bundle test mode. `vitest --browser` exploration is deferred per [isogit-migration.md:264](isogit-migration.md#L264); not required for any phase.
