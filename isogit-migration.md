# `source-tracking/src/git/` — replacement for isomorphic-git

A focused, Effect-native git module that lives **inside** `@salesforce/source-tracking` and replaces the 8 isomorphic-git APIs the project currently uses. Internally codenamed _iglite_ during the grilling session; the published name is just `src/git/` — it's a module, not a package.

Credit: derived from concepts in [isomorphic-git](https://github.com/isomorphic-git/isomorphic-git) (William Hilton, MIT). A `NOTICE.md` lives in `src/git/` crediting the project.

---

## Why

`isomorphic-git`'s `statusMatrix` hogs the event loop on large SFDX projects (deeply-nested CustomObjects + fields, ~37k files in [`~/eng/repros/perf-tracking-bug`](file:///Users/shane.mclaughlin/eng/repros/perf-tracking-bug)). source-tracking only uses 8 of iso-git's ~70 APIs and works around several quirks (batched `add` for EMFILE, sequential `remove` with shared cache, `redirectToCliRepoError` for opaque error tags). A purpose-built module trims surface area, exposes Streams for progress UI, and lets us implement git's UNTR index extension to skip unchanged subtrees on warm scans.

## Scope

### In scope (the 8 APIs source-tracking uses)

- `init` — create shadow `.git/`
- `statusMatrix` — workdir vs HEAD vs index status
- `add` + `remove` + `commit` — collapsed into one `applyChanges` call
- `hashBlob` — hash workdir bytes (move detection)
- `readBlob` — read object by oid (move detection)
- `resolveRef` — HEAD → oid

### Out of scope (definitively)

- All network ops (clone/fetch/push/pull, HTTP, smart protocol, packfiles)
- Refs beyond `HEAD` + `refs/heads/main` (no branches/tags/notes/remotes)
- merge/rebase/cherry-pick/stash/revert
- GPG signing, reflog, hooks
- `.gitattributes`, `core.autocrlf`, sparse-checkout, worktrees
- Submodule recursion (we report mode 160000, don't recurse)
- Index v3/v4 (read+write v2 only)
- Working-tree `.gitignore` evaluation (source-tracking doesn't honor it; only `.git/info/exclude` of the shadow gates ignore decisions)
- iso-git API back-compat — Effect-native only

### On the boundary

| Item                    | Decision                                                                                   |
| ----------------------- | ------------------------------------------------------------------------------------------ |
| Move detection          | source-tracking owns matching policy. Lite exposes `streamHeadTree` as a primitive.        |
| `.git/info/exclude`     | Lite owns the bytes; source-tracking owns the rules via `setInfoExclude(content)`.         |
| Symlink content hashing | In (link target string is the blob, ~5 LOC).                                               |
| Empty initial commit    | Use real-git's well-known empty tree `4b825dc642cb6eb9a060e54bf8d69288fbee4904` if needed. |

---

## Architecture

### Public surface

```ts
class Repo extends Effect.Service<Repo>()("Repo", { ... }) {
  init(cfg: SwitchCfg): Effect<void, IndexCorruptError | WorkdirIoError>
  switchTo(cfg: SwitchCfg): Effect<void, IndexCorruptError | WorkdirIoError>
  statusMatrix(): Stream<StatusEntry, RepoError>
  collectStatus(): Effect<readonly StatusEntry[], RepoError>
  applyChanges(args: {
    adds: Stream<RepoPath>,
    removes: Stream<RepoPath>,
    message: string,
    author: Author   // committer == author; timestamp added by lite via Clock
  }): Effect<CommitOid, RepoError>
  hashBlob(bytes: Uint8Array): Effect<Oid>
  readBlob(oid: Oid): Effect<Uint8Array, ObjectNotFoundError | ObjectCorruptError>
  resolveRef(ref: RefName): Effect<Oid, RefNotFoundError>
  streamHeadTree(): Stream<{ path: RepoPath; oid: Oid }, RepoError>
  setInfoExclude(content: string): Effect<void, WorkdirIoError>
}

type SwitchCfg = {
  readonly dir: string                    // workdir root (project root)
  readonly gitdir: string                 // .sf/orgs/{orgId}/localSourceTracking/.git
  readonly roots: readonly RepoPath[]     // package dirs, posix, relative to dir
  readonly fdPermits: number              // single global semaphore size; caller-provided, no auto-detect
}
```

`statusMatrix`/`collectStatus` walk only inside `roots`; they take no per-call args. Roots and fd budget are properties of the handle, set once via `switchTo` (and changed only by another `switchTo`). The library has no other entrypoints — every operation is a method on the swapped handle.

### Schemas (branded via `Schema.brand`)

- `Oid` — 40-hex sha1
- `RepoPath` — posix-normalized via `Schema.transform`; relative to `cfg.dir`; rejects `..` segments
- `RefName` — e.g. `"refs/heads/main"`
- `StatusEntry` — `Struct({ path: RepoPath, status: "unmodified" | "modified" | "added" | "deleted" | "ignored" })`. Single discriminated union at the public boundary; the index walker still works in terms of git's numeric `0|1|2|3` cells internally for v2-index format compatibility, but those are collapsed before emission. The shadow has no partial-stage workflow, so the stage axis is dropped from the public schema.
- `Author` — `Struct({ name: string, email: string })`; lite stamps timestamp via `Clock.currentTimeMillis` truncated to seconds, tz `+0000`. `committer == author` for shadow commits.

### Tagged errors (`Schema.TaggedError` per the effect-best-practices skill)

- `RepoNotConfiguredError` — operations called before any `switchTo`
- `IndexCorruptError` — partial/torn `.git/` state, malformed index v2, or `init` over a partial shadow
- `ObjectNotFoundError` — `readBlob`/`resolveRef` against a missing oid
- `ObjectCorruptError` — loose object fails zlib/header/sha verification
- `WorkdirIoError { path, cause: PlatformError }` — wraps any `@effect/platform` `PlatformError` lite catches at its boundary. Emitted as **warnings** (entries+warnings model) for `statusMatrix`, as failures elsewhere
- `RepoLockedError { lockPath, ageMs, ageHumanReadable }` — lock-acquire timeout exceeded
- `InvalidPathError { path, reason }` — caller-side programmer error (path outside roots, contains `..`, non-posix, etc.)
- `RefNotFoundError { ref }` — never emitted post-`init` for `HEAD`/`refs/heads/main` (init creates the empty-tree commit so HEAD always resolves); reserved for callers that pass other ref names

Partial-failure model on `statusMatrix`: walks complete, problematic paths bubble up via a `warnings` chunk alongside entries. EACCES/EMFILE/ENFILE retry with `Schedule.exponential` before becoming a warning. ENOENT mid-walk: silent drop.

### Service lifecycle

`Repo` is one swappable handle (not multi-org). `switchTo({dir, gitdir, roots, fdPermits})` is the imperative API: it closes the previous handle's scope (caches finalized, fds released) and installs a fresh one atomically.

**Direction of org-change notification:** the org-context `SubscriptionRef` lives upstream — in vscode-3's services extension and in source-tracking itself. _Those_ publish "org changed"; source-tracking is the subscriber and reacts by calling `Repo.switchTo`. Lite never publishes its own change signal; it's a recipient of the imperative call. Plain `Ref` is sufficient — no `SubscriptionRef`, no `.changes` stream.

**Handle lifecycle (implementation contract).**

- The service is constructed via `Effect.Service` at Layer scope (`serviceScope`). Internally it holds:
  - `handleRef: Ref<Option<RepoHandle>>` — the current handle (config + caches + matchers)
  - `swapSemaphore: Semaphore` with one permit — serializes `switchTo`
  - `currentHandleScope: Ref<Option<Scope>>` — the per-handle child scope
- Each `RepoHandle` is acquired into a child scope forked from `serviceScope` via `Scope.fork`. Caches, fd budgets, ignore matchers, and any other handle-owned resources register their finalizers into this child scope.
- `switchTo(cfg)` sequence (under `swapSemaphore`):
  1. Build the new handle in a fresh forked child scope (no observable state yet).
  2. Atomically: write the new handle to `handleRef`, write the new scope to `currentHandleScope` (capture the prior values).
  3. Close the prior child scope (releases fds, finalizes caches).
- Operations capture the handle once at entry (`Ref.get` then proceed against the snapshot). Mid-flight swaps don't redirect in-progress ops — they finish against the prior handle, which is held alive by the in-progress `Effect` referencing it. Once all in-flight ops drop the reference, the prior scope is fully released.
- Operations called when `handleRef` is `None` (before any `switchTo`) fail with `RepoNotConfiguredError`. Step 2 is atomic, so no caller observes `None` mid-swap.

### File system

- Public surface accepts `Layer<FileSystem>` from `@effect/platform`. **Lite imports nothing from `node:*` directly** — no `node:fs`, no `node:path`, no `node:crypto`, no `node:os`, no `child_process`. All filesystem and platform interaction goes through `@effect/platform`'s `FileSystem` and `Path` services. This is mandatory for the web bundle: vscode-3 polyfills `node:fs` with memfs at bundle time, so any direct `node:*` import in lite would either fail to bundle or silently land on a polyfill that doesn't behave like Node.
- Node consumers pass a Layer wrapping `NodeFileSystem.layer`; test (and any future browser) consumers pass a memfs-backed Layer.
- A semaphore-wrapping Layer enforces a single global fd budget — caller-provided concurrency number, no auto-detect.
- EMFILE strategy: bounded concurrency primary, `Effect.retry(Schedule.exponential)` on `EMFILE`/`ENFILE`/`EACCES` as backstop. Replaces `graceful-fs` in source-tracking.
- `FileSystem.readDirectory(path, { recursive: true })` is the cold-scan primitive (verified in `@effect/platform`'s `FileSystem.d.ts`: `ReadDirectoryOptions.recursive`). Both Node's `fs.readdir` and memfs support recursive mode, so the same call works in both bundles. Warm-scan UNTR walks are still userland (per-dir stat checks).

### Concurrency

Single global semaphore at the FileSystem layer boundary. **Caller-provided permit count — lite never auto-detects.** Source-tracking computes a default at its call site (e.g. `min(16, os.availableParallelism() * 2)` in the Node entrypoint, a fixed value in any future web entrypoint) and passes the number into `switchTo`. Lite uses `Stream.mapEffect({concurrency: "unbounded"})` internally and lets the semaphore gate.

### Cross-process locking

Lock strategy matches real-git: `.git/index.lock` is **both** the lock indicator and the atomic-write target for the new index. No pid sidecar, no `process.kill` liveness check. Lite never references the global `process` object.

- Acquire: `FileSystem.open('.git/index.lock', { flag: 'wx' })` — exclusive create, fails if the file exists. No direct `node:fs` use.
- During: lite assembles the new index bytes (in memory or streamed) and writes them into the open `.git/index.lock` handle.
- Release-success: `FileSystem.rename('.git/index.lock', '.git/index')` — atomic on POSIX, on Windows ≥ Vista, and on memfs.
- Release-failure: `FileSystem.remove('.git/index.lock')`.
- Lock released per-operation, not per-deploy. Two CLIs interleave naturally.
- VSCode blocks during CLI writes (10–30s worst case for `applyChanges` on 50k files); accepted (matches real git).
- 10-min hard timeout, env override `SF_SOURCE_TRACKING_LOCK_TIMEOUT_SECONDS`. Exponential backoff with jitter, up to ~1s between attempts.

**Age-based stale-lock auto-clear.** On every `EEXIST` retry, lite checks the lockfile's mtime via `FileSystem.stat`. If `Clock.currentTimeMillis - mtimeMs > SF_SOURCE_TRACKING_LOCK_AUTOCLEAR_SECONDS` (default 300s = 5 min), lite removes the stale lock with a warn-level log and retries the `wx` create. Threshold sits between realistic operation duration (max ~30s) and the hard timeout (600s).

After timeout: `RepoLockedError { lockPath, ageMs, ageHumanReadable }` with a message instructing the user to delete the file manually.

**Crash recovery.**

- Orphan loose objects from a crashed `applyChanges`: harmless (unreachable from any ref, content-addressed). Next operation rewrites identical content → same oid → same path; idempotent. No cleanup pass needed.
- Crashed mid-index-write: `.git/index.lock` exists; `.git/index` retains its prior valid bytes. Auto-cleared after threshold or removed manually.
- Crashed mid-`refs/heads/main` write: ref is small enough that torn writes are vanishingly rare on modern filesystems. Real-git accepts this risk; lite does too.

**Web-bundle gap (acknowledged, structurally fine for v1):** in the vscode-3 web bundle `node:fs` is polyfilled with memfs, which is in-memory and per-instance. `open({flag:'wx'})` against memfs is atomic _within_ a VSCode extension host but invisible to any other host — there is no cross-process or cross-tab locking on the web today. This is acceptable because the web has only one writer by construction: the CLI does not run in the web bundle, and the VSCode extension host is single-instance per workspace. The lock continues to serve as an in-process re-entrancy guard. If a future web consumer adds a multi-writer scenario plus persistent shared storage (IndexedDB, OPFS), that consumer owns providing a `FileSystem` Layer whose `open({flag:'wx'})` is atomic across writers; lite's logic is unchanged.

### Performance

The headline win: implement git's **UNTR index extension** so warm scans skip unchanged subtrees entirely. Cold scan uses `fs.readdir({recursive: true})` (libuv-internal recursion); warm scan uses a userland walker keyed on UNTR's per-dir mtime invariants.

UNTR is **bytes-compatible with real-git ≥ 2.32** (`Documentation/technical/index-format.txt` §"Untracked cache"). Stat invariants we record per directory: full `cache_time` + `stat_data` block (`ctime_sec`, `ctime_nsec`, `mtime_sec`, `mtime_nsec`, `dev`, `ino`, `uid`, `gid`, `size`, `mode`). `exclude_per_dir` SHA is the SHA-1 of `.git/info/exclude` for every directory entry (lite reads no per-directory `.gitignore` files). UNTR entries are written for paths inside `roots` only — real-git's spec permits a partial cache; missing dirs are treated as "needs scan".

UNTR is gated on a `Capabilities.supportsUntr: boolean` flag exposed by the injected `FileSystem` Layer. **Lite does no platform detection** — no `process.platform`, no `typeof window`, no Node/browser branches. Layer authors set the flag based on what their backing fs supports; the recommended Node Layer sets `true`, the recommended memfs Layer sets `false`. When `false`, lite skips both the probe and the extension write entirely.

When `supportsUntr` is `true`, lite runs a one-time probe on first `switchTo` per gitdir to confirm the live fs honors the stat invariants UNTR depends on: `mkdir tmpdir → stat → touch child → stat` and verify `mtime_nsec`, `ctime`, and `ino` advance as expected. On failure, persist `untr.disabled = true` in `.git/config`, log at trace, increment `repo.untr.disabled` counter (with `reason` tag: `"unstable_ino"`, `"coarse_mtime"`, `"ctime_static"`), skip writing UNTR forever on this fs. Cold scan continues to work; warm-scan optimization is forfeited. The probe operates entirely through the `FileSystem` service — no `node:fs` imports.

Index parsed once per process, cached via `Effect.Cache` keyed on `(gitdir, indexMtime)`. Stat fields trusted per the index entry (already iso-git's approach but with a hot cache); skip rehashing unchanged files.

### Ignore semantics

Lite reads `.git/info/exclude` of the shadow only. Customer's working-tree `.gitignore` is invisible.

Pattern matching uses the [`ignore`](https://www.npmjs.com/package/ignore) library (kaelzhang/node-ignore) — pure JS, dep-free, browser-safe, full gitignore spec, MIT. It's the same library SDR uses for `.forceignore` ([`@salesforce/source-deploy-retrieve/.../forceIgnore.js`](https://github.com/forcedotcom/source-deploy-retrieve/blob/main/src/resolve/forceIgnore.ts) — `require('ignore/index')`), so source-tracking + SDR + lite all share one matcher. Adds `ignore` as a direct dep of source-tracking (currently transitive via SDR; lite must not rely on the transitive).

`setInfoExclude(content)` writes `content` verbatim to `.git/info/exclude` and rebuilds the matcher. No syntax validation — `ignore` handles the full spec, including features source-tracking doesn't currently use (negations, anchored patterns, etc.). Future source-tracking rules can use any gitignore feature without lite changes.

### Format compatibility (mandatory)

- Loose objects: zlib-deflated `<type> <size>\0<content>` — git standard.
- Index: v2 only. UNTR is an optional extension; iso-git ignores unknown extensions per spec, so toggling the feature flag back to iso-git is corruption-free. Self-healing in either direction.
- Refs: plain text oid in `.git/HEAD`, `.git/refs/heads/main`.
- No custom extensions beyond UNTR.
- Migration safety: optional startup integrity check (configurable env var) during the dogfood period.

### Telemetry

- All public `Repo.*` methods are `Effect.fn('Repo.foo')` — auto-instrumented spans via source-tracking's existing `@effect/opentelemetry` layer.
- Three metrics: `repo.lock.wait_ms` (histogram), `repo.lock.contention_count` (counter), `repo.status.entries_count` (histogram).
- `eventLoopDelayCapture` in source-tracking is kept as a regression canary (should report ~0 with lite).
- Trace-level events (`lock acquired`, `cache hit/miss`) via `Effect.log`.

---

## Migration

### One PR introduces lite

- New `src/git/` directory, fully wired up.
- `SF_SOURCE_TRACKING_USE_LITE_GIT` flag in `localShadowRepo.ts`, default **false**. Read **once per process** at the `ShadowRepo` constructor — no mid-process flipping. CLI invocations are short-lived (each command is a fresh process); VSCode reads the flag on activation and a reload-window is required to flip.
- Both code paths live; iso-git stays a dep.
- Acceptance gate: `localTrackingScale.nut.ts` + `localTrackingFileMovesScale.nut.ts` + perf-tracking-bug repro pass against lite.
- Migration oracle test (`test/git/migration.oracle.test.ts`) covers round-trip: iso-git init → lite read → lite applyChanges → iso-git read → iso-git applyChanges → lite read. Each read matches a single-impl baseline. Node-only (iso-git itself is Node-shaped). Deleted with iso-git.

### Internal dogfood (one release cycle)

Flag flipped on internally; production stays on iso-git. Optional startup integrity check active.

### Follow-up PR removes iso-git

- Default flag flipped to true, then removed entirely.
- `isomorphic-git` and `graceful-fs` come out of `package.json`.
- Migration oracle tests (lite vs iso-git side-by-side) deleted.
- `eventLoopDelayCapture` stays as the canary.

---

## Testing

- **Location:** `test/git/` (separate from existing `test/` to keep the test-runner split clean). New wireit nodes alongside mocha ones.
- **Runner:** vitest. Initial: Node-only. Future: explore `vitest --browser` mode for parity coverage; not a v1 blocker.
- **Strategy:** iso-git side-by-side oracle for migration safety (lite output read back by iso-git, and vice versa, must agree). Oracle tests deleted after one stable release. Real-git is **not** a test dependency — we cannot assume `git` is on `PATH` in CI, in contributors' environments, or in any consumer's runtime. Bytes-level fidelity is asserted by golden-fixture tests: small, hand-crafted `.git/` directories captured once (e.g. via real-git on a developer machine) checked into the repo as fixtures, and lite must produce byte-identical output for the same logical state. No `git` shell-out at test time or runtime.
- **Perf benchmarks:** `vitest bench` on hot paths (statusMatrix cold/warm, applyChanges 50k files, streamHeadTree). Must run against `~/eng/repros/perf-tracking-bug` (37k files, deeply-nested CustomObjects) as the canonical scale fixture.

---

## Engines & deps

- `engines.node`: bump from `>=18.0.0` to `>=22.0.0`. Justified by the Node entrypoint of source-tracking; `crypto.subtle` is also web-available, so lite's hashing path works in both bundles. Lite itself does not import any Node-22-specific API directly — Node-version-specific calls live in the Layer that wraps `NodeFileSystem`, not in lite.
- New devDeps: `vitest`, `@vitest/coverage-v8`.
- After migration: drop `isomorphic-git`, `graceful-fs`, `@types/graceful-fs`.
- Existing `effect`, `@effect/platform`, `@effect/opentelemetry` are reused.

---

## Source-tracking refactors that fall out

- `localShadowRepo.ts` ShadowRepo class becomes a thin wrapper around `Repo` (org context, telemetry spans, `redirectToCliRepoError`, `SHADOW_AUTHOR` constant).
- `MAX_FILE_ADD` batching and `SF_SOURCE_TRACKING_BATCH_SIZE` env var: removed (lite handles concurrency uniformly).
- `moveDetection.ts` keeps all its matching policy (basename pairing, decomposed metadata, image content). Pulls primitives from `Repo` instead of `git.*`. Iterates `streamHeadTree` instead of N `readBlob` calls.
- `fileFilter()` callback in `localShadowRepo.ts:423`: removed. Its rules are written into `.git/info/exclude` on init via `Repo.setInfoExclude`.

---

## Author / commit identity

- `Author = { name: string; email: string }`; timestamp via `Clock.currentTimeMillis` truncated to seconds. Tz always `+0000` (shadow commits are never user-visible; stable bytes for golden fixtures). Tests inject `TestClock` seeded to a non-zero value (e.g. `2026-01-01T00:00:00Z`) so commit oids are reproducible.
- Lite sets commit `committer == author`. The `Author` shape applies to both fields.
- source-tracking exposes `SHADOW_AUTHOR = { name: 'sfdx source tracking', email: 'source-tracking@noreply.salesforce.com' } as const`.

---

## Style

- TypeScript style follows source-tracking's `@salesforce/dev-config/tsconfig-strict` plus the global `~/.claude/CLAUDE.md` conventions (functional, ternaries, `type` not `interface`, no barrels, `undefined` not `null`, no loops, `const` over `function`, posix paths everywhere).
- Effect patterns follow [effect-best-practices skill](file:///Users/shane.mclaughlin/eng/forcedotcom/vscode-3/.claude/skills/effect-best-practices/SKILL.md): `Effect.fn` over `Effect.gen`, `Schema.TaggedError`, branded IDs, no `catchAll`, no `null`/`undefined` in domain types (use `Option`).
- ESLint: source-tracking's existing `@effect/eslint-plugin` + `eslint-plugin-functional` apply to `src/git/` automatically.
- Filenames: camelCase, no hyphens.

---

## Open questions to resolve during implementation

- Exact UNTR extension format details — lift from real git's `read-cache.c` / `dir.c` ([git source](https://github.com/git/git/blob/master/Documentation/technical/index-format.txt) — search "Untracked cache").
- Whether `vitest --browser` mode is feasible against memfs without significant test-app scaffolding.
- The default permit count for the global fs semaphore — start at 16, tune from perf benchmarks.

**Resolved during plan grilling:**

- ~~Whether `Repo.dispose` is needed~~ — **No.** Scope finalizers handle teardown when the consumer (vscode-3 services extension; CLI process; test harness) closes the Layer scope. Consumers must close the scope on shutdown (e.g. VSCode `deactivate()`, CLI top-level `Effect.scoped`). Lite has no way to enforce this; a leaked Layer scope leaks the handle resources. CLI process exit is fine: OS reclaims; lockfile (if any) is cleared by age-based auto-clear on next run.
- ~~Stale-lock pid-liveness check~~ — **Replaced with age-based auto-clear** (see §Cross-process locking). No `process.kill`, no platform branches, works in every Layer.

---

## Reference points (concrete call sites)

### iso-git APIs to replace, with current source-tracking call sites

| iso-git call         | source-tracking site                                                                                                                       | Notes                                                                                                                                                                                                                                                                                |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `git.init()`         | [localShadowRepo.ts:121](file:///Users/shane.mclaughlin/eng/forcedotcom/source-tracking/src/shared/local/localShadowRepo.ts#L121)          | Init shadow repo at `.sf/orgs/{orgId}/localSourceTracking`                                                                                                                                                                                                                           |
| `git.statusMatrix()` | [localShadowRepo.ts:156-163](file:///Users/shane.mclaughlin/eng/forcedotcom/source-tracking/src/shared/local/localShadowRepo.ts#L156-L163) | Args: `filepaths: packageDirs`, `ignored: true`, `filter: fileFilter(...)`. Returns posix; converted to win32 at line 167. Also: source-tracking has its own `noCache` boolean that bypasses an in-memory cache around this call — lite owns the cache now, so this knob disappears. |
| `git.add()`          | [localShadowRepo.ts:335](file:///Users/shane.mclaughlin/eng/forcedotcom/source-tracking/src/shared/local/localShadowRepo.ts#L335)          | Batched by `MAX_FILE_ADD` (8K Win / 15K Unix), env override `SF_SOURCE_TRACKING_BATCH_SIZE`. Removed in lite — `applyChanges` handles concurrency uniformly.                                                                                                                         |
| `git.remove()`       | [localShadowRepo.ts:361](file:///Users/shane.mclaughlin/eng/forcedotcom/source-tracking/src/shared/local/localShadowRepo.ts#L361)          | Sequential with shared `cache: {}` for ~24% gain. Removed in lite.                                                                                                                                                                                                                   |
| `git.commit()`       | [localShadowRepo.ts:300-306](file:///Users/shane.mclaughlin/eng/forcedotcom/source-tracking/src/shared/local/localShadowRepo.ts#L300-L306) | Author hardcoded `'sfdx source tracking'` no email. New: `SHADOW_AUTHOR` constant.                                                                                                                                                                                                   |
| `git.hashBlob()`     | [moveDetection.ts:215](file:///Users/shane.mclaughlin/eng/forcedotcom/source-tracking/src/shared/local/moveDetection.ts#L215)              | Hash workdir bytes for added files.                                                                                                                                                                                                                                                  |
| `git.readBlob()`     | [moveDetection.ts:245](file:///Users/shane.mclaughlin/eng/forcedotcom/source-tracking/src/shared/local/moveDetection.ts#L245)              | Read HEAD-tree blob for deleted files. Replace per-file calls with `streamHeadTree` iteration.                                                                                                                                                                                       |
| `git.resolveRef()`   | [moveDetection.ts:180](file:///Users/shane.mclaughlin/eng/forcedotcom/source-tracking/src/shared/local/moveDetection.ts#L180)              | Resolve HEAD → oid.                                                                                                                                                                                                                                                                  |

### iso-git internals worth understanding before reimplementing

- [walk.js:40](file:///Users/shane.mclaughlin/eng/3pp/isomorphic-git/src/commands/walk.js#L40) — unbounded `Promise.all([...children].map(walk))`. The event-loop hog.
- [GitWalkerFs.js:124+](file:///Users/shane.mclaughlin/eng/3pp/isomorphic-git/src/models/GitWalkerFs.js#L124) — `oid()` reads full file content on stat mismatch, hashes synchronously.
- [GitIndexManager.js](file:///Users/shane.mclaughlin/eng/3pp/isomorphic-git/src/managers/GitIndexManager.js) — full `.git/index` parse upfront via `GitIndex.from(rawIndexFile)`.
- [GitIndex.js:91-93](file:///Users/shane.mclaughlin/eng/3pp/isomorphic-git/src/models/GitIndex.js#L91-L93) — `if (version !== 2) throw InternalError(...)`. Confirms iso-git is v2-only; lite stays v2-only too.
- [shasum.js](file:///Users/shane.mclaughlin/eng/3pp/isomorphic-git/src/utils/shasum.js) — `crypto.subtle.digest('SHA-1')` with `sha.js` fallback. Lite uses native only (Node 22+, browser).
- [statusMatrix.js:210-214](file:///Users/shane.mclaughlin/eng/3pp/isomorphic-git/src/api/statusMatrix.js#L210-L214) — three-way `Promise.all([head.type(), workdir.type(), stage.type()])` per file.
- iso-git has **zero rename detection** (grep found only `renameBranch`). Real git's algorithm: exact-oid match (cheap), then similarity scoring (`-M`, default 50%, capped at `diff.renameLimit=1000`). Lite mirrors source-tracking's current behavior: exact-oid match only, no similarity scoring. Domain logic stays in `moveDetection.ts`.

### `fileFilter` rules that move to `.git/info/exclude`

From [localShadowRepo.ts:423](file:///Users/shane.mclaughlin/eng/forcedotcom/source-tracking/src/shared/local/localShadowRepo.ts#L423):

```gitignore
# Written by source-tracking. Do not edit.
**/.*           # hidden files (dotfiles)
**/node_modules/**
**/__tests__/** # LWC local-only tests (verify excludeLwcLocalOnlyTest's exact pattern)
**/.gitignore   # iso-git excluded these explicitly
.DS_Store       # macOS
```

**Important: `info/exclude` is negative filtering only.** The positive scan-root constraint (currently `filepaths: this.packageDirs`) stays as a separate parameter to `Repo.statusMatrix({ roots: RepoPath[] })`. Lite walks only inside those roots — no scanning the rest of the project tree.

### Other touchpoints

- [eventLoopDelayCapture.ts](file:///Users/shane.mclaughlin/eng/forcedotcom/source-tracking/src/shared/eventLoopDelayCapture.ts) — kept as canary. Should report ~0 with lite.
- [fileOperations.ts:98](file:///Users/shane.mclaughlin/eng/forcedotcom/source-tracking/src/shared/remote/fileOperations.ts#L98) — uses `lockInit` from `@salesforce/core` for `maxRevision.json`. Considered for shadow-repo locking; rejected to keep `src/git/` dependency-free of `@salesforce/core`. Native `.git/index.lock` instead.
- `redirectToCliRepoError` lives in source-tracking, **not** in lite. Lite returns tagged errors only — it never constructs `SfError`. Source-tracking replaces today's `git.Errors.InternalError` / `git.Errors.MultipleGitError` catch with `catchTags({ RepoLockedError, IndexCorruptError, ObjectNotFoundError, ObjectCorruptError, RepoNotConfiguredError, WorkdirIoError, InvalidPathError, RefNotFoundError })`, mapping each to an `SfError` whose message comes from `messages/sourceTracking.md` under keys: `repoLocked`, `indexCorrupt`, `objectNotFound`, `objectCorrupt`, `repoNotConfigured`, `workdirIo`, `invalidPath`, `refNotFound`. Message text lands at PR time.
- Lite catches all `@effect/platform` `PlatformError`s at its public API boundary and re-tags as `WorkdirIoError { path, cause: PlatformError }`. Source-tracking never sees raw `PlatformError` — `catchTags` against the closed set above is exhaustive.
- Tests also import `graceful-fs` (e.g. `test/nuts/local/*.nut.ts`); migration removes those imports too.

---

## Detailed semantics

### `applyChanges` with empty streams

If both `adds` and `removes` are empty: **no commit is created**, returns `Effect.succeed(currentHeadOid)`. Avoids spurious empty commits. Source-tracking's current code path skips commit when there's nothing to stage.

### `init` writes

`init` produces a **fully-resolvable** repo — no unborn-branch state. Concretely it writes:

- `.git/HEAD` → `ref: refs/heads/main\n`
- `.git/objects/4b/825dc642cb6eb9a060e54bf8d69288fbee4904` → the well-known empty-tree object (zlib-deflated `tree 0\0`).
- `.git/objects/<oid[0:2]>/<oid[2:]>` → an initial commit object: tree = empty-tree-oid, no parent, author = committer = `SHADOW_AUTHOR`, timestamp from `Clock` truncated to seconds, tz `+0000`, message `"init\n"`.
- `.git/refs/heads/main` → `<initial-commit-oid>\n`.
- `.git/info/exclude` (initially empty; source-tracking calls `setInfoExclude` immediately after).
- `.git/config` with minimum: `[core] repositoryformatversion = 0`. Plus `core.untrackedCache = true` when the active Layer reports `Capabilities.supportsUntr = true`. No `autocrlf`, no `filemode`.

After `init`, `resolveRef('HEAD')` and `resolveRef('refs/heads/main')` always succeed. `statusMatrix` walks against the empty-tree HEAD → every workdir file appears as `"added"`. `applyChanges` always has a parent commit. No public-API caller needs special-case logic for "freshly-init'd repo."

`init` is **idempotent**:

- Existing valid shadow (HEAD + `refs/heads/main` + objects dir present): no-op (or integrity-check, gated by `SF_SOURCE_TRACKING_INTEGRITY_CHECK` during the dogfood window). Returns success.
- Missing `.git/`: full write per the list above.
- Partially-constructed `.git/` (e.g. HEAD present but `refs/heads/main` missing): fails with `IndexCorruptError`. Lite never overwrites partial state — the user has either an in-flight crash or external mutation, and clobbering risks data loss.
- `.git/info/exclude`: only written if absent. If already present, `init` leaves it alone; mutation goes through `setInfoExclude`.

### `Cache` and `HashSet` usage

- `Effect.Cache` — parsed `GitIndex` keyed on `(gitdir, indexMtime)`. Hot blob bytes keyed on `Oid`. Both bounded by capacity, scope-cleaned on `switchTo`.
- `HashSet<RepoPath>` — "seen during walk" tracking, dedup of adds/removes inside `applyChanges`. `Schema`-derived `Equivalence` and `Hash` instances on branded types make set ops trivial.

### Lock contention with stale process

When `fs.open(lockPath, 'wx')` fails with `EEXIST`:

1. Read lockfile contents (`<pid> <iso8601-timestamp>`).
2. `process.kill(pid, 0)` — if throws `ESRCH` → process is gone. Auto-clear with a `Effect.log('warn')` message + retry the `open(wx)`.
3. If pid is alive, back off and retry until `SF_SOURCE_TRACKING_LOCK_TIMEOUT_SECONDS` (default 600s).
4. On timeout: `RepoLockedError { pid, ageMs, lockPath, ageHumanReadable, message }`.
5. Browser: `process.kill` unavailable; auto-clear is also moot (single tab); just retry-with-backoff.

### Acceptance criteria for flipping the default flag

Run against `~/eng/repros/perf-tracking-bug` (37k files, deeply-nested CustomObjects):

| Metric                                                  | iso-git baseline            | Lite target                    |
| ------------------------------------------------------- | --------------------------- | ------------------------------ |
| Cold `statusMatrix` wall time                           | (capture from current main) | ≤ 50% of baseline              |
| Warm `statusMatrix` wall time (with UNTR)               | (no warm path today)        | < 500ms                        |
| Max event-loop delay during `statusMatrix`              | (capture)                   | < 50ms p99                     |
| `applyChanges` (50k files) wall time                    | (capture)                   | ≤ baseline (parity acceptable) |
| `localTrackingScale.nut.ts`                             | passes                      | passes                         |
| `localTrackingFileMovesScale.nut.ts`                    | passes                      | passes                         |
| Real-git `git fsck` against shadow after `applyChanges` | n/a                         | clean                          |

Capture iso-git baseline numbers in PR-1 before implementation.

### NOTICE.md content (in `src/git/NOTICE.md`)

```text
This module derives concepts and algorithms from isomorphic-git
(https://github.com/isomorphic-git/isomorphic-git), Copyright (c) 2017
William Hilton, MIT License. The code here is an independent reimplementation,
not a fork; no isomorphic-git source files are copied. The original project's
documentation of git internals (statusMatrix walker model, index parsing,
loose object format) informed the design of this module.

Changes from isomorphic-git's design:
- Effect-native API (Streams, tagged errors, Schema)
- Bounded global fs concurrency
- Cross-process .git/index.lock (real-git compatible)
- UNTR index extension support
- Scope limited to shadow-repo operations (no network, no packfiles)
```
